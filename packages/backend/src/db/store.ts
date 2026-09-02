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

export type SystemRole = 'SYSTEM_ADMIN' | 'USER';
export type FamilyRole = 'OWNER' | 'PARENT' | 'VIEWER';

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

export interface FamilySnapshot {
  familyId: string;
  family?: Family;
  members: FamilyMember[];
  invitations: FamilyInvitation[];
  auditLogs: FamilyAuditLog[];
  affectedUsers: ParentUser[];
  children: Child[];
  devices: Device[];
  policies: Policy[];
  requests: AccessRequest[];
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
  systemRole?: SystemRole; // SYSTEM_ADMIN or USER (defaults to USER)
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
  approvalRule: 'OWNER_ONLY' | 'OWNER_OR_PARENT';
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
  tokenHash: string; // SHA-256 hash of raw invitation token
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

export interface SystemAuditLog {
  id: string;
  actorUserId: string;
  actorEmail: string;
  action: string;
  details: string;
  ipAddress?: string;
  timestamp: string;
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
  public systemAuditLogs: SystemAuditLog[] = [];
  public referrals: Map<string, Referral> = new Map();

  public children: Map<string, Child> = new Map();
  public devices: Map<string, Device> = new Map();
  public policies: Map<string, Policy> = new Map();
  public pairingCodes: Map<string, PairingCode> = new Map();
  public requests: Map<string, AccessRequest> = new Map();
  public childUsage: Map<string, ChildUsageRecord> = new Map(); // key: `${childId}:${target}:${date}`
  public activityLogs: ActivityEvent[] = [];

  private storageFile: string;
  private backupFile: string;
  public _simulateSaveFailure: boolean = false;

