import {
  Child,
  Device,
  Policy,
  PairingCode,
  AccessRequest,
  ActivityEvent,
  ChildUsageRecord,
} from '@safebrowse/shared';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export type FamilyRole = 'OWNER' | 'PARENT' | 'VIEWER';

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
  mobileNumber?: string;
  profilePhoto?: string;
  timezone?: string;
  language?: string;
  notificationPrefs?: ParentNotificationPrefs;
  mfaEnabled?: boolean;
  mfaSecret?: string; // Encrypted with AES-256-GCM
  pendingMfaSecret?: string; // Encrypted with AES-256-GCM during setup
  mfaRecoveryCodes?: string[]; // Bcrypt-hashed recovery codes
  lastUsedTotpStep?: number; // Anti-replay TOTP counter (legacy — use totpLastUsedSteps)
  totpLastUsedSteps?: Record<string, number>; // Per-purpose TOTP timestep tracking: { [purpose]: timeStep }
  tokenVersion?: number; // Incremented on password reset to invalidate active JWTs
  emailVerified?: boolean;
  lastLoginAt?: string;
  createdAt: string;
  consentVersion?: string;
  consentTimestamp?: string;
  privacyPolicyVersion?: string;
}

/**
 * Persisted MFA challenge record — replaces in-memory consumedMfaTickets Set.
 * Stores only a hash of the JWT jti — never the raw ticket.
 */
export interface MfaChallenge {
  id: string;          // Same as ticketId embedded in the MFA JWT
  userId: string;
  jtiHash: string;     // SHA-256 hash of the JWT jti claim
  purpose: string;     // e.g. 'mfa_login'
  createdAt: string;
  expiresAt: string;
  consumedAt?: string; // Set when successfully used — cannot be reused
  invalidatedAt?: string; // Set when proactively cancelled (password reset, logout, etc.)
  attemptCount: number;   // Number of failed verification attempts
  ipAddress?: string;
  userAgent?: string;
}

