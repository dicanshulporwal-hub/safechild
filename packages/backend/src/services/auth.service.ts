import { prisma } from '../db/prisma';
import {
  ParentUser,
  UserSession,
  EmailVerificationToken,
  PasswordResetToken,
  MfaChallenge,
  SystemRole,
  UserStatus,
} from '../types/models';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { mailService } from './mail.service';
import {
  validatePasswordPolicy,
  decryptMfaSecret,
  verifyTotpToken,
  getCurrentTotpTimeStep,
  hashToken,
  generateCryptoToken,
} from '../utils/security';

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret.trim().length === 0) {
      throw new Error('FATAL SECURITY ERROR: JWT_SECRET environment variable is required in production.');
    }
    if (secret.length < 32) {
      throw new Error('FATAL SECURITY ERROR: JWT_SECRET must be at least 32 characters in production.');
    }
    return secret;
  }
  return secret || 'dev-only-safebrowse-jwt-secret-key-32chars!';
}

export interface LoginResult {
  user?: ParentUser;
  accessToken?: string;
  refreshToken?: string;
  token?: string;
  mfaRequired?: boolean;
  mfaTicket?: string;
  emailVerificationPending?: boolean;
}

export interface RegisterResult {
  user: ParentUser;
  message: string;
  activationRequired: true;
}

export interface ResendActivationResult {
  message: string;
}

export interface AdminResendActivationResult {
  success: boolean;
  message: string;
}

export interface AdminCreateParentResult {
  user: ParentUser;
  message: string;
}

// In-memory rate limiting for authentication attempts
interface RateLimitRecord {
  attempts: number;
  lockedUntil: number;
}
const authRateLimits = new Map<string, RateLimitRecord>();

