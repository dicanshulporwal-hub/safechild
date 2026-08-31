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
  mfaRecoveryCodes?: string[]; // Hashed recovery codes
  emailVerified?: boolean;
  lastLoginAt?: string;
  createdAt: string;
  consentVersion?: string;
  consentTimestamp?: string;
  privacyPolicyVersion?: string;
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
  token: string;
  deviceInfo: string;
  ipAddress?: string;
  createdAt: string;
  lastSeenAt: string;
  isRevoked?: boolean;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  usedAt?: string;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  email: string;
  token: string;
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
        if (data.userSessions) data.userSessions.forEach((us: UserSession) => this.userSessions.set(us.id, us));
        if (data.passwordResetTokens) data.passwordResetTokens.forEach((pr: PasswordResetToken) => this.passwordResetTokens.set(pr.id, pr));
        if (data.emailVerificationTokens) data.emailVerificationTokens.forEach((ev: EmailVerificationToken) => this.emailVerificationTokens.set(ev.id, ev));
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