export interface Family {
  id: string;
  name: string;
  ownerUserId: string;
  requireMfa: boolean;
  approvalRule: 'ANY_PARENT' | 'OWNER_ONLY';
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

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export interface FamilyInvitation {
  id: string;
  familyId: string;
  email: string;
  role: FamilyRole;
  token: string;
  expiresAt: string;
  status: InvitationStatus;
  invitedByUserId: string;
  createdAt: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface UserSession {
  id: string;
  userId: string;
  sessionFamilyId?: string; // Links refresh token family for replay attack mitigation
  refreshTokenHash: string; // Stored as SHA-256 hash
  consumedTokenHashes?: string[]; // History of consumed refresh tokens for replay attack detection
  deviceInfo: string;
  ipAddress?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isRevoked: boolean;
  tokenVersion: number;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  tokenHash: string; // SHA-256 hash of raw reset token
  expiresAt: string;
  usedAt?: string;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  email: string;
  tokenHash: string; // SHA-256 hash of raw verification token
  expiresAt: string;
  usedAt?: string;
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

export interface Referral {
  id: string;
  referrerUserId: string;
  referralCode: string;
  referredUserId?: string;
  status: 'PENDING' | 'CONVERTED';
  createdAt: string;
}

export class DataStore {
  public users: Map<string, ParentUser> = new Map();
  public families: Map<string, Family> = new Map();
  public familyMembers: Map<string, FamilyMember> = new Map();
  public familyInvitations: Map<string, FamilyInvitation> = new Map();
  public userSessions: Map<string, UserSession> = new Map();
  public passwordResetTokens: Map<string, PasswordResetToken> = new Map();
  public emailVerificationTokens: Map<string, EmailVerificationToken> = new Map();
  public mfaChallenges: Map<string, MfaChallenge> = new Map(); // Persisted MFA challenge records (replaces in-memory Set)
  public familyAuditLogs: FamilyAuditLog[] = [];
  public referrals: Map<string, Referral> = new Map();

  public children: Map<string, Child> = new Map();
  public devices: Map<string, Device> = new Map();
  public policies: Map<string, Policy> = new Map();
  public pairingCodes: Map<string, PairingCode> = new Map();
  public requests: Map<string, AccessRequest> = new Map();
  public childUsage: Map<string, ChildUsageRecord> = new Map(); // key: `${childId}:${target}:${date}`
  public activityLogs: ActivityEvent[] = [];

  private storageFile: string;

  constructor(storageDir?: string) {
    const dir = storageDir || path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
    this.storageFile = path.join(dir, 'safebrowse-db.json');
    this.load();
    this.seedDefaultDemoData();
  }

  public save() {
    try {
      const data = {
        users: Array.from(this.users.values()),
        families: Array.from(this.families.values()),
        familyMembers: Array.from(this.familyMembers.values()),
        familyInvitations: Array.from(this.familyInvitations.values()),
        userSessions: Array.from(this.userSessions.values()),
        passwordResetTokens: Array.from(this.passwordResetTokens.values()),
        emailVerificationTokens: Array.from(this.emailVerificationTokens.values()),
        // Persist MFA challenge records — keep only last 1000, prune truly expired+consumed ones
        mfaChallenges: Array.from(this.mfaChallenges.values())
          .filter((c) => !c.consumedAt || new Date(c.expiresAt).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000)
          .slice(-1000),
        familyAuditLogs: this.familyAuditLogs.slice(-1000),
        referrals: Array.from(this.referrals.values()),
        children: Array.from(this.children.values()),
        devices: Array.from(this.devices.values()),
        policies: Array.from(this.policies.values()),
        requests: Array.from(this.requests.values()),
        childUsage: Array.from(this.childUsage.values()),
        activityLogs: this.activityLogs.slice(-500),
      };
      fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
  }

  public load() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf-8');
        const data = JSON.parse(raw);
        if (data.users) {
          data.users.forEach((u: ParentUser) => {
            if (u.passwordHash && !u.passwordHash.startsWith('$2a$') && !u.passwordHash.startsWith('$2b$')) {
              u.passwordHash = bcrypt.hashSync(u.passwordHash, 10);
            }
            if (u.emailVerified === undefined) {
              u.emailVerified = true; // existing demo accounts
            }
            this.users.set(u.id, u);
          });
        }
        if (data.families) data.families.forEach((f: Family) => this.families.set(f.id, f));
        if (data.familyMembers) data.familyMembers.forEach((fm: FamilyMember) => this.familyMembers.set(fm.id, fm));
        if (data.familyInvitations) data.familyInvitations.forEach((fi: FamilyInvitation) => this.familyInvitations.set(fi.id, fi));
        if (data.userSessions) {
          data.userSessions.forEach((us: any) => {
            const session: UserSession = {
              id: us.id,
              userId: us.userId,
              sessionFamilyId: us.sessionFamilyId || us.id,
              refreshTokenHash: us.refreshTokenHash || (us.token ? crypto.createHash('sha256').update(us.token).digest('hex') : ''),
              consumedTokenHashes: Array.isArray(us.consumedTokenHashes) ? us.consumedTokenHashes : [],
              deviceInfo: us.deviceInfo || 'Unknown Device',
              ipAddress: us.ipAddress,
              createdAt: us.createdAt || new Date().toISOString(),
              lastSeenAt: us.lastSeenAt || new Date().toISOString(),
              expiresAt: us.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              isRevoked: Boolean(us.isRevoked),
              tokenVersion: us.tokenVersion || 1,
            };
            this.userSessions.set(session.id, session);
          });
        }
        if (data.passwordResetTokens) {
          data.passwordResetTokens.forEach((pr: any) => {
            this.passwordResetTokens.set(pr.id, {
              id: pr.id,
              userId: pr.userId,
              tokenHash: pr.tokenHash || (pr.token ? crypto.createHash('sha256').update(pr.token).digest('hex') : ''),
              expiresAt: pr.expiresAt,
              usedAt: pr.usedAt,
            });
          });
        }
        if (data.emailVerificationTokens) {
          data.emailVerificationTokens.forEach((ev: any) => {
            this.emailVerificationTokens.set(ev.id, {
              id: ev.id,
              userId: ev.userId,
              email: ev.email,
              tokenHash: ev.tokenHash || (ev.token ? crypto.createHash('sha256').update(ev.token).digest('hex') : ''),
              expiresAt: ev.expiresAt,
              usedAt: ev.usedAt,
            });
          });
        }
        // Load persisted MFA challenge records (survives restart — prevents replay attack after restart)
        if (data.mfaChallenges) {
          data.mfaChallenges.forEach((c: any) => {
            const challenge: MfaChallenge = {
              id: c.id,
              userId: c.userId,
              jtiHash: c.jtiHash,
              purpose: c.purpose,
              createdAt: c.createdAt,
              expiresAt: c.expiresAt,
              consumedAt: c.consumedAt,
              invalidatedAt: c.invalidatedAt,
              attemptCount: c.attemptCount || 0,
              ipAddress: c.ipAddress,
              userAgent: c.userAgent,
            };
            this.mfaChallenges.set(challenge.id, challenge);
          });
        }
        if (data.familyAuditLogs) this.familyAuditLogs = data.familyAuditLogs;
        if (data.referrals) data.referrals.forEach((r: Referral) => this.referrals.set(r.id, r));
        if (data.children) data.children.forEach((c: Child) => this.children.set(c.id, c));
        if (data.devices) data.devices.forEach((d: Device) => this.devices.set(d.id, d));
        if (data.policies) data.policies.forEach((p: Policy) => this.policies.set(p.childId, p));
        if (data.requests) data.requests.forEach((r: AccessRequest) => this.requests.set(r.id, r));
        if (data.childUsage) {
          data.childUsage.forEach((u: any) => {
            this.childUsage.set(`${u.childId}:${u.target}:${u.date}`, u);
          });
        }
        if (data.activityLogs) this.activityLogs = data.activityLogs;
      }
    } catch (e) {}
  }

  public seedDefaultDemoData() {
    const isProduction = process.env.NODE_ENV === 'production';
    const enableDemo = process.env.ENABLE_DEMO_DATA === 'true';

    // Demo data may ONLY run when ENABLE_DEMO_DATA=true and NODE_ENV is not production
    if (isProduction || !enableDemo) {
      return;
    }

    if (this.users.size === 0) {
      const demoPasswordHash = bcrypt.hashSync('password123', 10);

      const demoParent: ParentUser = {
        id: 'parent-demo-1',
        email: 'parent@safebrowse.io',
        passwordHash: demoPasswordHash,
        name: 'Sarah (Parent)',
        mobileNumber: '+1 (555) 019-2834',
        timezone: 'America/Los_Angeles',
        language: 'en-US',
        notificationPrefs: {
          emailAlerts: true,
          pushNotifications: true,
          requestAlerts: true,
          tamperAlerts: true,
          weeklySummary: true,
        },
        mfaEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      this.users.set(demoParent.id, demoParent);

      const demoFamily: Family = {
        id: 'fam-demo-1',
        name: "Sarah's Family",
        ownerUserId: demoParent.id,
        requireMfa: false,
        approvalRule: 'ANY_PARENT',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.families.set(demoFamily.id, demoFamily);

      const demoMember: FamilyMember = {
        id: 'fm-demo-1',
        familyId: demoFamily.id,
        userId: demoParent.id,
        role: 'OWNER',
        joinedAt: new Date().toISOString(),
      };
      this.familyMembers.set(demoMember.id, demoMember);

      const demoChild: Child = {
        id: 'child-demo-1',
        parentId: demoParent.id,
        name: 'Tommy',
        age: 10,
        avatar: '🧒',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.children.set(demoChild.id, demoChild);

      const demoPolicy: Policy = {
        id: 'pol-demo-1',
        childId: demoChild.id,
        version: 1,
        isPaused: false,
        rules: [
          {
            id: 'rule-1',
            domain: 'gambling.com',
            action: 'BLOCK',
            reason: 'Age-inappropriate content',
            addedAt: new Date().toISOString(),
          },
          {
            id: 'rule-2',
            domain: 'adultsite.com',
            action: 'BLOCK',
            reason: 'Adult content filter',
            addedAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      this.policies.set(demoChild.id, demoPolicy);

      this.save();
    }
  }
}

export const db = new DataStore();