export class AuthService {
  public checkRateLimit(key: string, maxAttempts: number = 5, lockDurationMs: number = 15 * 60 * 1000): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    const now = Date.now();
    const record = authRateLimits.get(key);
    if (record) {
      if (record.lockedUntil > now) {
        const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
        throw new Error(`Too many failed attempts. Rate limited for ${remainingSec}s.`);
      }
      if (record.lockedUntil <= now && record.attempts >= maxAttempts) {
        authRateLimits.delete(key);
      }
    }
  }

  public recordFailedAttempt(key: string, maxAttempts: number = 5, lockDurationMs: number = 15 * 60 * 1000): void {
    const now = Date.now();
    const record = authRateLimits.get(key) || { attempts: 0, lockedUntil: 0 };
    record.attempts += 1;
    if (record.attempts >= maxAttempts) {
      record.lockedUntil = now + lockDurationMs;
    }
    authRateLimits.set(key, record);
  }

  public clearRateLimit(key: string): void {
    authRateLimits.delete(key);
  }

  public signAccessToken(userId: string, sessionId: string, tokenVersion: number = 1): string {
    return jwt.sign(
      {
        userId,
        sessionId,
        tokenVersion,
        jti: `at_${nanoid(20)}`,
      },
      getJwtSecret(),
      {
        algorithm: 'HS256',
        issuer: 'safebrowse-auth',
        audience: 'safebrowse-client',
        expiresIn: '15m',
        subject: userId,
      }
    );
  }

  public async createSession(
    userId: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string,
    existingFamilyId?: string
  ): Promise<{ accessToken: string; refreshToken: string; session: UserSession }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true, status: true },
    });
    if (user?.status === 'DISABLED') {
      const err = new Error('This account has been disabled. Contact the administrator.');
      (err as any).code = 'ACCOUNT_DISABLED';
      throw err;
    }
    if (user?.status === 'PENDING_ACTIVATION') {
      const err = new Error('Please activate your account before signing in.');
      (err as any).code = 'ACCOUNT_ACTIVATION_REQUIRED';
      throw err;
    }
    const tokenVersion = user?.tokenVersion || 1;

    const rawRefreshToken = generateCryptoToken('rt_');
    const refreshTokenHash = hashToken(rawRefreshToken);
    const sessionId = `sess_${nanoid(16)}`;
    const sessionFamilyId = existingFamilyId || `sfam_${nanoid(16)}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const created = await prisma.userSession.create({
      data: {
        id: sessionId,
        userId,
        sessionFamilyId,
        refreshTokenHash,
        consumedTokenHashes: [],
        deviceInfo: userAgent,
        ipAddress: ipAddress || null,
        expiresAt,
        tokenVersion,
      },
    });

    const accessToken = this.signAccessToken(userId, sessionId, tokenVersion);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      session: {
        id: created.id,
        userId: created.userId,
        sessionFamilyId: created.sessionFamilyId,
        refreshTokenHash: created.refreshTokenHash,
        consumedTokenHashes: created.consumedTokenHashes,
        deviceInfo: created.deviceInfo,
        ipAddress: created.ipAddress,
        createdAt: created.createdAt.toISOString(),
        lastSeenAt: created.lastSeenAt.toISOString(),
        expiresAt: created.expiresAt.toISOString(),
        isRevoked: created.isRevoked,
        tokenVersion: created.tokenVersion,
      },
    };
  }

  public async refreshSession(
    rawRefreshToken: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      throw new Error('Refresh token is required.');
    }

    const providedHash = hashToken(rawRefreshToken);

    const result: any = await prisma.$transaction(async (tx) => {
      // Look up session matching this active refresh token hash
      let matchingSession = await tx.userSession.findFirst({
        where: { refreshTokenHash: providedHash },
      });

      let isReplayAttack = false;

      if (!matchingSession) {
        // Search consumed tokens history across sessions
        matchingSession = await tx.userSession.findFirst({
          where: { consumedTokenHashes: { has: providedHash } },
        });
        if (!matchingSession) {
          try {
            const rawMatches: any[] = await tx.$queryRaw`
              SELECT id FROM "UserSession"
              WHERE ${providedHash} = ANY("consumedTokenHashes")
              LIMIT 1
            `;
            if (rawMatches && rawMatches.length > 0) {
              matchingSession = await tx.userSession.findUnique({
                where: { id: rawMatches[0].id },
              });
            }
          } catch {}
        }
        if (matchingSession) {
          isReplayAttack = true;
        }
      }

      // Replay attack handling or invalid session
      if (!matchingSession || matchingSession.isRevoked || isReplayAttack) {
        if (matchingSession) {
          const user = await tx.user.findUnique({
            where: { id: matchingSession.userId },
          });
          if (user && user.status === 'DISABLED') {
            return {
              error: 'This account has been disabled. Contact the administrator.',
              code: 'ACCOUNT_DISABLED',
              status: 403,
            };
          }
          if (user && user.status === 'PENDING_ACTIVATION') {
            return {
              error: 'Please activate your account before signing in.',
              code: 'ACCOUNT_ACTIVATION_REQUIRED',
              status: 403,
            };
          }

          if (matchingSession.isRevoked || isReplayAttack) {
            // Revoke entire token family
            await tx.userSession.updateMany({
              where: { sessionFamilyId: matchingSession.sessionFamilyId },
              data: { isRevoked: true },
            });

            await tx.user.update({
              where: { id: matchingSession.userId },
              data: { tokenVersion: { increment: 1 } },
            });

            const fam = await tx.familyMember.findFirst({
              where: { userId: matchingSession.userId },
              include: { user: true },
            });
            if (fam) {
              await tx.familyAuditLog.create({
                data: {
                  id: `log-${nanoid(10)}`,
                  familyId: fam.familyId,
                  actorUserId: matchingSession.userId,
                  actorName: fam.user.name,
                  action: 'SESSION_REFRESH_REPLAY_ATTACK',
                  details:
                    'Security Incident: Refresh token replay attack detected. All active sessions in family revoked.',
                },
              });
            }
          }
        }
        return { error: 'Invalid, expired or revoked refresh token. Please log in again.' };
      }

      // Expiry check
      if (matchingSession.expiresAt.getTime() <= Date.now()) {
        await tx.userSession.update({
          where: { id: matchingSession.id },
          data: { isRevoked: true },
        });
        return { error: 'Refresh token has expired. Please log in again.' };
      }

      // User check
      const user = await tx.user.findUnique({
        where: { id: matchingSession.userId },
      });
      if (!user) {
        await tx.userSession.update({
          where: { id: matchingSession.id },
          data: { isRevoked: true },
        });
        return { error: 'User not found.' };
      }

      if (user.status === 'DISABLED') {
        await tx.userSession.update({
          where: { id: matchingSession.id },
          data: { isRevoked: true },
        });
        return {
          error: 'This account has been disabled. Contact the administrator.',
          code: 'ACCOUNT_DISABLED',
          status: 403,
        };
      }

      if (user.status === 'PENDING_ACTIVATION') {
        await tx.userSession.update({
          where: { id: matchingSession.id },
          data: { isRevoked: true },
        });
        return {
          error: 'Please activate your account before signing in.',
          code: 'ACCOUNT_ACTIVATION_REQUIRED',
          status: 403,
        };
      }

      // Token version consistency
      if (matchingSession.tokenVersion !== (user.tokenVersion || 1)) {
        await tx.userSession.update({
          where: { id: matchingSession.id },
          data: { isRevoked: true },
        });
        return { error: 'Session has been invalidated due to password reset or global logout.' };
      }

      // Atomic rotation: generate new token, add old hash to consumed, update session
      const newRefreshToken = generateCryptoToken('rt_');
      const newHash = hashToken(newRefreshToken);

      const updatedConsumed = Array.isArray(matchingSession.consumedTokenHashes)
        ? [...matchingSession.consumedTokenHashes, providedHash]
        : [providedHash];

      await tx.userSession.update({
        where: { id: matchingSession.id },
        data: {
          refreshTokenHash: newHash,
          consumedTokenHashes: updatedConsumed,
          lastSeenAt: new Date(),
          deviceInfo: userAgent || matchingSession.deviceInfo,
          ipAddress: ipAddress || matchingSession.ipAddress,
        },
      });

      const newAccessToken = this.signAccessToken(user.id, matchingSession.id, user.tokenVersion || 1);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    });

    if ('error' in result && (result as any).error) {
      const err = new Error((result as any).error);
      if ((result as any).code) {
        (err as any).code = (result as any).code;
      }
      throw err;
    }

    return result as { accessToken: string; refreshToken: string };
  }

  public async register(
    email: string,
    password: string,
    name: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): Promise<RegisterResult> {
    const normalizedEmail = email.toLowerCase().trim();
    validatePasswordPolicy(password, false);

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new Error('An account with this email already exists.');
    }

    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(password, salt);
    const userId = `user-${nanoid(10)}`;
    const familyId = `fam-${nanoid(10)}`;
    const rawActivationToken = generateCryptoToken('act_');
    const actTokenHash = hashToken(rawActivationToken);
    const actExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create User
      const user = await tx.user.create({
        data: {
          id: userId,
          email: normalizedEmail,
          passwordHash,
          name: name.trim(),
          systemRole: 'USER',
          status: 'PENDING_ACTIVATION',
          emailVerified: false,
          mfaEnabled: false,
          tokenVersion: 1,
        },
      });

      // 2. Create Family
      const family = await tx.family.create({
        data: {
          id: familyId,
          name: `${name.split(' ')[0]}’s Family`,
          ownerUserId: userId,
          requireMfa: false,
          approvalRule: 'OWNER_OR_PARENT',
        },
      });

      // 3. Create Owner Membership
      await tx.familyMember.create({
        data: {
          id: `fm-${nanoid(10)}`,
          familyId: family.id,
          userId: user.id,
          role: 'OWNER',
        },
      });

      // 4. Create Account Activation Token
      await tx.accountActivationToken.create({
        data: {
          id: `act-${nanoid(10)}`,
          userId: user.id,
          tokenHash: actTokenHash,
          source: 'SELF_REGISTRATION',
          expiresAt: actExpiresAt,
        },
      });

      // 5. Audit Log
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: family.id,
          actorUserId: user.id,
          actorName: user.name,
          action: 'ACCOUNT_REGISTERED_PENDING_ACTIVATION',
          details: 'Parent registered account; pending email activation.',
        },
      });

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'ACCOUNT_REGISTERED_PENDING_ACTIVATION',
          details: `User ${user.email} (${user.id}) registered account; pending email activation.`,
          ipAddress: ipAddress || null,
        },
      });

      return user;
    });

    await mailService.sendAccountActivationEmail(result.email, result.name, rawActivationToken, true);

    const domainUser: ParentUser = {
      id: result.id,
      email: result.email,
      name: result.name,
      passwordHash: result.passwordHash,
      systemRole: result.systemRole as SystemRole,
      status: result.status as UserStatus,
      activatedAt: null,
      disabledAt: null,
      disabledReason: null,
      disabledByUserId: null,
      emailVerified: result.emailVerified,
      mfaEnabled: result.mfaEnabled,
      tokenVersion: result.tokenVersion,
      createdAt: result.createdAt.toISOString(),
    };

    return {
      user: domainUser,
      message: 'Registration successful. Please check your email to activate your account.',
      activationRequired: true,
    };
  }

  public async login(
    email: string,
    password: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): Promise<LoginResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `login:${normalizedEmail}:${ipAddress || 'unknown'}`;
    this.checkRateLimit(rateLimitKey, 5, 15 * 60 * 1000);

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      this.recordFailedAttempt(rateLimitKey, 5, 15 * 60 * 1000);
      throw new Error('Invalid email or password.');
    }

    if (user.status === 'DISABLED') {
      const err = new Error('This account has been disabled. Contact the administrator.');
      (err as any).code = 'ACCOUNT_DISABLED';
      throw err;
    }

    if (user.status === 'PENDING_ACTIVATION') {
      const err = new Error('Please activate your account before signing in.');
      (err as any).code = 'ACCOUNT_ACTIVATION_REQUIRED';
      throw err;
    }

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      this.recordFailedAttempt(rateLimitKey, 5, 15 * 60 * 1000);
      const membership = await prisma.familyMember.findFirst({
        where: { userId: user.id },
      });
      if (membership) {
        await prisma.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: membership.familyId,
            actorUserId: user.id,
            actorName: user.name,
            action: 'LOGIN_FAILED',
            details: 'Failed login attempt: invalid password.',
          },
        });
      }
      throw new Error('Invalid email or password.');
    }

    this.clearRateLimit(rateLimitKey);

    // If MFA is enabled, issue challenge ticket
    if (user.mfaEnabled) {
      const ticketId = `ticket_${nanoid(20)}`;
      const jti = `mfa_${nanoid(24)}`;
      const mfaTicket = jwt.sign(
        {
          userId: user.id,
          purpose: 'mfa_challenge',
          ticketId,
          jti,
        },
        getJwtSecret(),
        {
          algorithm: 'HS256',
          issuer: 'safebrowse-auth',
          audience: 'safebrowse-mfa',
          expiresIn: '5m',
        }
      );

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await prisma.mfaChallenge.create({
        data: {
          id: ticketId,
          userId: user.id,
          jtiHash: hashToken(jti),
          purpose: 'mfa_login',
          expiresAt,
          attemptCount: 0,
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
        },
      });

      return {
        mfaRequired: true,
        mfaTicket,
      };
    }

    // MFA not enabled: create session
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { accessToken, refreshToken } = await this.createSession(user.id, userAgent, ipAddress);

    const membership = await prisma.familyMember.findFirst({
      where: { userId: user.id },
    });
    if (membership) {
      await prisma.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: membership.familyId,
          actorUserId: user.id,
          actorName: user.name,
          action: 'LOGIN_SUCCESS',
          details: `User logged in from ${userAgent}.`,
        },
      });
    }

    const domainUser: ParentUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      systemRole: user.systemRole as SystemRole,
      status: user.status as UserStatus,
      disabledAt: user.disabledAt ? user.disabledAt.toISOString() : null,
      disabledReason: user.disabledReason,
      disabledByUserId: user.disabledByUserId,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      tokenVersion: user.tokenVersion,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: new Date().toISOString(),
    };

    return {
      user: domainUser,
      accessToken,
      refreshToken,
      token: accessToken,
      emailVerificationPending: !user.emailVerified,
    };
  }

  public async verifyMfaLogin(
    mfaTicket: string,
    codeOrRecoveryCode: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string,
    timeSec?: number
  ): Promise<LoginResult> {
    if (!mfaTicket || !codeOrRecoveryCode) {
      throw new Error('MFA challenge ticket and verification code are required.');
    }

    let decoded: any;
    try {
      decoded = jwt.verify(mfaTicket, getJwtSecret(), {
        algorithms: ['HS256'],
        issuer: 'safebrowse-auth',
        audience: 'safebrowse-mfa',
      });
    } catch {
      throw new Error('MFA challenge session has expired or is invalid. Please sign in again.');
    }

    if (!decoded.ticketId || typeof decoded.ticketId !== 'string' || decoded.ticketId.trim() === '') {
      throw new Error('Invalid MFA challenge ticket: missing ticketId.');
    }
    if (!decoded.jti || typeof decoded.jti !== 'string' || decoded.jti.trim() === '') {
      throw new Error('Invalid MFA challenge ticket: missing jti.');
    }
    if (decoded.purpose !== 'mfa_challenge') {
      throw new Error('Invalid MFA challenge ticket: purpose must be mfa_challenge.');
    }

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: decoded.userId },
      });
      if (!user) {
        throw new Error('User account not found.');
      }
      if (user.status === 'DISABLED') {
        const err = new Error('This account has been disabled. Contact the administrator.');
        (err as any).code = 'ACCOUNT_DISABLED';
        throw err;
      }
      if (user.status === 'PENDING_ACTIVATION') {
        const err = new Error('Please activate your account before signing in.');
        (err as any).code = 'ACCOUNT_ACTIVATION_REQUIRED';
        throw err;
      }
      if (!user.mfaSecret) {
        throw new Error('MFA configuration not found for this account.');
      }

      const challenge = await tx.mfaChallenge.findUnique({
        where: { id: decoded.ticketId },
      });

      if (!challenge) {
        throw new Error('MFA challenge not found or expired. Please sign in again.');
      }
      if (challenge.consumedAt) {
        throw new Error('MFA challenge ticket has already been used. Please sign in again.');
      }
      if (challenge.invalidatedAt) {
        throw new Error('MFA challenge has been invalidated. Please sign in again.');
      }
      if (challenge.expiresAt.getTime() <= Date.now()) {
        throw new Error('MFA challenge has expired. Please sign in again.');
      }
      if (challenge.userId !== decoded.userId) {
        throw new Error('MFA challenge user mismatch.');
      }
      if (challenge.purpose !== 'mfa_login') {
        throw new Error('MFA challenge purpose mismatch: must be mfa_login.');
      }

      const MAX_MFA_ATTEMPTS = 5;
      if (challenge.attemptCount >= MAX_MFA_ATTEMPTS) {
        await tx.mfaChallenge.update({
          where: { id: challenge.id },
          data: { invalidatedAt: new Date() },
        });
        throw new Error('Too many failed MFA attempts. Please sign in again.');
      }

      if (hashToken(decoded.jti) !== challenge.jtiHash) {
        await tx.mfaChallenge.update({
          where: { id: challenge.id },
          data: { attemptCount: { increment: 1 } },
        });
        throw new Error('MFA challenge integrity check failed.');
      }

      const cleanInput = codeOrRecoveryCode.trim().toUpperCase();
      const decryptedSecret = decryptMfaSecret(user.mfaSecret);

      const totpResult = verifyTotpToken(decryptedSecret, cleanInput, timeSec);
      const isTotpValid = totpResult.valid && totpResult.acceptedTimeStep !== undefined;

      let isRecoveryValid = false;
      let matchedRecoveryIndex = -1;

      if (!isTotpValid && user.mfaRecoveryCodes && user.mfaRecoveryCodes.length > 0) {
        for (let i = 0; i < user.mfaRecoveryCodes.length; i++) {
          if (bcrypt.compareSync(cleanInput, user.mfaRecoveryCodes[i])) {
            isRecoveryValid = true;
            matchedRecoveryIndex = i;
            break;
          }
        }
      }

      if (!isTotpValid && !isRecoveryValid) {
        await tx.mfaChallenge.update({
          where: { id: challenge.id },
          data: { attemptCount: { increment: 1 } },
        });
        throw new Error('Invalid MFA verification code or recovery code.');
      }

      const userTotpSteps = (user.totpLastUsedSteps as any) ? { ...(user.totpLastUsedSteps as any) } : {};

      if (isTotpValid) {
        const acceptedStep = totpResult.acceptedTimeStep!;
        const lastUsedStep = userTotpSteps['mfa_login'];
        if (lastUsedStep !== undefined && lastUsedStep === acceptedStep) {
          await tx.mfaChallenge.update({
            where: { id: challenge.id },
            data: { attemptCount: { increment: 1 } },
          });
          throw new Error('This TOTP code has already been used. Please wait for the next code.');
        }
        userTotpSteps['mfa_login'] = acceptedStep;
      }

      // Consume challenge
      await tx.mfaChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });

      // Update user credentials
      const updatedRecoveryCodes = [...user.mfaRecoveryCodes];
      if (isRecoveryValid && matchedRecoveryIndex >= 0) {
        updatedRecoveryCodes.splice(matchedRecoveryIndex, 1);
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaRecoveryCodes: updatedRecoveryCodes,
          totpLastUsedSteps: userTotpSteps,
          lastLoginAt: new Date(),
        },
      });

      // Audit log
      const fam = await tx.familyMember.findFirst({
        where: { userId: user.id },
      });
      if (fam) {
        const auditAction = isRecoveryValid ? 'MFA_RECOVERY_CODE_USED' : 'LOGIN_SUCCESS';
        const details = isRecoveryValid
          ? `Logged in using one-time recovery code during MFA challenge. ${updatedRecoveryCodes.length} recovery codes remaining.`
          : `User completed MFA authentication from ${userAgent}.`;

        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: user.id,
            actorName: user.name,
            action: auditAction,
            details,
          },
        });
      }

      // Create session
      const rawRefreshToken = generateCryptoToken('rt_');
      const refreshTokenHash = hashToken(rawRefreshToken);
      const sessionId = `sess_${nanoid(16)}`;
      const sessionFamilyId = `sfam_${nanoid(16)}`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await tx.userSession.create({
        data: {
          id: sessionId,
          userId: user.id,
          sessionFamilyId,
          refreshTokenHash,
          consumedTokenHashes: [],
          deviceInfo: userAgent,
          ipAddress: ipAddress || null,
          expiresAt,
          tokenVersion: user.tokenVersion,
        },
      });

      const accessToken = this.signAccessToken(user.id, sessionId, user.tokenVersion);

      const domainUser: ParentUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        systemRole: user.systemRole as SystemRole,
        status: user.status as UserStatus,
        disabledAt: user.disabledAt ? user.disabledAt.toISOString() : null,
        disabledReason: user.disabledReason,
        disabledByUserId: user.disabledByUserId,
        emailVerified: user.emailVerified,
        mfaEnabled: user.mfaEnabled,
        tokenVersion: user.tokenVersion,
        createdAt: user.createdAt.toISOString(),
      };

      return {
        user: domainUser,
        accessToken,
        refreshToken: rawRefreshToken,
        token: accessToken,
        emailVerificationPending: !user.emailVerified,
      };
    });
  }

  public async verifyToken(
    token: string
  ): Promise<{ userId: string; sessionId: string; tokenVersion: number; jti: string }> {
    if (!token || typeof token !== 'string') {
      throw new Error('Invalid or expired token.');
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, getJwtSecret(), {
        algorithms: ['HS256'],
        issuer: 'safebrowse-auth',
        audience: 'safebrowse-client',
      });
    } catch {
      throw new Error('Invalid or expired token.');
    }

    const userId = decoded.userId;
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Invalid token claims: userId missing or empty.');
    }

    if (!decoded.sub || typeof decoded.sub !== 'string' || decoded.sub.trim() === '') {
      throw new Error('Invalid token claims: sub missing or empty.');
    }
    if (decoded.sub !== userId) {
      throw new Error('Invalid token claims: subject mismatch.');
    }

    if (!decoded.jti || typeof decoded.jti !== 'string' || decoded.jti.trim() === '') {
      throw new Error('Invalid token claims: jti missing or empty.');
    }

    if (!decoded.sessionId || typeof decoded.sessionId !== 'string' || decoded.sessionId.trim() === '') {
      throw new Error('Invalid token claims: sessionId missing or empty.');
    }

    if (
      decoded.tokenVersion === undefined ||
      decoded.tokenVersion === null ||
      typeof decoded.tokenVersion !== 'number'
    ) {
      throw new Error('Invalid token claims: tokenVersion missing.');
    }

    // User existence, status and tokenVersion check
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true, status: true },
    });

    if (!user) {
      throw new Error('User account not found.');
    }
    if (user.status === 'DISABLED') {
      const err = new Error('This account has been disabled. Contact the administrator.');
      (err as any).code = 'ACCOUNT_DISABLED';
      throw err;
    }
    if (user.status === 'PENDING_ACTIVATION') {
      const err = new Error('Please activate your account before signing in.');
      (err as any).code = 'ACCOUNT_ACTIVATION_REQUIRED';
      throw err;
    }

    // Session validation against PostgreSQL
    const session = await prisma.userSession.findUnique({
      where: { id: decoded.sessionId },
    });

    if (!session) {
      throw new Error('Session does not exist.');
    }
    if (session.userId !== userId) {
      throw new Error('Session ownership mismatch.');
    }
    if (session.isRevoked) {
      throw new Error('Session has been revoked.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new Error('Session has expired.');
    }
    if (session.tokenVersion !== decoded.tokenVersion) {
      throw new Error('Session has been invalidated. Please sign in again.');
    }
    if (decoded.tokenVersion !== (user.tokenVersion || 1)) {
      throw new Error('Token has been invalidated. Please sign in again.');
    }

    return {
      userId,
      sessionId: decoded.sessionId,
      tokenVersion: decoded.tokenVersion,
      jti: decoded.jti,
    };
  }

  public async verifyEmail(rawToken: string): Promise<{ success: boolean; message: string }> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('Verification token is required.');
    }

    const tokenHash = hashToken(rawToken);

    return prisma.$transaction(async (tx) => {
      const record = await tx.emailVerificationToken.findUnique({
        where: { tokenHash },
      });

      if (!record || record.usedAt) {
        throw new Error('Invalid, consumed or expired email verification token.');
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        throw new Error('Email verification token has expired. Please request a new verification link.');
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerified: true },
      });

      await tx.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });

      const fam = await tx.familyMember.findFirst({
        where: { userId: record.userId },
        include: { user: true },
      });

      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: record.userId,
            actorName: fam.user.name,
            action: 'EMAIL_VERIFIED',
            details: 'Parent email address was verified.',
          },
        });
      }

      return {
        success: true,
        message: 'Email address successfully verified.',
      };
    });
  }

  public async resendEmailVerification(email: string): Promise<{ token?: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `resend-ev:${normalizedEmail}`;
    this.checkRateLimit(rateLimitKey, 3, 5 * 60 * 1000);

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user || user.emailVerified) {
      return {};
    }

    const rawEvToken = generateCryptoToken('ev_');
    const evExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Invalidate existing unused verification tokens
      await tx.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.emailVerificationToken.create({
        data: {
          id: `evt-${nanoid(10)}`,
          userId: user.id,
          email: user.email,
          tokenHash: hashToken(rawEvToken),
          expiresAt: evExpiresAt,
        },
      });
    });

    mailService.sendVerificationEmail(user.email, rawEvToken);

    return {
      token: process.env.NODE_ENV !== 'production' ? rawEvToken : undefined,
    };
  }

  public async verifyActivationToken(rawToken: string): Promise<{
    valid: boolean;
    reason?: string;
    email?: string;
    name?: string;
    source?: string;
    requiresPassword?: boolean;
  }> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim() === '') {
      return { valid: false, reason: 'Activation token is required.' };
    }

    const tokenHash = hashToken(rawToken);
    const record = await prisma.accountActivationToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.usedAt) {
      return { valid: false, reason: 'Invalid or already used activation link.' };
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: 'Activation link has expired. Please request a new activation link.' };
    }

    if (!record.user) {
      return { valid: false, reason: 'Associated user account was not found.' };
    }

    if (record.user.status === 'DISABLED') {
      return { valid: false, reason: 'This account has been disabled. Contact the administrator.' };
    }

    if (record.user.status === 'ACTIVE') {
      return { valid: false, reason: 'This account has already been activated. Please sign in.' };
    }

    return {
      valid: true,
      email: record.user.email,
      name: record.user.name,
      source: record.source,
      requiresPassword: record.source !== 'SELF_REGISTRATION',
    };
  }

  public async activateAccount(
    rawToken: string,
    password?: string,
    ipAddress?: string
  ): Promise<{ success: boolean; message: string; email: string }> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim() === '') {
      throw new Error('Activation token is required.');
    }

    const tokenHash = hashToken(rawToken);

    return prisma.$transaction(async (tx) => {
      const record = await tx.accountActivationToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!record || record.usedAt) {
        throw new Error('Invalid or already used activation link.');
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        throw new Error('Activation link has expired. Please request a new activation link.');
      }

      const user = record.user;
      if (!user) {
        throw new Error('Associated user account was not found.');
      }

      if (user.status === 'DISABLED') {
        const err = new Error('This account has been disabled. Contact the administrator.');
        (err as any).code = 'ACCOUNT_DISABLED';
        throw err;
      }

      if (user.status === 'ACTIVE') {
        throw new Error('This account has already been activated. Please sign in.');
      }

      const requiresPassword = record.source !== 'SELF_REGISTRATION';
      let newPasswordHash = user.passwordHash;

      if (requiresPassword) {
        if (!password || typeof password !== 'string' || password.trim() === '') {
          throw new Error('Password is required to activate your account.');
        }
        validatePasswordPolicy(password, false);
        const salt = bcrypt.genSaltSync(12);
        newPasswordHash = bcrypt.hashSync(password, salt);
      } else if (password && password.trim() !== '') {
        validatePasswordPolicy(password, false);
        const salt = bcrypt.genSaltSync(12);
        newPasswordHash = bcrypt.hashSync(password, salt);
      }

      const now = new Date();

      // Activate User
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newPasswordHash,
          status: 'ACTIVE',
          activatedAt: now,
          emailVerified: true,
          tokenVersion: { increment: 1 },
        },
      });

      // Mark token as used
      await tx.accountActivationToken.update({
        where: { id: record.id },
        data: {
          usedAt: now,
        },
      });

      // Invalidate any other unused activation tokens for this user
      await tx.accountActivationToken.updateMany({
        where: {
          userId: user.id,
          id: { not: record.id },
          usedAt: null,
        },
        data: { usedAt: now },
      });

      // Audit logs
      const fam = await tx.familyMember.findFirst({
        where: { userId: user.id },
      });
      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: user.id,
            actorName: user.name,
            action: 'ACCOUNT_ACTIVATED',
            details: `Parent account activated via email link (source: ${record.source}).`,
          },
        });
      }

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'ACCOUNT_ACTIVATED',
          details: `Parent account ${user.email} (${user.id}) activated (source: ${record.source}).`,
          ipAddress: ipAddress || null,
        },
      });

      return {
        success: true,
        message: 'Account successfully activated. You may now sign in.',
        email: user.email,
      };
    });
  }

  public async resendActivationEmail(
    email: string,
    ipAddress?: string
  ): Promise<ResendActivationResult> {
    const normalizedEmail = (email || '').toLowerCase().trim();
    const rateLimitKey = `resend-act:${normalizedEmail}:${ipAddress || 'unknown'}`;
    this.checkRateLimit(rateLimitKey, 3, 5 * 60 * 1000);

    const genericMsg = 'If an unactivated account exists for this email, an activation link has been sent.';

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || user.status !== 'PENDING_ACTIVATION') {
      return { message: genericMsg };
    }

    const rawActivationToken = generateCryptoToken('act_');
    const actTokenHash = hashToken(rawActivationToken);
    const actExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Invalidate existing unused tokens
      await tx.accountActivationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.accountActivationToken.create({
        data: {
          id: `act-${nanoid(10)}`,
          userId: user.id,
          tokenHash: actTokenHash,
          source: 'SELF_REGISTRATION',
          expiresAt: actExpiresAt,
        },
      });

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'RESEND_ACTIVATION_EMAIL',
          details: `User requested resending activation email for ${user.email}.`,
          ipAddress: ipAddress || null,
        },
      });
    });

    await mailService.sendAccountActivationEmail(user.email, user.name, rawActivationToken, true);

    return {
      message: genericMsg,
    };
  }

  public async adminResendActivation(
    actorUserId: string,
    targetUserId: string,
    ipAddress?: string
  ): Promise<AdminResendActivationResult> {
    const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
    if (!actor || actor.systemRole !== 'SYSTEM_ADMIN') {
      throw new Error('Unauthorized: only SYSTEM_ADMIN can resend activation emails.');
    }

    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) {
      throw new Error('Parent user not found.');
    }

    if (targetUser.status !== 'PENDING_ACTIVATION') {
      throw new Error(`Account cannot be activated because its status is ${targetUser.status}.`);
    }

    const rawActivationToken = generateCryptoToken('act_');
    const actTokenHash = hashToken(rawActivationToken);
    const actExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      await tx.accountActivationToken.updateMany({
        where: { userId: targetUser.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.accountActivationToken.create({
        data: {
          id: `act-${nanoid(10)}`,
          userId: targetUser.id,
          tokenHash: actTokenHash,
          source: 'ADMIN_REGENERATED',
          expiresAt: actExpiresAt,
        },
      });

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId,
          actorEmail: actor.email,
          action: 'ADMIN_RESEND_ACTIVATION',
          details: `Admin resent activation email for ${targetUser.email} (${targetUser.id}).`,
          ipAddress: ipAddress || null,
        },
      });
    });

    await mailService.sendAccountActivationEmail(targetUser.email, targetUser.name, rawActivationToken, false);

    return {
      success: true,
      message: `Activation email resent successfully to ${targetUser.email}.`,
    };
  }

  public async adminCreateParent(
    actorUserId: string,
    name: string,
    email: string,
    ipAddress?: string
  ): Promise<AdminCreateParentResult> {
    const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
    if (!actor || actor.systemRole !== 'SYSTEM_ADMIN') {
      throw new Error('Unauthorized: only SYSTEM_ADMIN can create parent accounts.');
    }

    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').toLowerCase().trim();

    if (!cleanName || cleanName.length < 2) {
      throw new Error('A valid name with at least 2 characters is required.');
    }

    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      throw new Error('A valid email address is required.');
    }

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      throw new Error('An account with this email address already exists.');
    }

    const userId = `usr-${nanoid(10)}`;
    const familyId = `fam-${nanoid(10)}`;
    const placeholderPassword = crypto.randomBytes(32).toString('hex');
    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(placeholderPassword, salt);

    const rawActivationToken = generateCryptoToken('act_');
    const actTokenHash = hashToken(rawActivationToken);
    const actExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const createdUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          email: cleanEmail,
          name: cleanName,
          passwordHash,
          systemRole: 'USER',
          status: 'PENDING_ACTIVATION',
          emailVerified: false,
          activatedAt: null,
          tokenVersion: 1,
        },
      });

      const family = await tx.family.create({
        data: {
          id: familyId,
          name: `${cleanName.split(' ')[0]}’s Family`,
          ownerUserId: userId,
          requireMfa: false,
          approvalRule: 'OWNER_OR_PARENT',
        },
      });

      await tx.familyMember.create({
        data: {
          id: `fm-${nanoid(10)}`,
          familyId: family.id,
          userId: user.id,
          role: 'OWNER',
        },
      });

      await tx.accountActivationToken.create({
        data: {
          id: `act-${nanoid(10)}`,
          userId: user.id,
          tokenHash: actTokenHash,
          source: 'ADMIN_CREATED',
          expiresAt: actExpiresAt,
        },
      });

      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: family.id,
          actorUserId: actor.id,
          actorName: actor.name,
          action: 'ADMIN_CREATED_PARENT',
          details: `Admin ${actor.email} created parent account ${cleanEmail} pending email activation.`,
        },
      });

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: 'ADMIN_CREATED_PARENT',
          details: `Admin created parent ${cleanEmail} (${user.id}) pending email activation.`,
          ipAddress: ipAddress || null,
        },
      });

      return user;
    });

    await mailService.sendAccountActivationEmail(cleanEmail, cleanName, rawActivationToken, false);

    const domainUser: ParentUser = {
      id: createdUser.id,
      email: createdUser.email,
      name: createdUser.name,
      passwordHash: createdUser.passwordHash,
      systemRole: createdUser.systemRole as SystemRole,
      status: createdUser.status as UserStatus,
      activatedAt: null,
      disabledAt: null,
      disabledReason: null,
      disabledByUserId: null,
      emailVerified: createdUser.emailVerified,
      mfaEnabled: createdUser.mfaEnabled,
      tokenVersion: createdUser.tokenVersion,
      createdAt: createdUser.createdAt.toISOString(),
    };

    return {
      user: domainUser,
      message: 'Parent account created successfully. Activation email sent.',
    };
  }

  public async requestPasswordReset(email: string): Promise<{ message: string; resetToken?: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `forgot-pwd:${normalizedEmail}`;
    this.checkRateLimit(rateLimitKey, 3, 10 * 60 * 1000);

    const genericMsg = 'If an account exists with this email address, password reset instructions have been sent.';

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      return { message: genericMsg };
    }

    const rawResetToken = generateCryptoToken('pr_');
    const resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Invalidate existing active tokens
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.passwordResetToken.create({
        data: {
          id: `prt-${nanoid(10)}`,
          userId: user.id,
          email: user.email,
          tokenHash: hashToken(rawResetToken),
          expiresAt: resetExpiresAt,
        },
      });
    });

    mailService.sendPasswordResetEmail(user.email, rawResetToken);

    return {
      message: genericMsg,
      resetToken: process.env.NODE_ENV !== 'production' ? rawResetToken : undefined,
    };
  }

  public async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('Reset token is required.');
    }

    const tokenHash = hashToken(rawToken);

    return prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      if (!record || record.usedAt) {
        throw new Error('Invalid, expired or already used password reset link.');
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        throw new Error('Password reset link has expired. Please request a new one.');
      }

      const user = await tx.user.findUnique({
        where: { id: record.userId },
      });
      if (!user) throw new Error('User not found.');

      validatePasswordPolicy(newPassword, Boolean(user.mfaEnabled));

      const salt = bcrypt.genSaltSync(12);
      const newHash = bcrypt.hashSync(newPassword, salt);

      // Invalidate prior access tokens and update hash
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          tokenVersion: { increment: 1 },
        },
      });

      // Mark token used
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });

      // Revoke all active sessions
      await tx.userSession.updateMany({
        where: { userId: user.id },
        data: { isRevoked: true },
      });

      // Invalidate outstanding MFA challenges
      await tx.mfaChallenge.updateMany({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });

      const fam = await tx.familyMember.findFirst({
        where: { userId: user.id },
      });
      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: user.id,
            actorName: user.name,
            action: 'PASSWORD_RESET',
            details: 'Account password was reset via email verification link. All prior sessions revoked.',
          },
        });
      }
    });
  }

  public async getUser(userId: string): Promise<ParentUser | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      systemRole: user.systemRole as SystemRole,
      status: user.status as any,
      activatedAt: user.activatedAt ? user.activatedAt.toISOString() : undefined,
      disabledAt: user.disabledAt ? user.disabledAt.toISOString() : undefined,
      disabledReason: user.disabledReason,
      disabledByUserId: user.disabledByUserId,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      mfaSecret: user.mfaSecret,
      mfaRecoveryCodes: user.mfaRecoveryCodes,
      totpLastUsedSteps: user.totpLastUsedSteps as any,
      tokenVersion: user.tokenVersion,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : undefined,
    };
  }
}

export const authService = new AuthService();