  constructor(storageDir?: string) {
    const dir = storageDir || path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err: any) {
        throw new DataLoadError(`FATAL: Cannot initialize storage directory: ${err?.code || 'I/O error'}`, err);
      }
    }
    this.storageFile = path.join(dir, 'safebrowse-db.json');
    this.backupFile = path.join(dir, 'safebrowse-db.json.bak');
    this.load();
    this.seedDefaultDemoData();
  }

  public save(): void {
    if (this._simulateSaveFailure) {
      throw new DataPersistenceError('Simulated storage persistence failure');
    }

    let tempFile: string | null = null;
    let fd: number | null = null;
    try {
      const data = {
        users: Array.from(this.users.values()),
        families: Array.from(this.families.values()),
        familyMembers: Array.from(this.familyMembers.values()),
        familyInvitations: Array.from(this.familyInvitations.values()),
        userSessions: Array.from(this.userSessions.values()),
        passwordResetTokens: Array.from(this.passwordResetTokens.values()),
        emailVerificationTokens: Array.from(this.emailVerificationTokens.values()),
        mfaChallenges: Array.from(this.mfaChallenges.values())
          .filter((c) => !c.consumedAt || new Date(c.expiresAt).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000)
          .slice(-1000),
        familyAuditLogs: this.familyAuditLogs.slice(-1000),
        systemAuditLogs: this.systemAuditLogs.slice(-1000),
        referrals: Array.from(this.referrals.values()),
        children: Array.from(this.children.values()),
        devices: Array.from(this.devices.values()),
        policies: Array.from(this.policies.values()),
        requests: Array.from(this.requests.values()),
        childUsage: Array.from(this.childUsage.values()),
        activityLogs: this.activityLogs.slice(-500),
      };

      const serialized = JSON.stringify(data, null, 2);
      JSON.parse(serialized);

      const dir = path.dirname(this.storageFile);
      tempFile = path.join(dir, `safebrowse-db.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);

      fd = fs.openSync(tempFile, 'w');
      fs.writeFileSync(fd, serialized, 'utf-8');
      try {
        fs.fsyncSync(fd);
      } catch {}
      fs.closeSync(fd);
      fd = null;

      if (fs.existsSync(this.storageFile)) {
        try {
          fs.copyFileSync(this.storageFile, this.backupFile);
        } catch {
          console.warn('[DataStore] Notice: Failed to update last-known-good backup.');
        }
      }

      // Windows-safe atomic rename with retry backoff and atomic copy fallback
      let renamed = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.renameSync(tempFile, this.storageFile);
          renamed = true;
          break;
        } catch (rErr: any) {
          if (attempt === 9 || (rErr.code !== 'EPERM' && rErr.code !== 'EBUSY')) {
            try {
              fs.copyFileSync(tempFile, this.storageFile);
              try { fs.unlinkSync(tempFile); } catch {}
              renamed = true;
              break;
            } catch {
              throw rErr;
            }
          }
          const end = Date.now() + 15;
          while (Date.now() < end) {}
        }
      }
      tempFile = null;
    } catch (err: any) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (tempFile && fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      const redactedCode = err?.code ? `(code: ${err.code})` : '';
      console.error(`[DataStore] Operational persistence failure ${redactedCode}`);
      throw new DataPersistenceError(`Failed to persist datastore: Operational persistence failure`, err);
    }
  }

  public load(): void {
    if (!fs.existsSync(this.storageFile)) {
      return;
    }

    let raw: string;
    let data: any;

    try {
      raw = fs.readFileSync(this.storageFile, 'utf-8');
      data = JSON.parse(raw);
    } catch (readErr: any) {
      console.warn('[DataStore] Primary storage corrupted or unreadable. Attempting backup recovery...');
      if (fs.existsSync(this.backupFile)) {
        try {
          raw = fs.readFileSync(this.backupFile, 'utf-8');
          data = JSON.parse(raw);
          fs.copyFileSync(this.backupFile, this.storageFile);
          console.info('[DataStore] Successfully recovered datastore from last-known-good backup.');
        } catch (bakErr: any) {
          throw new DataLoadError('FATAL: Primary datastore corrupted and backup recovery failed.', bakErr);
        }
      } else {
        throw new DataLoadError('FATAL: Primary datastore corrupted and no backup file exists.', readErr);
      }
    }

    try {
      if (data.users) {
        data.users.forEach((u: ParentUser) => {
          if (u.passwordHash && !u.passwordHash.startsWith('$2a$') && !u.passwordHash.startsWith('$2b$')) {
            u.passwordHash = bcrypt.hashSync(u.passwordHash, 10);
          }
          if (u.emailVerified === undefined) {
            u.emailVerified = true;
          }
          this.users.set(u.id, u);
        });
      }
      if (data.families) data.families.forEach((f: Family) => this.families.set(f.id, f));
      if (data.familyMembers) data.familyMembers.forEach((fm: FamilyMember) => this.familyMembers.set(fm.id, fm));
      if (data.familyInvitations) {
        data.familyInvitations.forEach((fi: any) => {
          const invitation: FamilyInvitation = {
            id: fi.id,
            familyId: fi.familyId,
            email: fi.email,
            role: fi.role,
            tokenHash: fi.tokenHash || (fi.token ? crypto.createHash('sha256').update(fi.token).digest('hex') : ''),
            expiresAt: fi.expiresAt,
            status: fi.status,
            invitedByUserId: fi.invitedByUserId,
            createdAt: fi.createdAt,
            acceptedAt: fi.acceptedAt,
            revokedAt: fi.revokedAt,
          };
          this.familyInvitations.set(invitation.id, invitation);
        });
      }
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
      if (data.systemAuditLogs) this.systemAuditLogs = data.systemAuditLogs;
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

      if (process.env.NODE_ENV === 'production') {
        const unmigratedChildren = Array.from(this.children.values()).filter((c) => !c.familyId || !this.families.has(c.familyId));
        const unmigratedDevices = Array.from(this.devices.values()).filter((d) => !d.familyId || !this.families.has(d.familyId));
        const unmigratedPolicies = Array.from(this.policies.values()).filter((p) => !p.familyId || !this.families.has(p.familyId));
        const unmigratedRequests = Array.from(this.requests.values()).filter((r) => !r.familyId || !this.families.has(r.familyId));

        if (
          unmigratedChildren.length > 0 ||
          unmigratedDevices.length > 0 ||
          unmigratedPolicies.length > 0 ||
          unmigratedRequests.length > 0
        ) {
          throw new DataLoadError(
            'FATAL: Unresolved family tenancy records detected in production datastore. ' +
            'Run scripts/migrate-family-tenancy.ts before starting production server.'
          );
        }
      }
    } catch (e: any) {
      if (e instanceof DataLoadError) throw e;
      throw new DataLoadError('FATAL: Failed to parse and load datastore structures.', e);
    }
  }

  private familyLocks: Map<string, Promise<void>> = new Map();

  public async runWithFamilyLock<T>(familyId: string, fn: () => Promise<T> | T): Promise<T> {
    while (this.familyLocks.has(familyId)) {
      await this.familyLocks.get(familyId);
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.familyLocks.set(familyId, lockPromise);

    try {
      return await fn();
    } finally {
      this.familyLocks.delete(familyId);
      resolveLock();
    }
  }

  public createFamilySnapshot(familyId: string, affectedUserIds: string[] = []): FamilySnapshot {
    const fam = this.families.get(familyId);
    const members = Array.from(this.familyMembers.values()).filter((m) => m.familyId === familyId);
    const invitations = Array.from(this.familyInvitations.values()).filter((i) => i.familyId === familyId);
    const auditLogs = this.familyAuditLogs.filter((a) => a.familyId === familyId);
    const affectedUsers = affectedUserIds
      .map((uid) => this.users.get(uid))
      .filter((u): u is ParentUser => Boolean(u));
    const children = Array.from(this.children.values()).filter((c) => c.familyId === familyId);
    const devices = Array.from(this.devices.values()).filter((d) => d.familyId === familyId);
    const policies = Array.from(this.policies.values()).filter((p) => p.familyId === familyId);
    const requests = Array.from(this.requests.values()).filter((r) => r.familyId === familyId);

    return JSON.parse(
      JSON.stringify({
        familyId,
        family: fam,
        members,
        invitations,
        auditLogs,
        affectedUsers,
        children,
        devices,
        policies,
        requests,
      })
    );
  }

  public restoreFamilySnapshot(snapshot: FamilySnapshot): void {
    const { familyId } = snapshot;

    if (snapshot.family) {
      this.families.set(familyId, JSON.parse(JSON.stringify(snapshot.family)));
    } else {
      this.families.delete(familyId);
    }

    for (const [mid, m] of this.familyMembers.entries()) {
      if (m.familyId === familyId) {
        this.familyMembers.delete(mid);
      }
    }
    for (const m of snapshot.members) {
      this.familyMembers.set(m.id, JSON.parse(JSON.stringify(m)));
    }

    for (const [iid, inv] of this.familyInvitations.entries()) {
      if (inv.familyId === familyId) {
        this.familyInvitations.delete(iid);
      }
    }
    for (const inv of snapshot.invitations) {
      this.familyInvitations.set(inv.id, JSON.parse(JSON.stringify(inv)));
    }

    this.familyAuditLogs = [
      ...this.familyAuditLogs.filter((a) => a.familyId !== familyId),
      ...JSON.parse(JSON.stringify(snapshot.auditLogs)),
    ];

    for (const u of snapshot.affectedUsers) {
      this.users.set(u.id, JSON.parse(JSON.stringify(u)));
    }

    for (const [cid, c] of this.children.entries()) {
      if (c.familyId === familyId) {
        this.children.delete(cid);
      }
    }
    for (const c of snapshot.children) {
      this.children.set(c.id, JSON.parse(JSON.stringify(c)));
    }

    for (const [did, d] of this.devices.entries()) {
      if (d.familyId === familyId) {
        this.devices.delete(did);
      }
    }
    for (const d of snapshot.devices) {
      this.devices.set(d.id, JSON.parse(JSON.stringify(d)));
    }

    for (const [pid, p] of this.policies.entries()) {
      if (p.familyId === familyId) {
        this.policies.delete(pid);
      }
    }
    for (const p of snapshot.policies) {
      this.policies.set(p.childId, JSON.parse(JSON.stringify(p)));
    }

    for (const [rid, r] of this.requests.entries()) {
      if (r.familyId === familyId) {
        this.requests.delete(rid);
      }
    }
    for (const r of snapshot.requests) {
      this.requests.set(r.id, JSON.parse(JSON.stringify(r)));
    }

    try {
      this.save();
    } catch {}
  }

  public createSnapshot(): string {
    return JSON.stringify({
      users: Array.from(this.users.entries()),
      families: Array.from(this.families.entries()),
      familyMembers: Array.from(this.familyMembers.entries()),
      familyInvitations: Array.from(this.familyInvitations.entries()),
      familyAuditLogs: [...this.familyAuditLogs],
      systemAuditLogs: [...this.systemAuditLogs],
      children: Array.from(this.children.entries()),
      devices: Array.from(this.devices.entries()),
      policies: Array.from(this.policies.entries()),
      requests: Array.from(this.requests.entries()),
    });
  }

  public restoreSnapshot(snapshotJson: string): void {
    const data = JSON.parse(snapshotJson);
    this.users = new Map(data.users);
    this.families = new Map(data.families);
    this.familyMembers = new Map(data.familyMembers);
    this.familyInvitations = new Map(data.familyInvitations);
    this.familyAuditLogs = data.familyAuditLogs;
    this.systemAuditLogs = data.systemAuditLogs;
    this.children = new Map(data.children);
    this.devices = new Map(data.devices);
    this.policies = new Map(data.policies);
    this.requests = new Map(data.requests);
    try {
      this.save();
    } catch {}
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
        approvalRule: 'OWNER_OR_PARENT',
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
        familyId: demoFamily.id,
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
        familyId: demoFamily.id,
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
