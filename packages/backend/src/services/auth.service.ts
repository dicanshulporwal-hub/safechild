import { db, ParentUser, UserSession, EmailVerificationToken, PasswordResetToken } from '../db/store';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { familyService } from './family.service';
import {
  validatePasswordPolicy,
  encryptMfaSecret,
  decryptMfaSecret,
  generateTotp,
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
  token?: string;
  mfaRequired?: boolean;
  mfaTicket?: string;
  emailVerificationPending?: boolean;
}

// In-memory rate limiting for login attempts
interface RateLimitRecord {
  attempts: number;
  lockedUntil: number;
}
const loginRateLimits = new Map<string, RateLimitRecord>();

export class AuthService {
  /**
   * Check and increment login rate limit
   */
  private checkRateLimit(key: string): void {
    const now = Date.now();
    const record = loginRateLimits.get(key);
    if (record) {
      if (record.lockedUntil > now) {
        const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
        throw new Error(`Too many failed login attempts. Account temporarily locked for ${remainingSec}s.`);
      }
      if (record.lockedUntil <= now && record.attempts >= 5) {
        // Reset after lockout expiry
        loginRateLimits.delete(key);
      }
    }
  }

  private recordFailedAttempt(key: string): void {
    const now = Date.now();
    const record = loginRateLimits.get(key) || { attempts: 0, lockedUntil: 0 };
    record.attempts += 1;
    if (record.attempts >= 5) {
      record.lockedUntil = now + 15 * 60 * 1000; // 15 minute lockout
    }
    loginRateLimits.set(key, record);
  }

  private clearRateLimit(key: string): void {
    loginRateLimits.delete(key);
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
  ): { user: ParentUser; token: string; emailVerificationToken: string } {
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
      id: `parent-${nanoid(10)}`,
      email: normalizedEmail,
      passwordHash,
      name: name.trim(),
      mobileNumber: '',
      timezone: 'UTC',
      language: 'en-US',
      notificationPrefs: {
        emailAlerts: true,
        pushNotifications: true,
        requestAlerts: true,
        tamperAlerts: true,
        weeklySummary: true,
      },
      mfaEnabled: false,
      emailVerified: false,
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    db.users.set(user.id, user);

    // Auto-create default family
    familyService.getOrCreateUserFamily(user.id);

    // Generate email verification token (48h expiry)
    const evTokenString = `ev_${crypto.randomBytes(24).toString('hex')}`;
    const evToken: EmailVerificationToken = {
      id: `evt-${nanoid(10)}`,
      userId: user.id,
      email: normalizedEmail,
      token: evTokenString,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };
    db.emailVerificationTokens.set(evToken.id, evToken);

    const token = this.generateToken(user.id);

    // Register active session
    const session: UserSession = {
      id: `sess-${nanoid(10)}`,
      userId: user.id,
      token,
      deviceInfo: userAgent,
      ipAddress,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    db.userSessions.set(session.id, session);
    db.save();

    return { user, token, emailVerificationToken: evTokenString };
  }

  /**
   * Verify email with verification token
   */
  public verifyEmail(tokenString: string): { success: boolean; email: string } {
    const ev = Array.from(db.emailVerificationTokens.values()).find(
      (t) => t.token === tokenString && !t.usedAt
    );

    if (!ev) {
      throw new Error('Invalid or expired email verification token.');
    }

    if (new Date(ev.expiresAt).getTime() < Date.now()) {
      throw new Error('Email verification token has expired. Please request a new one.');
    }

    const user = db.users.get(ev.userId);
    if (!user) {
      throw new Error('User not found.');
    }

    user.emailVerified = true;
    ev.usedAt = new Date().toISOString();
    db.users.set(user.id, user);
    db.emailVerificationTokens.set(ev.id, ev);
    db.save();

    return { success: true, email: user.email };
  }

  /**
   * Resend email verification
   */
  public resendEmailVerification(email: string): { token: string } {
    const normalizedEmail = email.toLowerCase().trim();
    const user = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      // Generic non-revealing response
      return { token: 'generic-dispatched' };
    }

    if (user.emailVerified) {
      throw new Error('This email address is already verified.');
    }

    const evTokenString = `ev_${crypto.randomBytes(24).toString('hex')}`;
    const evToken: EmailVerificationToken = {
      id: `evt-${nanoid(10)}`,
      userId: user.id,
      email: normalizedEmail,
      token: evTokenString,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };
    db.emailVerificationTokens.set(evToken.id, evToken);
    db.save();

    return { token: evTokenString };
  }

  /**
   * Parent Login with rate limiting, Bcrypt verification and MFA challenge
   */
  public login(
    email: string,
    password: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): LoginResult {
    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `${normalizedEmail}_${ipAddress || 'unknown'}`;
    this.checkRateLimit(rateLimitKey);

    const user = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedEmail);

    if (!user) {
      this.recordFailedAttempt(rateLimitKey);
      throw new Error('Invalid email or password.');
    }

    // Constant-time bcrypt password verification
    const isValid = bcrypt.compareSync(password, user.passwordHash);
    if (!isValid) {
      this.recordFailedAttempt(rateLimitKey);
      throw new Error('Invalid email or password.');
    }

    this.clearRateLimit(rateLimitKey);

