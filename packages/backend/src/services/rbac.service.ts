import { db, SystemRole, FamilyRole, FamilyMember, Family, SystemAuditLog, ParentUser } from '../db/store';
import { nanoid } from 'nanoid';

// Typed System Permissions
export enum SystemPermission {
  SYSTEM_OPERATIONS_READ = 'SYSTEM_OPERATIONS_READ',
  SYSTEM_FLEET_READ = 'SYSTEM_FLEET_READ',
  SYSTEM_ROLLBACK_EXECUTE = 'SYSTEM_ROLLBACK_EXECUTE',
  SYSTEM_SUPPORT_MANAGE = 'SYSTEM_SUPPORT_MANAGE',
  SYSTEM_AUDIT_READ = 'SYSTEM_AUDIT_READ',
}

// Typed Family Permissions
export enum FamilyPermission {
  FAMILY_SETTINGS_READ = 'FAMILY_SETTINGS_READ',
  FAMILY_SETTINGS_MANAGE = 'FAMILY_SETTINGS_MANAGE',
  FAMILY_MEMBER_INVITE = 'FAMILY_MEMBER_INVITE',
  FAMILY_MEMBER_REMOVE = 'FAMILY_MEMBER_REMOVE',
  FAMILY_ROLE_CHANGE = 'FAMILY_ROLE_CHANGE',
  FAMILY_OWNERSHIP_TRANSFER = 'FAMILY_OWNERSHIP_TRANSFER',
  CHILD_READ = 'CHILD_READ',
  CHILD_MANAGE = 'CHILD_MANAGE',
  DEVICE_READ = 'DEVICE_READ',
  DEVICE_MANAGE = 'DEVICE_MANAGE',
  POLICY_READ = 'POLICY_READ',
  POLICY_MANAGE = 'POLICY_MANAGE',
  REQUEST_READ = 'REQUEST_READ',
  REQUEST_APPROVE = 'REQUEST_APPROVE',
  USAGE_READ = 'USAGE_READ',
  USAGE_MANAGE = 'USAGE_MANAGE',
  FAMILY_AUDIT_READ = 'FAMILY_AUDIT_READ',
}

// Explicit Mapping: System Roles -> Permissions
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, Set<SystemPermission>> = {
  SYSTEM_ADMIN: new Set([
    SystemPermission.SYSTEM_OPERATIONS_READ,
    SystemPermission.SYSTEM_FLEET_READ,
    SystemPermission.SYSTEM_ROLLBACK_EXECUTE,
    SystemPermission.SYSTEM_SUPPORT_MANAGE,
    SystemPermission.SYSTEM_AUDIT_READ,
  ]),
  USER: new Set([]),
};

// Explicit Mapping: Family Roles -> Permissions
export const FAMILY_ROLE_PERMISSIONS: Record<FamilyRole, Set<FamilyPermission>> = {
  OWNER: new Set([
    FamilyPermission.FAMILY_SETTINGS_READ,
    FamilyPermission.FAMILY_SETTINGS_MANAGE,
    FamilyPermission.FAMILY_MEMBER_INVITE,
    FamilyPermission.FAMILY_MEMBER_REMOVE,
    FamilyPermission.FAMILY_ROLE_CHANGE,
    FamilyPermission.FAMILY_OWNERSHIP_TRANSFER,
    FamilyPermission.CHILD_READ,
    FamilyPermission.CHILD_MANAGE,
    FamilyPermission.DEVICE_READ,
    FamilyPermission.DEVICE_MANAGE,
    FamilyPermission.POLICY_READ,
    FamilyPermission.POLICY_MANAGE,
    FamilyPermission.REQUEST_READ,
    FamilyPermission.REQUEST_APPROVE,
    FamilyPermission.USAGE_READ,
    FamilyPermission.USAGE_MANAGE,
    FamilyPermission.FAMILY_AUDIT_READ,
  ]),
  PARENT: new Set([
    FamilyPermission.FAMILY_SETTINGS_READ,
    FamilyPermission.CHILD_READ,
    FamilyPermission.CHILD_MANAGE,
    FamilyPermission.DEVICE_READ,
    FamilyPermission.DEVICE_MANAGE,
    FamilyPermission.POLICY_READ,
    FamilyPermission.POLICY_MANAGE,
    FamilyPermission.REQUEST_READ,
    FamilyPermission.REQUEST_APPROVE,
    FamilyPermission.USAGE_READ,
    FamilyPermission.USAGE_MANAGE,
    FamilyPermission.FAMILY_AUDIT_READ,
  ]),
  VIEWER: new Set([
    FamilyPermission.FAMILY_SETTINGS_READ,
    FamilyPermission.CHILD_READ,
    FamilyPermission.DEVICE_READ,
    FamilyPermission.POLICY_READ,
    FamilyPermission.REQUEST_READ,
    FamilyPermission.USAGE_READ,
  ]),
};

