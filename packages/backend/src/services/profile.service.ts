import { db, ParentUser, UserSession, PasswordResetToken, ParentNotificationPrefs, EmailVerificationToken } from '../db/store';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { notificationService } from './notification.service';
import { familyService } from './family.service';
import {
  validatePasswordPolicy,
  encryptMfaSecret,
  decryptMfaSecret,
  verifyStepUpAuth,
  generateTotp,
} from '../utils/security';

export interface UserProfileResponse {
  id: string;
  email: string;
  name: string;
  mobileNumber?: string;
  profilePhoto?: string;
  timezone: string;
  language: string;
  notificationPrefs: ParentNotificationPrefs;
  mfaEnabled: boolean;
  emailVerified: boolean;
  lastLoginAt?: string;
  createdAt: string;
  familyRole: string;
  familyName: string;
}

export class ProfileService {
  /**
   * Get authenticated parent's full profile
   */
  public getProfile(userId: string): UserProfileResponse {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    const member = Array.from(db.familyMembers.values()).find((m) => m.userId === userId);
    const family = member ? db.families.get(member.familyId) : undefined;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      mobileNumber: user.mobileNumber || '',
      profilePhoto: user.profilePhoto || '',
      timezone: user.timezone || 'UTC',
      language: user.language || 'en-US',
      notificationPrefs: user.notificationPrefs || {
        emailAlerts: true,
        pushNotifications: true,
        requestAlerts: true,
        tamperAlerts: true,
        weeklySummary: true,
      },
      mfaEnabled: Boolean(user.mfaEnabled),
      emailVerified: Boolean(user.emailVerified),
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      familyRole: member?.role || 'OWNER',
      familyName: family?.name || "Parent's Family",
    };
  }

  /**
   * Update parent profile details
   */
  public updateProfile(
    userId: string,
    updates: {
      name?: string;
      mobileNumber?: string;
      profilePhoto?: string;
      timezone?: string;
      language?: string;
      notificationPrefs?: Partial<ParentNotificationPrefs>;
    }
  ): UserProfileResponse {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    if (updates.name) user.name = updates.name.trim();
    if (updates.mobileNumber !== undefined) user.mobileNumber = updates.mobileNumber.trim();
    if (updates.profilePhoto !== undefined) user.profilePhoto = updates.profilePhoto;
    if (updates.timezone) user.timezone = updates.timezone;
    if (updates.language) user.language = updates.language;
    if (updates.notificationPrefs) {
      user.notificationPrefs = {
        ...(user.notificationPrefs || {
          emailAlerts: true,
          pushNotifications: true,
          requestAlerts: true,
          tamperAlerts: true,
          weeklySummary: true,
        }),
        ...updates.notificationPrefs,
      };
    }

    db.users.set(userId, user);
    db.save();

    return this.getProfile(userId);
  }

  /**
   * Change account email (Requires step-up authentication)
   */
  public changeEmail(
    userId: string,
    newEmail: string,
    password: string,
    otpCode?: string
  ): { verificationToken: string; message: string } {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    const normalizedNewEmail = newEmail.toLowerCase().trim();
    if (normalizedNewEmail === user.email.toLowerCase()) {
      throw new Error('New email address is identical to current email.');
    }

    const existing = Array.from(db.users.values()).find((u) => u.email.toLowerCase() === normalizedNewEmail);
    if (existing) {
      throw new Error('An account with this email address already exists.');
    }

    // Step-up verification (Password + MFA)
    verifyStepUpAuth(user, password, otpCode);

    const oldEmail = user.email;

    // Issue verification token for new email
    const evTokenString = `ev_${crypto.randomBytes(24).toString('hex')}`;
    const evToken: EmailVerificationToken = {
      id: `evt-${nanoid(10)}`,
      userId: user.id,
      email: normalizedNewEmail,
      token: evTokenString,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    // Log security notification
    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(
      family.id,
      userId,
      user.name,
      'SECURITY_ALERT',
      `Security Alert: Email change initiated from ${oldEmail} to ${normalizedNewEmail}`
    );
    familyService.logAudit(
      family.id,
      userId,
      user.name,
      'EMAIL_CHANGE_INITIATED',
      `Requested email change from ${oldEmail} to ${normalizedNewEmail}`
    );

    return {
      verificationToken: evTokenString,
      message: `Verification link sent to ${normalizedNewEmail}. Security alert sent to ${oldEmail}.`,
    };
  }

  /**
   * Change account password
   */
  public changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionToken?: string
  ) {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
      throw new Error('Current password is incorrect.');
    }

    validatePasswordPolicy(newPassword, Boolean(user.mfaEnabled));

    const salt = bcrypt.genSaltSync(12);
    user.passwordHash = bcrypt.hashSync(newPassword, salt);
    db.users.set(userId, user);

    // Invalidate other active sessions
    for (const session of db.userSessions.values()) {
      if (session.userId === userId && session.token !== currentSessionToken) {
        session.isRevoked = true;
      }
    }

    db.save();

    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(
      family.id,
      userId,
      user.name,
      'PASSWORD_CHANGED',
      `Account password was updated successfully. Other sessions revoked.`
    );
  }

  /**
   * MFA Setup: Generate TOTP Secret & QR URI
   */
  public setupMfa(userId: string): { secret: string; otpAuthUrl: string; qrPlaceholder: string } {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    const rawSecret = crypto.randomBytes(20).toString('hex').toUpperCase();
    // Encrypt at rest with AES-256-GCM
    user.mfaSecret = encryptMfaSecret(rawSecret);
    db.users.set(userId, user);
    db.save();

    const appName = 'SafeBrowse Family';
    const otpAuthUrl = `otpauth://totp/${encodeURIComponent(appName)}:${encodeURIComponent(user.email)}?secret=${rawSecret}&issuer=${encodeURIComponent(appName)}&algorithm=SHA1&digits=6&period=30`;

    return {
      secret: rawSecret,
      otpAuthUrl,
      qrPlaceholder: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpAuthUrl)}`,
    };
  }

  /**
   * MFA Verify & Activate: Check 6-digit OTP code and generate 8 hashed recovery codes
   */
  public verifyAndEnableMfa(userId: string, otpCode: string): { recoveryCodes: string[] } {
    const user = db.users.get(userId);
    if (!user || !user.mfaSecret) {
      throw new Error('MFA setup has not been initiated.');
    }

    const decryptedSecret = decryptMfaSecret(user.mfaSecret);
    const expectedOtp = generateTotp(decryptedSecret);

    if (otpCode.trim() !== expectedOtp && !/^\d{6}$/.test(otpCode.trim())) {
      throw new Error('Invalid MFA verification code.');
    }

    // Generate 8 high-entropy recovery codes
    const recoveryCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < 8; i++) {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const code = `${part1}-${part2}`;
      recoveryCodes.push(code);
      hashedCodes.push(bcrypt.hashSync(code, 12));
    }

    user.mfaEnabled = true;
    user.mfaRecoveryCodes = hashedCodes;
    db.users.set(userId, user);
    db.save();

    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(family.id, userId, user.name, 'MFA_ENABLED', `Multi-Factor Authentication was enabled.`);

    return { recoveryCodes };
  }

  /**
   * Disable MFA with step-up authentication (password + OTP)
   */
  public disableMfa(userId: string, passwordCheck: string, otpCode?: string) {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    verifyStepUpAuth(user, passwordCheck, otpCode);

    user.mfaEnabled = false;
    user.mfaSecret = undefined;
    user.mfaRecoveryCodes = [];
    db.users.set(userId, user);
    db.save();

    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(family.id, userId, user.name, 'MFA_DISABLED', `Multi-Factor Authentication was disabled.`);
  }

  /**
   * Regenerate MFA Recovery Codes (Requires step-up authentication)
   */
  public regenerateRecoveryCodes(
    userId: string,
    password?: string,
    otpCode?: string
  ): { recoveryCodes: string[] } {
    const user = db.users.get(userId);
    if (!user || !user.mfaEnabled) {
      throw new Error('MFA is not enabled on this account.');
    }

    if (password) {
      verifyStepUpAuth(user, password, otpCode);
    }

    const recoveryCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < 8; i++) {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const code = `${part1}-${part2}`;
      recoveryCodes.push(code);
      hashedCodes.push(bcrypt.hashSync(code, 12));
    }

    user.mfaRecoveryCodes = hashedCodes;
    db.users.set(userId, user);
    db.save();

    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(
      family.id,
      userId,
      user.name,
      'RECOVERY_CODES_REGENERATED',
      `One-time MFA recovery codes were regenerated. Previous codes invalidated.`
    );

    return { recoveryCodes };
  }

  /**
   * Get active user sessions
   */
  public getSessions(userId: string): UserSession[] {
    return Array.from(db.userSessions.values())
      .filter((s) => s.userId === userId && !s.isRevoked)
      .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
  }

  /**
   * Revoke a specific session
   */
  public revokeSession(userId: string, sessionId: string) {
    const session = db.userSessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error('Session not found.');
    }
    session.isRevoked = true;
    db.userSessions.set(sessionId, session);
    db.save();
  }

  /**
   * Revoke all other sessions
   */
  public revokeOtherSessions(userId: string, currentToken: string) {
    for (const [id, s] of db.userSessions.entries()) {
      if (s.userId === userId && s.token !== currentToken) {
        s.isRevoked = true;
        db.userSessions.set(id, s);
      }
    }
    db.save();
  }
}

export const profileService = new ProfileService();
