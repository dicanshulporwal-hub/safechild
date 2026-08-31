import { db, ParentUser, UserSession, EmailVerificationToken, PasswordResetToken, MfaChallenge } from '../db/store';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { familyService } from './family.service';
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
  token?: string; // Backwards compatibility for existing clients
  mfaRequired?: boolean;
  mfaTicket?: string;
  emailVerificationPending?: boolean;
}

// In-memory rate limiting for authentication attempts
interface RateLimitRecord {
  attempts: number;
  lockedUntil: number;
}
const authRateLimits = new Map<string, RateLimitRecord>();

// NOTE: MFA challenge replay protection is now persisted in db.mfaChallenges (see store.ts).
// The previous process-local consumedMfaTickets Set has been removed.
// This means MFA challenge state survives server restarts.

export class AuthService {
  /**
   * Check and increment rate limit for a given key
   */
  public checkRateLimit(key: string, maxAttempts: number = 5, lockDurationMs: number = 15 * 60 * 1000): void {
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

  /**
   * Sign short-lived Access Token (15 minutes) with HS256 and strict claims.
   * Includes jti (unique token ID), sub, sessionId, tokenVersion, issuer, audience.
   */
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

  /**
   * Create an authenticated session with rotating refresh token
   */
  public createSession(
    userId: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string,
    existingFamilyId?: string
  ): { accessToken: string; refreshToken: string; session: UserSession } {
    const user = db.users.get(userId);
    const tokenVersion = user?.tokenVersion || 1;

    const rawRefreshToken = generateCryptoToken('rt_');
    const refreshTokenHash = hashToken(rawRefreshToken);
    const sessionId = `sess_${nanoid(16)}`;
    const sessionFamilyId = existingFamilyId || `sfam_${nanoid(16)}`;

    const session: UserSession = {
      id: sessionId,
      userId,
      sessionFamilyId,
      refreshTokenHash,
      consumedTokenHashes: [],
      deviceInfo: userAgent,
      ipAddress,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      isRevoked: false,
      tokenVersion,
    };

    db.userSessions.set(sessionId, session);
    db.save();

    const accessToken = this.signAccessToken(userId, sessionId, tokenVersion);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      session,
    };
  }

  /**
   * Refresh session with atomic single-use refresh-token rotation and replay attack mitigation
   */
  public refreshSession(
    rawRefreshToken: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): { accessToken: string; refreshToken: string } {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      throw new Error('Refresh token is required.');
    }

    const providedHash = hashToken(rawRefreshToken);

    // Look up session matching this refresh token hash or search consumed tokens for replay attack
    let matchingSession: UserSession | undefined;
    let isReplayAttack = false;

    for (const session of db.userSessions.values()) {
      if (session.refreshTokenHash === providedHash) {
        matchingSession = session;
        break;
      }
      if (session.consumedTokenHashes && session.consumedTokenHashes.includes(providedHash)) {
        matchingSession = session;
        isReplayAttack = true;
        break;
      }
    }

    // REPLAY ATTACK DETECTION:
    // If not found, if already revoked, or if a consumed token was presented:
    if (!matchingSession || matchingSession.isRevoked || isReplayAttack) {
      if (matchingSession && (matchingSession.isRevoked || isReplayAttack)) {
        // A consumed or revoked token was replayed -> revoke entire token family
        const familyId = matchingSession.sessionFamilyId;
        if (familyId) {
          for (const s of db.userSessions.values()) {
            if (s.sessionFamilyId === familyId) {
              s.isRevoked = true;
              db.userSessions.set(s.id, s);
            }
          }
        } else {
          matchingSession.isRevoked = true;
          db.userSessions.set(matchingSession.id, matchingSession);
        }
        const user = db.users.get(matchingSession.userId);
        if (user) {
          user.tokenVersion = (user.tokenVersion || 1) + 1;
          const family = familyService.getOrCreateUserFamily(user.id);
          familyService.logAudit(
            family.id,
            user.id,
            user.name,
            'SESSION_REFRESH_REPLAY_ATTACK',
            `Security Incident: Refresh token replay attack detected. All active sessions in family revoked.`
          );
        }
        db.save();
      }
      throw new Error('Invalid, expired or revoked refresh token. Please log in again.');
    }