    // Check MFA
    if (user.mfaEnabled) {
      const mfaTicket = jwt.sign({ userId: user.id, mfaPending: true, jti: nanoid(12) }, getJwtSecret(), { expiresIn: '5m' });
      return {
        mfaRequired: true,
        mfaTicket,
      };
    }

    user.lastLoginAt = new Date().toISOString();
    db.users.set(user.id, user);

    const token = this.generateToken(user.id);

    // Record session
    const session: UserSession = {
      id: `sess-${nanoid(10)}`,
      userId: user.id,
      token,
      deviceInfo: userAgent,
      ipAddress,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    db.userSessions.set(session.id, session);
    db.save();

    return { user, token };
  }

  /**
   * Verify MFA login with 6-digit TOTP or Recovery Code
   */
  public verifyMfaLogin(
    mfaTicket: string,
    codeOrRecoveryCode: string,
    userAgent: string = 'Web Browser',
    ipAddress?: string
  ): { user: ParentUser; token: string } {
    let payload: { userId: string; mfaPending?: boolean };
    try {
      payload = jwt.verify(mfaTicket, getJwtSecret()) as { userId: string; mfaPending?: boolean };
    } catch (e) {
      throw new Error('MFA session expired or invalid. Please sign in again.');
    }

    if (!payload.userId || !payload.mfaPending) {
      throw new Error('Invalid MFA ticket.');
    }

    const user = db.users.get(payload.userId);
    if (!user || !user.mfaSecret) {
      throw new Error('User not found or MFA is not configured.');
    }

    const cleanInput = codeOrRecoveryCode.trim().toUpperCase();
    let verified = false;

    // 1. Try TOTP code
    if (cleanInput.length === 6 && /^\d+$/.test(cleanInput)) {
      const decryptedSecret = decryptMfaSecret(user.mfaSecret);
      const expectedOtp = generateTotp(decryptedSecret);
      if (cleanInput === expectedOtp) {
        verified = true;
      }
    }

    // 2. Try single-use recovery code
    if (!verified && user.mfaRecoveryCodes) {
      for (let i = 0; i < user.mfaRecoveryCodes.length; i++) {
        const hashedCode = user.mfaRecoveryCodes[i];
        if (bcrypt.compareSync(cleanInput, hashedCode)) {
          verified = true;
          // Consume recovery code (single use)
          user.mfaRecoveryCodes.splice(i, 1);
          db.users.set(user.id, user);
          break;
        }
      }
    }

    if (!verified) {
      throw new Error('Invalid verification code or recovery code.');
    }

    user.lastLoginAt = new Date().toISOString();
    db.users.set(user.id, user);

    const token = this.generateToken(user.id);

    // Record session
    const session: UserSession = {
      id: `sess-${nanoid(10)}`,
      userId: user.id,
      token,
      deviceInfo: userAgent,
      ipAddress,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    db.userSessions.set(session.id, session);
    db.save();

    return { user, token };
  }

  /**
   * Request password reset (Generic non-enumerating response)
   */
  public requestPasswordReset(email: string): { message: string; resetToken?: string } {
    const normalized = email.toLowerCase().trim();
    const user = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalized);

    const genericMsg = 'If an account exists, reset instructions have been sent.';

    if (!user) {
      return { message: genericMsg };
    }

    const tokenString = `pr_${crypto.randomBytes(24).toString('hex')}`;
    const resetToken: PasswordResetToken = {
      id: `prt-${nanoid(10)}`,
      userId: user.id,
      token: tokenString,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };

    db.passwordResetTokens.set(resetToken.id, resetToken);
    db.save();

    return { message: genericMsg, resetToken: tokenString };
  }

  /**
   * Reset password and revoke ALL prior sessions
   */
  public resetPassword(tokenString: string, newPassword: string): void {
    validatePasswordPolicy(newPassword, false);

    const resetToken = Array.from(db.passwordResetTokens.values()).find(
      (t) => t.token === tokenString && !t.usedAt
    );

    if (!resetToken) {
      throw new Error('Invalid or expired password reset token.');
    }

    if (new Date(resetToken.expiresAt).getTime() < Date.now()) {
      throw new Error('Password reset token has expired.');
    }

    const user = db.users.get(resetToken.userId);
    if (!user) {
      throw new Error('User not found.');
    }

    user.passwordHash = bcrypt.hashSync(newPassword, 12);
    resetToken.usedAt = new Date().toISOString();

    db.users.set(user.id, user);
    db.passwordResetTokens.set(resetToken.id, resetToken);

    // Strictly revoke ALL previous sessions upon password reset
    for (const session of db.userSessions.values()) {
      if (session.userId === user.id) {
        session.isRevoked = true;
      }
    }

    db.save();
  }

  public generateToken(userId: string): string {
    return jwt.sign({ userId, jti: nanoid(12) }, getJwtSecret(), { expiresIn: '7d' });
  }

  public verifyToken(token: string): { userId: string } {
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as { userId: string };
      // Check session validity
      const session = Array.from(db.userSessions.values()).find((s) => s.token === token);
      if (session && session.isRevoked) {
        throw new Error('Session has been revoked.');
      }
      return decoded;
    } catch (e: any) {
      if (e.message && e.message.includes('revoked')) {
        throw e;
      }
      throw new Error('Invalid or expired token.');
    }
  }

  public getUser(userId: string): ParentUser | undefined {
    return db.users.get(userId);
  }
}

export const authService = new AuthService();