export class RbacService {
  /**
   * Get user's system role (never inferred from email, family ownership, or routes)
   */
  public getUserSystemRole(userId: string): SystemRole {
    const user = db.users.get(userId);
    return user?.systemRole || 'USER';
  }

  /**
   * Check if user has a system-level permission
   */
  public hasSystemPermission(userId: string, permission: SystemPermission): boolean {
    const role = this.getUserSystemRole(userId);
    const permissions = SYSTEM_ROLE_PERMISSIONS[role];
    return permissions ? permissions.has(permission) : false;
  }

  /**
   * Check if user is a SYSTEM_ADMIN
   */
  public isSystemAdmin(userId: string): boolean {
    return this.getUserSystemRole(userId) === 'SYSTEM_ADMIN';
  }

  /**
   * Get family membership for a specific user and family
   */
  public getFamilyMembership(userId: string, familyId: string): FamilyMember | undefined {
    return Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === familyId && m.userId === userId
    );
  }

  /**
   * Get user's role in a specific family
   */
  public getUserFamilyRole(userId: string, familyId: string): FamilyRole | null {
    const membership = this.getFamilyMembership(userId, familyId);
    return membership ? membership.role : null;
  }

  /**
   * Check if user has a family-level permission in a specific family
   */
  public hasFamilyPermission(userId: string, familyId: string, permission: FamilyPermission): boolean {
    const role = this.getUserFamilyRole(userId, familyId);
    if (!role) return false;

    const permissions = FAMILY_ROLE_PERMISSIONS[role];
    return permissions ? permissions.has(permission) : false;
  }

  /**
   * Resolve family for a child profile
   */
  /**
   * Resolve family for a child profile (Uses child.familyId directly; no fallbacks)
   */
  public getFamilyForChild(childId: string): Family | undefined {
    const child = db.children.get(childId);
    if (!child || !child.familyId) return undefined;
    return db.families.get(child.familyId);
  }

  /**
   * Resolve family for a device (Uses device.familyId directly; no fallbacks)
   */
  public getFamilyForDevice(deviceId: string): Family | undefined {
    const device = db.devices.get(deviceId);
    if (!device || !device.familyId) return undefined;
    return db.families.get(device.familyId);
  }

  /**
   * Resolve family for a policy (Uses policy.familyId directly; no fallbacks)
   */
  public getFamilyForPolicy(childId: string): Family | undefined {
    const policy = db.policies.get(childId);
    if (!policy || !policy.familyId) return undefined;
    return db.families.get(policy.familyId);
  }

  /**
   * Resolve family for an access request (Uses req.familyId directly; no fallbacks)
   */
  public getFamilyForRequest(requestId: string): Family | undefined {
    const req = db.requests.get(requestId);
    if (!req || !req.familyId) return undefined;
    return db.families.get(req.familyId);
  }

  /**
   * Resolve family for a child usage record
   */
  public getFamilyForUsage(childId: string): Family | undefined {
    return this.getFamilyForChild(childId);
  }

  /**
   * Validate if user can approve an access request taking family approval rule into account
   */
  public canApproveRequest(userId: string, requestId: string): { allowed: boolean; reason?: string } {
    const req = db.requests.get(requestId);
    if (!req) {
      return { allowed: false, reason: 'Request not found.' };
    }

    const family = this.getFamilyForRequest(requestId);
    if (!family) {
      return { allowed: false, reason: 'Family not found for this request.' };
    }

    const membership = this.getFamilyMembership(userId, family.id);
    if (!membership) {
      return { allowed: false, reason: 'You are not a member of the family associated with this request.' };
    }

    // Check base permission
    if (!this.hasFamilyPermission(userId, family.id, FamilyPermission.REQUEST_APPROVE)) {
      return { allowed: false, reason: 'Your family role does not permit approving access requests.' };
    }

    // If family rule is OWNER_ONLY, only OWNER can approve
    if (family.approvalRule === 'OWNER_ONLY' && membership.role !== 'OWNER') {
      return { allowed: false, reason: 'Family policy requires the Family Owner to approve access requests.' };
    }

    return { allowed: true };
  }

  /**
   * Record append-only system audit log for privileged administrative actions
   */
  public logSystemAudit(actorUserId: string, action: string, details: string, ipAddress?: string): SystemAuditLog {
    const actor = db.users.get(actorUserId);
    const log: SystemAuditLog = {
      id: `syslog-${nanoid(10)}`,
      actorUserId,
      actorEmail: actor?.email || 'unknown',
      action,
      details,
      ipAddress,
      timestamp: new Date().toISOString(),
    };
    db.systemAuditLogs.push(log);
    db.save();
    return log;
  }

  /**
   * Get system audit logs (SYSTEM_ADMIN only)
   */
  public getSystemAuditLogs(actorUserId: string): SystemAuditLog[] {
    if (!this.hasSystemPermission(actorUserId, SystemPermission.SYSTEM_AUDIT_READ)) {
      throw new Error('Forbidden. System administrator privilege required to view system audit logs.');
    }
    return [...db.systemAuditLogs].reverse();
  }

  /**
   * Development-only admin bootstrap mechanism:
   * - Unconditionally disabled in production environments
   * - Requires NODE_ENV !== 'production'
   * - Requires ENABLE_DEV_ADMIN_BOOTSTRAP === 'true'
   * - Requires valid x-admin-bootstrap-secret matching DEV_ADMIN_BOOTSTRAP_SECRET
   */
  public bootstrapDevAdmin(userId: string, bootstrapSecret?: string): ParentUser {
    const isProduction = process.env.NODE_ENV === 'production';

    // Production MUST reject bootstrap unconditionally, even if ENABLE_DEV_ADMIN_BOOTSTRAP=true
    if (isProduction) {
      throw new Error('Admin bootstrap is strictly disabled in production environments.');
    }

    // Default behavior in every environment is disabled unless explicitly set
    const allowBootstrap = process.env.ENABLE_DEV_ADMIN_BOOTSTRAP === 'true';
    if (!allowBootstrap) {
      throw new Error('Admin bootstrap is disabled. Set ENABLE_DEV_ADMIN_BOOTSTRAP=true in development.');
    }

    const expectedSecret = process.env.DEV_ADMIN_BOOTSTRAP_SECRET;
    if (!expectedSecret || expectedSecret.trim().length < 16) {
      throw new Error('Admin bootstrap requires DEV_ADMIN_BOOTSTRAP_SECRET (min 16 chars) configured in development.');
    }

    if (!bootstrapSecret || bootstrapSecret !== expectedSecret) {
      throw new Error('Forbidden: Invalid admin bootstrap secret.');
    }

    const user = db.users.get(userId);
    if (!user) throw new Error('User not found.');

    user.systemRole = 'SYSTEM_ADMIN';
    db.users.set(userId, user);
    db.save();

    this.logSystemAudit(userId, 'DEV_ADMIN_BOOTSTRAPPED', `User ${user.email} promoted to SYSTEM_ADMIN via development bootstrap.`);
    return user;
  }
}

export const rbacService = new RbacService();
