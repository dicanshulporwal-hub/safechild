import { db, ParentUser, UserSession, ParentNotificationPrefs } from '../db/store';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { familyService } from './family.service';
import {
  validatePasswordPolicy,
  encryptMfaSecret,
  decryptMfaSecret,
  verifyStepUpAuth,
  getCurrentTotpTimeStep,
  generateBase32Secret,
  generateOtpAuthUri,
  generateLocalQrDataUrl,
  verifyTotpToken,
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

export interface SanitizedSessionResponse {
  id: string;
  deviceInfo: string;
  ipAddress?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent?: boolean;
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
   * Change account password
   */
  public changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId?: string
  ): void {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
      throw new Error('Current password is incorrect.');
    }

    validatePasswordPolicy(newPassword, Boolean(user.mfaEnabled));

    const salt = bcrypt.genSaltSync(12);
    user.passwordHash = bcrypt.hashSync(newPassword, salt);
    user.tokenVersion = (user.tokenVersion || 1) + 1; // Invalidate all prior tokens
    db.users.set(userId, user);

    // Invalidate other active sessions
    for (const session of db.userSessions.values()) {
      if (session.userId === userId && session.id !== currentSessionId) {
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
   * MFA Setup: Generate 160-bit Base32 TOTP Secret & Local QR Data URL
   */
  public async setupMfa(userId: string): Promise<{ secret: string; otpAuthUrl: string; qrDataUrl: string }> {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    const rawSecret = generateBase32Secret();
    // Encrypt at rest with AES-256-GCM
    user.pendingMfaSecret = encryptMfaSecret(rawSecret);
    db.users.set(userId, user);
    db.save();

    const otpAuthUrl = generateOtpAuthUri(user.email, rawSecret, 'SafeBrowse Family');
    // Generate local QR code without calling external APIs
    const qrDataUrl = await generateLocalQrDataUrl(otpAuthUrl);

    return {
      secret: rawSecret,
      otpAuthUrl,
      qrDataUrl,
    };
  }

  /**
   * MFA Verify & Activate: Check 6-digit OTP code against pending secret and issue 8 hashed recovery codes
   */
  public verifyAndEnableMfa(userId: string, otpCode: string, timeSec?: number): { recoveryCodes: string[] } {
    const user = db.users.get(userId);
    if (!user || !user.pendingMfaSecret) {
      throw new Error('MFA setup has not been initiated.');
    }

    const decryptedSecret = decryptMfaSecret(user.pendingMfaSecret);
    const totpResult = verifyTotpToken(decryptedSecret, otpCode, timeSec);

    if (!totpResult.valid) {
      throw new Error('Invalid MFA verification code. Please check your authenticator app and try again.');
    }

    // Generate 8 high-entropy recovery codes (e.g. 8A3F-C29D)
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
    user.mfaSecret = user.pendingMfaSecret;
    user.pendingMfaSecret = undefined;
    user.mfaRecoveryCodes = hashedCodes;
    if (totpResult.acceptedTimeStep !== undefined) {
      if (!user.totpLastUsedSteps) user.totpLastUsedSteps = {};
      user.totpLastUsedSteps['mfa_setup'] = totpResult.acceptedTimeStep;
    }
    db.users.set(userId, user);
    db.save();

    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(family.id, userId, user.name, 'MFA_ENABLED', `Multi-Factor Authentication was enabled.`);

    // Display plaintext recovery codes only once upon activation
    return { recoveryCodes };
  }

  /**
   * Disable MFA with step-up authentication (password + OTP or recovery code).
   * Consumes the recovery code if one was used in step-up.
   * Tracks TOTP timestep to prevent same-code replay.
   */
  public disableMfa(userId: string, passwordCheck: string, otpCode?: string, timeSec?: number): void {
    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    const stepUp = verifyStepUpAuth(user, passwordCheck, otpCode, timeSec);

    // TOTP timestep replay protection for MFA disablement
    if (stepUp.method === 'TOTP' && stepUp.totpTimeStep !== undefined) {
      const lastUsed = user.totpLastUsedSteps?.['mfa_disable'];
      if (lastUsed !== undefined && lastUsed === stepUp.totpTimeStep) {
        throw new Error('This TOTP code has already been used. Please wait for the next code.');
      }
      if (!user.totpLastUsedSteps) user.totpLastUsedSteps = {};
      user.totpLastUsedSteps['mfa_disable'] = stepUp.totpTimeStep;
    }

    // Atomically consume recovery code if used in step-up
    if (stepUp.method === 'RECOVERY_CODE' && stepUp.recoveryCodeIndex !== undefined) {
      user.mfaRecoveryCodes!.splice(stepUp.recoveryCodeIndex, 1);
    }

    user.mfaEnabled = false;
    user.mfaSecret = undefined;
    user.pendingMfaSecret = undefined;
    user.mfaRecoveryCodes = [];
    db.users.set(userId, user);
    db.save();

    const family = familyService.getOrCreateUserFamily(userId);
    familyService.logAudit(family.id, userId, user.name, 'MFA_DISABLED', `Multi-Factor Authentication was disabled.`);
  }

  /**
   * Regenerate MFA Recovery Codes (Requires step-up authentication)
   * Password and MFA verification (TOTP / existing recovery code) are MANDATORY.
   */
  public regenerateRecoveryCodes(
    userId: string,
    password: string,
    otpCode?: string,
    timeSec?: number
  ): { recoveryCodes: string[] } {
    const user = db.users.get(userId);
    if (!user || !user.mfaEnabled) {
      throw new Error('MFA is not enabled on this account.');
    }

    // Always enforce step-up authentication unconditionally
    const stepUp = verifyStepUpAuth(user, password, otpCode, timeSec);

    // Anti-replay check for TOTP timestep on recovery codes regeneration
    if (stepUp.method === 'TOTP' && stepUp.totpTimeStep !== undefined) {
      const lastUsed = user.totpLastUsedSteps?.['mfa_recovery_regen'];
      if (lastUsed !== undefined && lastUsed === stepUp.totpTimeStep) {
        throw new Error('This TOTP code has already been used. Please wait for the next code.');
      }
      if (!user.totpLastUsedSteps) user.totpLastUsedSteps = {};
      user.totpLastUsedSteps['mfa_recovery_regen'] = stepUp.totpTimeStep;
    }

    const family = familyService.getOrCreateUserFamily(userId);

    // If step-up was performed with a recovery code, log that it was used
    if (stepUp.method === 'RECOVERY_CODE' && stepUp.recoveryCodeIndex !== undefined) {
      familyService.logAudit(
        family.id,
        userId,
        user.name,
        'MFA_RECOVERY_CODE_USED',
        `Recovery code used for step-up authentication during code regeneration.`
      );
    }

    // Invalidate all previous recovery codes and generate 8 new high-entropy codes
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
   * Get active user sessions (Sanitized: NEVER returns tokens, hashes or secrets)
   */
  public getSessions(userId: string, currentSessionId?: string): SanitizedSessionResponse[] {
    return Array.from(db.userSessions.values())
      .filter((s) => s.userId === userId && !s.isRevoked && new Date(s.expiresAt).getTime() > Date.now())
      .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
      .map((s) => ({
        id: s.id,
        deviceInfo: s.deviceInfo,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        isCurrent: currentSessionId ? s.id === currentSessionId : false,
      }));
  }

  /**
   * Revoke a specific session
   */
  public revokeSession(userId: string, sessionId: string): void {
    const session = db.userSessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error('Session not found.');
    }
    session.isRevoked = true;
    db.userSessions.set(sessionId, session);
    db.save();

    const user = db.users.get(userId);
    if (user) {
      const family = familyService.getOrCreateUserFamily(userId);
      familyService.logAudit(
        family.id,
        userId,
        user.name,
        'SESSION_REVOKED',
        `User session (${session.deviceInfo}) was revoked.`
      );
    }
  }

  /**
   * Revoke all other sessions
   */
  public revokeOtherSessions(userId: string, currentSessionId?: string): void {
    for (const [id, s] of db.userSessions.entries()) {
      if (s.userId === userId && s.id !== currentSessionId) {
        s.isRevoked = true;
        db.userSessions.set(id, s);
      }
    }
    db.save();

    const user = db.users.get(userId);
    if (user) {
      const family = familyService.getOrCreateUserFamily(userId);
      familyService.logAudit(
        family.id,
        userId,
        user.name,
        'ALL_OTHER_SESSIONS_REVOKED',
        `All other active sessions were revoked.`
      );
    }
  }
}

export const profileService = new ProfileService();
