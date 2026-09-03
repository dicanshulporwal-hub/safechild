import { prisma } from '../db/prisma';
import { ParentUser, UserSession, ParentNotificationPrefs } from '../types/models';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
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
import { nanoid } from 'nanoid';

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
  public async getProfile(userId: string): Promise<UserProfileResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new Error('User not found.');

    const member = await prisma.familyMember.findFirst({
      where: { userId },
      include: { family: true },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      mobileNumber: user.mobileNumber || '',
      profilePhoto: user.profilePhoto || '',
      timezone: user.timezone || 'UTC',
      language: user.language || 'en-US',
      notificationPrefs: (user.notificationPrefs as any) || {
        emailAlerts: true,
        pushNotifications: true,
        requestAlerts: true,
        tamperAlerts: true,
        weeklySummary: true,
      },
      mfaEnabled: Boolean(user.mfaEnabled),
      emailVerified: Boolean(user.emailVerified),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : undefined,
      createdAt: user.createdAt.toISOString(),
      familyRole: member?.role || 'OWNER',
      familyName: member?.family?.name || "Parent's Family",
    };
  }

  /**
   * Update parent profile details
   */
  public async updateProfile(
    userId: string,
    updates: {
      name?: string;
      mobileNumber?: string;
      profilePhoto?: string;
      timezone?: string;
      language?: string;
      notificationPrefs?: Partial<ParentNotificationPrefs>;
    }
  ): Promise<UserProfileResponse> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found.');

    const currentPrefs = (user.notificationPrefs as any) || {
      emailAlerts: true,
      pushNotifications: true,
      requestAlerts: true,
      tamperAlerts: true,
      weeklySummary: true,
    };

    const newPrefs = updates.notificationPrefs
      ? { ...currentPrefs, ...updates.notificationPrefs }
      : currentPrefs;

    await prisma.user.update({
      where: { id: userId },
      data: {
        name: updates.name ? updates.name.trim() : undefined,
        mobileNumber: updates.mobileNumber !== undefined ? updates.mobileNumber.trim() : undefined,
        profilePhoto: updates.profilePhoto !== undefined ? updates.profilePhoto : undefined,
        timezone: updates.timezone || undefined,
        language: updates.language || undefined,
        notificationPrefs: newPrefs,
      },
    });

    return this.getProfile(userId);
  }

  /**
   * Change account password
   */
  public async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId?: string
  ): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found.');

    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
      throw new Error('Current password is incorrect.');
    }

    validatePasswordPolicy(newPassword, Boolean(user.mfaEnabled));

    const salt = bcrypt.genSaltSync(12);
    const newHash = bcrypt.hashSync(newPassword, salt);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          tokenVersion: { increment: 1 },
        },
      });

      // Invalidate other active sessions
      if (currentSessionId) {
        await tx.userSession.updateMany({
          where: {
            userId,
            id: { not: currentSessionId },
          },
          data: { isRevoked: true },
        });
      }

      const fam = await tx.familyMember.findFirst({
        where: { userId },
      });
      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: userId,
            actorName: user.name,
            action: 'PASSWORD_CHANGED',
            details: 'Account password was updated successfully. Other sessions revoked.',
          },
        });
      }
    });
  }

  /**
   * MFA Setup: Generate 160-bit Base32 TOTP Secret & Local QR Data URL
   */
  public async setupMfa(
    userId: string
  ): Promise<{ secret: string; otpAuthUrl: string; qrDataUrl: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found.');

    const rawSecret = generateBase32Secret();
    const encryptedSecret = encryptMfaSecret(rawSecret);

    await prisma.user.update({
      where: { id: userId },
      data: { pendingMfaSecret: encryptedSecret },
    });

    const otpAuthUrl = generateOtpAuthUri(user.email, rawSecret, 'SafeBrowse Family');
    const qrDataUrl = await generateLocalQrDataUrl(otpAuthUrl);

    return {
      secret: rawSecret,
      otpAuthUrl,
      qrDataUrl,
    };
  }

  /**
   * MFA Verify & Activate
   */
  public async verifyAndEnableMfa(
    userId: string,
    otpCode: string,
    timeSec?: number
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.pendingMfaSecret) {
      throw new Error('MFA setup has not been initiated.');
    }

    const decryptedSecret = decryptMfaSecret(user.pendingMfaSecret);
    const totpResult = verifyTotpToken(decryptedSecret, otpCode, timeSec);

    if (!totpResult.valid) {
      throw new Error('Invalid MFA verification code. Please check your authenticator app and try again.');
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

    const totpSteps = (user.totpLastUsedSteps as any) ? { ...(user.totpLastUsedSteps as any) } : {};
    if (totpResult.acceptedTimeStep !== undefined) {
      totpSteps['mfa_setup'] = totpResult.acceptedTimeStep;
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: true,
          mfaSecret: user.pendingMfaSecret,
          pendingMfaSecret: null,
          mfaRecoveryCodes: hashedCodes,
          totpLastUsedSteps: totpSteps,
        },
      });

      const fam = await tx.familyMember.findFirst({
        where: { userId },
      });
      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: userId,
            actorName: user.name,
            action: 'MFA_ENABLED',
            details: 'Multi-Factor Authentication was enabled.',
          },
        });
      }
    });

    return { recoveryCodes };
  }

  /**
   * Disable MFA with step-up authentication
   */
  public async disableMfa(
    userId: string,
    passwordCheck: string,
    otpCode?: string,
    timeSec?: number
  ): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found.');

    const stepUp = verifyStepUpAuth(user as any, passwordCheck, otpCode, timeSec);

    const updatedRecoveryCodes = [...user.mfaRecoveryCodes];
    const updatedTotpSteps = (user.totpLastUsedSteps as any) ? { ...(user.totpLastUsedSteps as any) } : {};

    if (stepUp.method === 'TOTP' && stepUp.totpTimeStep !== undefined) {
      const lastUsed = updatedTotpSteps['mfa_disable'];
      if (lastUsed !== undefined && lastUsed === stepUp.totpTimeStep) {
        throw new Error('This TOTP code has already been used. Please wait for the next code.');
      }
      updatedTotpSteps['mfa_disable'] = stepUp.totpTimeStep;
    } else if (stepUp.method === 'RECOVERY_CODE' && stepUp.recoveryCodeIndex !== undefined) {
      updatedRecoveryCodes.splice(stepUp.recoveryCodeIndex, 1);
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: false,
          mfaSecret: null,
          pendingMfaSecret: null,
          mfaRecoveryCodes: [],
          totpLastUsedSteps: updatedTotpSteps,
        },
      });

      const fam = await tx.familyMember.findFirst({
        where: { userId },
      });
      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: userId,
            actorName: user.name,
            action: 'MFA_DISABLED',
            details: 'Multi-Factor Authentication was disabled.',
          },
        });
      }
    });
  }

  /**
   * Regenerate MFA Recovery Codes
   */
  public async regenerateRecoveryCodes(
    userId: string,
    password: string,
    otpCode?: string,
    timeSec?: number
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.mfaEnabled) {
      throw new Error('MFA is not enabled on this account.');
    }

    const stepUp = verifyStepUpAuth(user as any, password, otpCode, timeSec);

    const updatedTotpSteps = (user.totpLastUsedSteps as any) ? { ...(user.totpLastUsedSteps as any) } : {};
    if (stepUp.method === 'TOTP' && stepUp.totpTimeStep !== undefined) {
      const lastUsed = updatedTotpSteps['mfa_recovery_regen'];
      if (lastUsed !== undefined && lastUsed === stepUp.totpTimeStep) {
        throw new Error('This TOTP code has already been used. Please wait for the next code.');
      }
      updatedTotpSteps['mfa_recovery_regen'] = stepUp.totpTimeStep;
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

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaRecoveryCodes: hashedCodes,
          totpLastUsedSteps: updatedTotpSteps,
        },
      });

      const fam = await tx.familyMember.findFirst({
        where: { userId },
      });
      if (fam) {
        await tx.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: userId,
            actorName: user.name,
            action: 'MFA_RECOVERY_CODES_REGENERATED',
            details: 'Regenerated MFA one-time recovery codes via step-up authentication.',
          },
        });
      }
    });

    return { recoveryCodes };
  }

  /**
   * Get all active sessions for user
   */
  public async getUserSessions(
    userId: string,
    currentSessionId?: string
  ): Promise<SanitizedSessionResponse[]> {
    const sessions = await prisma.userSession.findMany({
      where: {
        userId,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      deviceInfo: s.deviceInfo,
      ipAddress: s.ipAddress || undefined,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      isCurrent: currentSessionId ? s.id === currentSessionId : false,
    }));
  }

  public async getSessions(userId: string, currentSessionId?: string): Promise<SanitizedSessionResponse[]> {
    return this.getUserSessions(userId, currentSessionId);
  }

  /**
   * Revoke a specific session
   */
  public async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await prisma.userSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) {
      throw new Error('Session not found.');
    }

    await prisma.userSession.update({
      where: { id: sessionId },
      data: { isRevoked: true },
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      const fam = await prisma.familyMember.findFirst({ where: { userId } });
      if (fam) {
        await prisma.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: userId,
            actorName: user.name,
            action: 'SESSION_REVOKED',
            details: `User session (${session.deviceInfo}) was revoked.`,
          },
        });
      }
    }
  }

  /**
   * Revoke all other sessions
   */
  public async revokeOtherSessions(userId: string, currentSessionId?: string): Promise<void> {
    await prisma.userSession.updateMany({
      where: {
        userId,
        id: currentSessionId ? { not: currentSessionId } : undefined,
      },
      data: { isRevoked: true },
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      const fam = await prisma.familyMember.findFirst({ where: { userId } });
      if (fam) {
        await prisma.familyAuditLog.create({
          data: {
            id: `log-${nanoid(10)}`,
            familyId: fam.familyId,
            actorUserId: userId,
            actorName: user.name,
            action: 'ALL_OTHER_SESSIONS_REVOKED',
            details: 'All other active sessions were revoked.',
          },
        });
      }
    }
  }

  /**
   * Delete User Account Transactionally
   */
  public async deleteAccount(userId: string, password?: string): Promise<void> {
    if (password) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        throw new Error('Invalid password provided.');
      }
    }

    return prisma.$transaction(async (tx) => {
      // Check if user is the OWNER of any family
      const ownedFamilies = await tx.family.findMany({
        where: { ownerUserId: userId },
      });

      if (ownedFamilies.length > 0) {
        throw new Error(
          `Cannot delete account: You are the sole owner of family '${ownedFamilies[0].name}'. You must transfer family ownership before deleting your account.`
        );
      }

      // Delete user's memberships (does not delete family or resources)
      await tx.familyMember.deleteMany({
        where: { userId },
      });

      // Delete user (sessions, tokens, challenges cascade via schema)
      await tx.user.delete({
        where: { id: userId },
      });
    });
  }
}

export const profileService = new ProfileService();