    // Check expiry
    if (new Date(matchingSession.expiresAt).getTime() <= Date.now()) {
      matchingSession.isRevoked = true;
      db.save();
      throw new Error('Refresh token has expired. Please log in again.');
    }

    // Verify user existence and active status
    const user = db.users.get(matchingSession.userId);
    if (!user) {
      matchingSession.isRevoked = true;
      db.save();
      throw new Error('User not found.');
    }

    // Check token version consistency
    if (matchingSession.tokenVersion !== (user.tokenVersion || 1)) {
      matchingSession.isRevoked = true;
      db.save();
      throw new Error('Session has been invalidated due to password reset or global logout.');
    }

    // Record consumed token in rotation history
    matchingSession.consumedTokenHashes = matchingSession.consumedTokenHashes || [];
    matchingSession.consumedTokenHashes.push(providedHash);

    // ATOMIC ROTATION: Generate new refresh token, update hash, invalidate previous token immediately
    const newRefreshToken = generateCryptoToken('rt_');
    matchingSession.refreshTokenHash = hashToken(newRefreshToken);
    matchingSession.lastSeenAt = new Date().toISOString();
    if (userAgent) matchingSession.deviceInfo = userAgent;
    if (ipAddress) matchingSession.ipAddress = ipAddress;

    db.userSessions.set(matchingSession.id, matchingSession);
    db.save();

    const newAccessToken = this.signAccessToken(user.id, matchingSession.id, user.tokenVersion || 1);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * Register a new parent account
   */
  public register(
    email: string,
    password: string,
    name: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): { user: ParentUser; accessToken: string; refreshToken: string; token: string; emailVerificationToken: string } {
    const normalizedEmail = email.toLowerCase().trim();

    // Enforce Password Policy (NIST 800-63B standard)
    validatePasswordPolicy(password, false);

    const existing = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedEmail);
    if (existing) {
      throw new Error('An account with this email already exists.');
    }

    // Cryptographic Bcrypt Hash with 12 salt rounds
    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(password, salt);

    const user: ParentUser = {
      id: `user-${nanoid(10)}`,
      email: normalizedEmail,
      passwordHash,
      name: name.trim(),
      emailVerified: false,
      mfaEnabled: false,
      tokenVersion: 1,
      createdAt: new Date().toISOString(),
    };

    db.users.set(user.id, user);

    // Automatically create and link primary family with OWNER role
    familyService.getOrCreateUserFamily(user.id);

    // Issue cryptographic single-use Email Verification Token
    const rawEvToken = generateCryptoToken('ev_');
    const evTokenRecord: EmailVerificationToken = {
      id: `evt-${nanoid(10)}`,
      userId: user.id,
      email: normalizedEmail,
      tokenHash: hashToken(rawEvToken),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    db.emailVerificationTokens.set(evTokenRecord.id, evTokenRecord);
    db.save();

    // Dispatch verification email via mail provider (captures in dev outbox, throws if provider missing in prod)
    mailService.sendVerificationEmail(user.email, rawEvToken);

    // Create session
    const { accessToken, refreshToken } = this.createSession(user.id, userAgent, ipAddress);

    return {
      user,
      accessToken,
      refreshToken,
      token: accessToken,
      emailVerificationToken: rawEvToken,
    };
  }

