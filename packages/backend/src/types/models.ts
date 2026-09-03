import {
  Child,
  Device,
  Policy,
  PairingCode,
  AccessRequest,
  ActivityEvent,
  ChildUsageRecord,
} from '@safebrowse/shared';

export type SystemRole = 'SYSTEM_ADMIN' | 'USER';
export type FamilyRole = 'OWNER' | 'PARENT' | 'VIEWER';
export type FamilyApprovalRule = 'OWNER_ONLY' | 'OWNER_OR_PARENT';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
export type RequestStatus = 'PENDING' | 'ALLOWED' | 'DENIED';
export type DeviceHealthState = 'PROTECTED' | 'DEGRADED' | 'OFFLINE';

export class DataPersistenceError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'DataPersistenceError';
  }
}

export class DataLoadError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'DataLoadError';
  }
}

export class FatalConsistencyError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'FatalConsistencyError';
  }
}

export class FatalTenancyError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'FatalTenancyError';
  }
}

export interface ParentNotificationPrefs {
  emailAlerts: boolean;
  pushNotifications: boolean;
  requestAlerts: boolean;
  tamperAlerts: boolean;
  weeklySummary: boolean;
}

export interface ParentUser {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  systemRole?: SystemRole;
  mobileNumber?: string;
  profilePhoto?: string;
  timezone?: string;
  language?: string;
  notificationPrefs?: ParentNotificationPrefs;
  mfaEnabled?: boolean;
  mfaSecret?: string | null;
  pendingMfaSecret?: string | null;
  mfaRecoveryCodes?: string[];
  totpLastUsedSteps?: Record<string, number> | null;
  tokenVersion?: number;
  emailVerified?: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
  consentVersion?: string;
  consentTimestamp?: string;
  privacyPolicyVersion?: string;
}

export interface MfaChallenge {
  id: string;
  userId: string;
  jtiHash: string;
  purpose: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | null;
  invalidatedAt?: string | null;
  attemptCount: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface Family {
  id: string;
  name: string;
  ownerUserId: string;
  requireMfa: boolean;
  approvalRule: FamilyApprovalRule;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyMember {
  id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  joinedAt: string;
}

export interface FamilyInvitation {
  id: string;
  familyId: string;
  email: string;
  role: FamilyRole;
  tokenHash: string;
  expiresAt: string;
  status: InvitationStatus;
  invitedByUserId: string;
  createdAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
}

export interface UserSession {
  id: string;
  userId: string;
  sessionFamilyId?: string;
  refreshTokenHash: string;
  consumedTokenHashes?: string[];
  deviceInfo: string;
  ipAddress?: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isRevoked: boolean;
  tokenVersion: number;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string | null;
  createdAt: string;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string | null;
  createdAt: string;
}

export interface FamilyAuditLog {
  id: string;
  familyId: string;
  actorUserId: string;
  actorName: string;
  action: string;
  childId?: string;
  details: string;
  timestamp: string;
}

export interface SystemAuditLog {
  id: string;
  actorUserId: string;
  actorEmail: string;
  action: string;
  details: string;
  timestamp: string;
  ipAddress?: string;
}

export interface Referral {
  id: string;
  referrerUserId: string;
  referralCode: string;
  referredUserIds: string[];
  rewardStatus: string;
  createdAt: string;
  updatedAt: string;
}

export {
  Child,
  Device,
  Policy,
  PairingCode,
  AccessRequest,
  ActivityEvent,
  ChildUsageRecord,
};