  /**
   * Primary Login endpoint:
   * If MFA is enabled, returns single-use MFA challenge ticket.
   * If MFA is not enabled, issues authenticated session tokens.
   */
  public login(
    email: string,
    password: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): LoginResult {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `login:${normalizedEmail}:${ipAddress || 'unknown'}`;

    this.checkRateLimit(rateLimitKey, 5, 15 * 60 * 1000);

    const user = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      this.recordFailedAttempt(rateLimitKey, 5, 15 * 60 * 1000);
      throw new Error('Invalid email or password.');
    }

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      this.recordFailedAttempt(rateLimitKey, 5, 15 * 60 * 1000);
      const family = familyService.getOrCreateUserFamily(user.id);
      familyService.logAudit(family.id, user.id, user.name, 'LOGIN_FAILED', 'Failed login attempt: invalid password.');
      throw new Error('Invalid email or password.');
    }

    this.clearRateLimit(rateLimitKey);

    // If MFA is enabled, issue short-lived single-use MFA challenge ticket (5 minutes)
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

      // Create persisted MFA challenge record (survives restart — replaces in-memory Set)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const challenge: MfaChallenge = {
        id: ticketId,
        userId: user.id,
        jtiHash: hashToken(jti),
        purpose: 'mfa_login',
        createdAt: new Date().toISOString(),
        expiresAt,
        attemptCount: 0,
        ipAddress,
        userAgent,
      };
      db.mfaChallenges.set(ticketId, challenge);
      db.save();

      return {
        mfaRequired: true,
        mfaTicket,
      };
    }

    // MFA is not enabled: create session & issue tokens
    user.lastLoginAt = new Date().toISOString();
    db.users.set(user.id, user);

    const { accessToken, refreshToken } = this.createSession(user.id, userAgent, ipAddress);

    const family = familyService.getOrCreateUserFamily(user.id);
    familyService.logAudit(family.id, user.id, user.name, 'LOGIN_SUCCESS', `User logged in from ${userAgent}.`);

    return {
      user,
      accessToken,
      refreshToken,
      token: accessToken,
      emailVerificationPending: !user.emailVerified,
    };
  }

  /**
   * Complete MFA Login Challenge using 6-digit TOTP or single-use recovery code.
   * Uses persisted MfaChallenge records — replay protection survives server restarts.
   */
  public verifyMfaLogin(
    mfaTicket: string,
    codeOrRecoveryCode: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string,
    timeSec?: number
  ): LoginResult {
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

    // Mandatory ticket claims
    if (!decoded.ticketId || typeof decoded.ticketId !== 'string' || decoded.ticketId.trim() === '') {
      throw new Error('Invalid MFA challenge ticket: missing ticketId.');
    }
    if (!decoded.jti || typeof decoded.jti !== 'string' || decoded.jti.trim() === '') {
      throw new Error('Invalid MFA challenge ticket: missing jti.');
    }
    if (decoded.purpose !== 'mfa_challenge') {
      throw new Error('Invalid MFA challenge ticket: purpose must be mfa_challenge.');
    }

    // Look up persisted challenge record
    const challenge = db.mfaChallenges.get(decoded.ticketId);
    if (!challenge) {
      throw new Error('MFA challenge not found or expired. Please sign in again.');
    }

    // Validate challenge state
    if (challenge.consumedAt) {
      throw new Error('MFA challenge ticket has already been used. Please sign in again.');
    }
    if (challenge.invalidatedAt) {
      throw new Error('MFA challenge has been invalidated. Please sign in again.');
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      throw new Error('MFA challenge has expired. Please sign in again.');
    }
    if (challenge.userId !== decoded.userId) {
      throw new Error('MFA challenge user mismatch.');
    }
    if (challenge.purpose !== 'mfa_login') {
      throw new Error('MFA challenge purpose mismatch: must be mfa_login.');
    }

    // Enforce maximum verification attempts (5) to prevent brute-force
    const MAX_MFA_ATTEMPTS = 5;
    if (challenge.attemptCount >= MAX_MFA_ATTEMPTS) {
      challenge.invalidatedAt = new Date().toISOString();
      db.mfaChallenges.set(challenge.id, challenge);
      db.save();
      throw new Error('Too many failed MFA attempts. Please sign in again.');
    }

    // Unconditional jti integrity check: ticket jti hash must strictly match challenge record
    if (hashToken(decoded.jti) !== challenge.jtiHash) {
      challenge.attemptCount += 1;
      db.mfaChallenges.set(challenge.id, challenge);
      db.save();
      throw new Error('MFA challenge integrity check failed.');
    }

    const user = db.users.get(decoded.userId);
    if (!user || !user.mfaSecret) {
      throw new Error('User or MFA configuration not found.');
    }

    const cleanInput = codeOrRecoveryCode.trim().toUpperCase();
    const decryptedSecret = decryptMfaSecret(user.mfaSecret);

    // 1. Try TOTP 6-digit code with exact accepted timestep
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
      // Increment failed attempt count and persist
      challenge.attemptCount += 1;
      db.mfaChallenges.set(challenge.id, challenge);
      db.save();
      throw new Error('Invalid MFA verification code or recovery code.');
    }

    // TOTP timestep replay check — prevent same timestep being reused for MFA login
    if (isTotpValid) {
      const acceptedStep = totpResult.acceptedTimeStep!;
      const lastUsedStep = user.totpLastUsedSteps?.['mfa_login'];
      if (lastUsedStep !== undefined && lastUsedStep === acceptedStep) {
        // Increment attempt count to prevent probing
        challenge.attemptCount += 1;
        db.mfaChallenges.set(challenge.id, challenge);
        db.save();
        throw new Error('This TOTP code has already been used. Please wait for the next code.');
      }
    }

    // ─── CONSUME CHALLENGE atomically BEFORE issuing session ───────────────
    challenge.consumedAt = new Date().toISOString();
    db.mfaChallenges.set(challenge.id, challenge);

    const family = familyService.getOrCreateUserFamily(user.id);

    // Atomically consume recovery code if used
    if (isRecoveryValid && matchedRecoveryIndex >= 0) {
      user.mfaRecoveryCodes!.splice(matchedRecoveryIndex, 1);
      familyService.logAudit(
        family.id,
        user.id,
        user.name,
        'MFA_RECOVERY_CODE_USED',
        `Logged in using one-time recovery code during MFA challenge. ${user.mfaRecoveryCodes!.length} recovery codes remaining.`
      );
    } else if (isTotpValid && totpResult.acceptedTimeStep !== undefined) {
      // Persist consumed TOTP timestep for replay prevention
      if (!user.totpLastUsedSteps) user.totpLastUsedSteps = {};
      user.totpLastUsedSteps['mfa_login'] = totpResult.acceptedTimeStep;
      familyService.logAudit(
        family.id,
        user.id,
        user.name,
        'LOGIN_SUCCESS',
        `User completed MFA authentication from ${userAgent}.`
      );
    }

    user.lastLoginAt = new Date().toISOString();
    db.users.set(user.id, user);
    db.save();

    const { accessToken, refreshToken } = this.createSession(user.id, userAgent, ipAddress);

    return {
      user,
      accessToken,
      refreshToken,
      token: accessToken,
      emailVerificationPending: !user.emailVerified,
    };
  }

  /**
   * Verify Access Token on every incoming request.
   * ALL claims are mandatory: userId, sub, sessionId, tokenVersion, jti, iss, aud, exp.
   * Session existence, ownership, revocation, expiry, and tokenVersion consistency are unconditionally validated.
   */
  public verifyToken(token: string): { userId: string; sessionId: string; tokenVersion: number; jti: string } {
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

    // Mandatory claim: userId
    const userId = decoded.userId;
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Invalid token claims: userId missing or empty.');
    }

    // Mandatory claim: sub (must exist, be non-empty string, and match userId)
    if (!decoded.sub || typeof decoded.sub !== 'string' || decoded.sub.trim() === '') {
      throw new Error('Invalid token claims: sub missing or empty.');
    }
    if (decoded.sub !== userId) {
      throw new Error('Invalid token claims: subject mismatch.');
    }

    // Mandatory claim: jti (must exist and be non-empty string)
    if (!decoded.jti || typeof decoded.jti !== 'string' || decoded.jti.trim() === '') {
      throw new Error('Invalid token claims: jti missing or empty.');
    }

    // Mandatory claim: sessionId — tokens without sessionId are always rejected
    if (!decoded.sessionId || typeof decoded.sessionId !== 'string' || decoded.sessionId.trim() === '') {
      throw new Error('Invalid token claims: sessionId missing or empty.');
    }

    // Mandatory claim: tokenVersion — tokens without tokenVersion are rejected
    if (decoded.tokenVersion === undefined || decoded.tokenVersion === null || typeof decoded.tokenVersion !== 'number') {
      throw new Error('Invalid token claims: tokenVersion missing.');
    }

    // User must exist and be active
    const user = db.users.get(userId);
    if (!user) {
      throw new Error('User account not found.');
    }

    // tokenVersion must match user record (invalidated on password reset / global logout)
    const userTokenVersion = user.tokenVersion || 1;
    if (decoded.tokenVersion !== userTokenVersion) {
      throw new Error('Token has been invalidated. Please sign in again.');
    }

    // Session validation is unconditional — always enforced
    const session = db.userSessions.get(decoded.sessionId);
    if (!session) {
      throw new Error('Session does not exist.');
    }
    if (session.userId !== userId) {
      throw new Error('Session ownership mismatch.');
    }
    if (session.isRevoked) {
      throw new Error('Session has been revoked.');
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      throw new Error('Session has expired.');
    }
    // Session tokenVersion must match both the token and the user record
    if (session.tokenVersion !== decoded.tokenVersion) {
      throw new Error('Session has been invalidated. Please sign in again.');
    }

    return {
      userId,
      sessionId: decoded.sessionId,
      tokenVersion: decoded.tokenVersion,
      jti: decoded.jti,
    };
  }


  /**
   * Verify Email Address with single-use token
   */
  public verifyEmail(rawToken: string): { success: boolean; message: string } {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('Verification token is required.');
    }

    const tokenHash = hashToken(rawToken);
    let matchedTokenRecord: EmailVerificationToken | undefined;

    for (const record of db.emailVerificationTokens.values()) {
      if (record.tokenHash === tokenHash) {
        matchedTokenRecord = record;
        break;
      }
    }

    if (!matchedTokenRecord || matchedTokenRecord.usedAt) {
      throw new Error('Invalid, consumed or expired email verification token.');
    }

    if (new Date(matchedTokenRecord.expiresAt).getTime() <= Date.now()) {
      throw new Error('Email verification token has expired. Please request a new verification link.');
    }

    const user = db.users.get(matchedTokenRecord.userId);
    if (!user) throw new Error('User not found.');

    user.emailVerified = true;
    matchedTokenRecord.usedAt = new Date().toISOString();

    db.users.set(user.id, user);
    db.emailVerificationTokens.set(matchedTokenRecord.id, matchedTokenRecord);
    db.save();

    const family = familyService.getOrCreateUserFamily(user.id);
    familyService.logAudit(family.id, user.id, user.name, 'EMAIL_VERIFIED', `Parent email address was verified.`);

    return {
      success: true,
      message: 'Email address successfully verified.',
    };
  }

  /**
   * Resend Email Verification Token
   */
  public resendEmailVerification(email: string): { token?: string } {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `resend-ev:${normalizedEmail}`;
    this.checkRateLimit(rateLimitKey, 3, 5 * 60 * 1000);

    const user = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      return {};
    }

    if (user.emailVerified) {
      return {};
    }

    // Invalidate existing active verification tokens for this user
    for (const ev of db.emailVerificationTokens.values()) {
      if (ev.userId === user.id && !ev.usedAt) {
        ev.usedAt = new Date().toISOString();
      }
    }

    const rawEvToken = generateCryptoToken('ev_');
    const evTokenRecord: EmailVerificationToken = {
      id: `evt-${nanoid(10)}`,
      userId: user.id,
      email: user.email,
      tokenHash: hashToken(rawEvToken),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    db.emailVerificationTokens.set(evTokenRecord.id, evTokenRecord);
    db.save();

    mailService.sendVerificationEmail(user.email, rawEvToken);

    return {
      token: process.env.NODE_ENV !== 'production' ? rawEvToken : undefined,
    };
  }

  /**
   * Request Password Reset (Generic non-enumerating response)
   */
  public requestPasswordReset(email: string): { message: string; resetToken?: string } {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `forgot-pwd:${normalizedEmail}`;
    this.checkRateLimit(rateLimitKey, 3, 10 * 60 * 1000);

    const genericMsg = 'If an account exists with this email address, password reset instructions have been sent.';

    const user = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      return { message: genericMsg };
    }

    // Invalidate existing reset tokens for this user
    for (const pr of db.passwordResetTokens.values()) {
      if (pr.userId === user.id && !pr.usedAt) {
        pr.usedAt = new Date().toISOString();
      }
    }

    const rawResetToken = generateCryptoToken('pr_');
    const resetRecord: PasswordResetToken = {
      id: `prt-${nanoid(10)}`,
      userId: user.id,
      tokenHash: hashToken(rawResetToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };

    db.passwordResetTokens.set(resetRecord.id, resetRecord);
    db.save();

    mailService.sendPasswordResetEmail(user.email, rawResetToken);

    return {
      message: genericMsg,
      resetToken: process.env.NODE_ENV !== 'production' ? rawResetToken : undefined,
    };
  }

  /**
   * Reset Password with single-use token:
   * Validates token hash, validates password policy, updates bcrypt hash, revokes previous sessions, increments tokenVersion.
   */
  public resetPassword(rawToken: string, newPassword: string): void {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('Reset token is required.');
    }

    const tokenHash = hashToken(rawToken);
    let matchedRecord: PasswordResetToken | undefined;

    for (const record of db.passwordResetTokens.values()) {
      if (record.tokenHash === tokenHash) {
        matchedRecord = record;
        break;
      }
    }

    if (!matchedRecord || matchedRecord.usedAt) {
      throw new Error('Invalid, expired or already used password reset link.');
    }

    if (new Date(matchedRecord.expiresAt).getTime() <= Date.now()) {
      throw new Error('Password reset link has expired. Please request a new one.');
    }

    const user = db.users.get(matchedRecord.userId);
    if (!user) throw new Error('User not found.');

    validatePasswordPolicy(newPassword, Boolean(user.mfaEnabled));

    const salt = bcrypt.genSaltSync(12);
    user.passwordHash = bcrypt.hashSync(newPassword, salt);
    user.tokenVersion = (user.tokenVersion || 1) + 1; // Invalidate all prior access tokens
    matchedRecord.usedAt = new Date().toISOString();

    // Revoke ALL active sessions for this user
    for (const session of db.userSessions.values()) {
      if (session.userId === user.id) {
        session.isRevoked = true;
      }
    }

    // Invalidate all outstanding MFA challenges for this user
    for (const challenge of db.mfaChallenges.values()) {
      if (challenge.userId === user.id && !challenge.consumedAt && !challenge.invalidatedAt) {
        challenge.invalidatedAt = new Date().toISOString();
        db.mfaChallenges.set(challenge.id, challenge);
      }
    }

    db.users.set(user.id, user);
    db.passwordResetTokens.set(matchedRecord.id, matchedRecord);
    db.save();

    const family = familyService.getOrCreateUserFamily(user.id);
    familyService.logAudit(
      family.id,
      user.id,
      user.name,
      'PASSWORD_RESET',
      `Account password was reset via email verification link. All prior sessions revoked.`
    );
  }

  public getUser(userId: string): ParentUser | undefined {
    return db.users.get(userId);
  }
}

export const authService = new AuthService();
