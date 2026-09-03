import { prisma } from '../db/prisma';
import {
  SystemRole,
  FamilyRole,
  FamilyMember,
  Family,
  SystemAuditLog,
  ParentUser,
} from '../types/models';
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
  public async getUserSystemRole(userId: string): Promise<SystemRole> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { systemRole: true },
    });
    return (user?.systemRole as SystemRole) || 'USER';
  }

  /**
   * Check if user has a system-level permission
   */
  public async hasSystemPermission(userId: string, permission: SystemPermission): Promise<boolean> {
    const role = await this.getUserSystemRole(userId);
    const permissions = SYSTEM_ROLE_PERMISSIONS[role];
    return permissions ? permissions.has(permission) : false;
  }

  /**
   * Check if user is a SYSTEM_ADMIN
   */
  public async isSystemAdmin(userId: string): Promise<boolean> {
    const role = await this.getUserSystemRole(userId);
    return role === 'SYSTEM_ADMIN';
  }

  /**
   * Get family membership for a specific user and family
   */
  public async getFamilyMembership(userId: string, familyId: string): Promise<FamilyMember | null> {
    const mem = await prisma.familyMember.findUnique({
      where: {
        familyId_userId: {
          familyId,
          userId,
        },
      },
    });
    if (!mem) return null;
    return {
      id: mem.id,
      familyId: mem.familyId,
      userId: mem.userId,
      role: mem.role as FamilyRole,
      joinedAt: mem.joinedAt.toISOString(),
    };
  }

  /**
   * Get all family memberships for a user
   */
  public async getUserFamilyMemberships(userId: string): Promise<FamilyMember[]> {
    const list = await prisma.familyMember.findMany({
      where: { userId },
    });
    return list.map((mem) => ({
      id: mem.id,
      familyId: mem.familyId,
      userId: mem.userId,
      role: mem.role as FamilyRole,
      joinedAt: mem.joinedAt.toISOString(),
    }));
  }

  /**
   * Get user's role in a specific family
   */
  public async getUserFamilyRole(userId: string, familyId: string): Promise<FamilyRole | null> {
    const membership = await this.getFamilyMembership(userId, familyId);
    return membership ? membership.role : null;
  }

  /**
   * Check if user has a family-level permission in a specific family
   */
  public async hasFamilyPermission(
    userId: string,
    familyId: string,
    permission: FamilyPermission
  ): Promise<boolean> {
    const role = await this.getUserFamilyRole(userId, familyId);
    if (!role) return false;

    const permissions = FAMILY_ROLE_PERMISSIONS[role];
    return permissions ? permissions.has(permission) : false;
  }

  /**
   * Resolve family for a child profile (Uses child.familyId directly; no fallbacks)
   */
  public async getFamilyForChild(childId: string): Promise<Family | null> {
    const child = await prisma.child.findUnique({
      where: { id: childId },
      include: { family: true },
    });
    if (!child || !child.family) return null;
    return {
      id: child.family.id,
      name: child.family.name,
      ownerUserId: child.family.ownerUserId,
      requireMfa: child.family.requireMfa,
      approvalRule: child.family.approvalRule as any,
      createdAt: child.family.createdAt.toISOString(),
      updatedAt: child.family.updatedAt.toISOString(),
    };
  }

  /**
   * Resolve family for a device (Uses device.familyId directly; no fallbacks)
   */
  public async getFamilyForDevice(deviceId: string): Promise<Family | null> {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: { family: true },
    });
    if (!device || !device.family) return null;
    return {
      id: device.family.id,
      name: device.family.name,
      ownerUserId: device.family.ownerUserId,
      requireMfa: device.family.requireMfa,
      approvalRule: device.family.approvalRule as any,
      createdAt: device.family.createdAt.toISOString(),
      updatedAt: device.family.updatedAt.toISOString(),
    };
  }

  /**
   * Resolve family for a policy (Uses policy.familyId directly; no fallbacks)
   */
  public async getFamilyForPolicy(childId: string): Promise<Family | null> {
    const policy = await prisma.policy.findUnique({
      where: { childId },
      include: { family: true },
    });
    if (!policy || !policy.family) return null;
    return {
      id: policy.family.id,
      name: policy.family.name,
      ownerUserId: policy.family.ownerUserId,
      requireMfa: policy.family.requireMfa,
      approvalRule: policy.family.approvalRule as any,
      createdAt: policy.family.createdAt.toISOString(),
      updatedAt: policy.family.updatedAt.toISOString(),
    };
  }

  /**
   * Resolve family for an access request (Uses req.familyId directly; no fallbacks)
   */
  public async getFamilyForRequest(requestId: string): Promise<Family | null> {
    const req = await prisma.accessRequest.findUnique({
      where: { id: requestId },
      include: { family: true },
    });
    if (!req || !req.family) return null;
    return {
      id: req.family.id,
      name: req.family.name,
      ownerUserId: req.family.ownerUserId,
      requireMfa: req.family.requireMfa,
      approvalRule: req.family.approvalRule as any,
      createdAt: req.family.createdAt.toISOString(),
      updatedAt: req.family.updatedAt.toISOString(),
    };
  }

  /**
   * Resolve family for a child usage record
   */
  public async getFamilyForUsage(childId: string): Promise<Family | null> {
    return this.getFamilyForChild(childId);
  }

  /**
   * Validate if user can approve an access request taking family approval rule into account
   */
  public async canApproveRequest(
    userId: string,
    requestId: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    const req = await prisma.accessRequest.findUnique({
      where: { id: requestId },
    });
    if (!req) {
      return { allowed: false, reason: 'Request not found.' };
    }

    const family = await this.getFamilyForRequest(requestId);
    if (!family) {
      return { allowed: false, reason: 'Family not found for this request.' };
    }

    const membership = await this.getFamilyMembership(userId, family.id);
    if (!membership) {
      return {
        allowed: false,
        reason: 'You are not a member of the family associated with this request.',
      };
    }

    // Check base permission
    const hasPerm = await this.hasFamilyPermission(userId, family.id, FamilyPermission.REQUEST_APPROVE);
    if (!hasPerm) {
      return { allowed: false, reason: 'Your family role does not permit approving access requests.' };
    }

    // If family rule is OWNER_ONLY, only OWNER can approve
    if (family.approvalRule === 'OWNER_ONLY' && membership.role !== 'OWNER') {
      return {
        allowed: false,
        reason: 'Family policy requires the Family Owner to approve access requests.',
      };
    }

    return { allowed: true };
  }

  /**
   * Record append-only system audit log for privileged administrative actions
   */
  public async logSystemAudit(
    actorUserId: string,
    action: string,
    details: string,
    ipAddress?: string
  ): Promise<SystemAuditLog> {
    const actor = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: { email: true },
    });

    const id = `syslog-${nanoid(10)}`;
    const log = await prisma.systemAuditLog.create({
      data: {
        id,
        actorUserId,
        actorEmail: actor?.email || 'unknown',
        action,
        details,
        ipAddress: ipAddress || null,
      },
    });

    return {
      id: log.id,
      actorUserId: log.actorUserId,
      actorEmail: log.actorEmail,
      action: log.action,
      details: log.details,
      timestamp: log.timestamp.toISOString(),
      ipAddress: log.ipAddress || undefined,
    };
  }

  /**
   * Get system audit logs (SYSTEM_ADMIN only)
   */
  public async getSystemAuditLogs(actorUserId: string): Promise<SystemAuditLog[]> {
    const hasPerm = await this.hasSystemPermission(actorUserId, SystemPermission.SYSTEM_AUDIT_READ);
    if (!hasPerm) {
      throw new Error('Forbidden. System administrator privilege required to view system audit logs.');
    }
    const logs = await prisma.systemAuditLog.findMany({
      orderBy: { timestamp: 'desc' },
    });
    return logs.map((log) => ({
      id: log.id,
      actorUserId: log.actorUserId,
      actorEmail: log.actorEmail,
      action: log.action,
      details: log.details,
      timestamp: log.timestamp.toISOString(),
      ipAddress: log.ipAddress || undefined,
    }));
  }

  /**
   * Development-only admin bootstrap mechanism:
   * - Unconditionally disabled in production environments
   * - Requires NODE_ENV !== 'production'
   * - Requires ENABLE_DEV_ADMIN_BOOTSTRAP === 'true'
   * - Requires valid x-admin-bootstrap-secret matching DEV_ADMIN_BOOTSTRAP_SECRET
   */
  public async bootstrapDevAdmin(userId: string, bootstrapSecret?: string): Promise<ParentUser> {
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
      throw new Error(
        'Admin bootstrap requires DEV_ADMIN_BOOTSTRAP_SECRET (min 16 chars) configured in development.'
      );
    }

    if (!bootstrapSecret || bootstrapSecret !== expectedSecret) {
      throw new Error('Forbidden: Invalid admin bootstrap secret.');
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { systemRole: 'SYSTEM_ADMIN' },
    });

    await this.logSystemAudit(
      userId,
      'DEV_ADMIN_BOOTSTRAPPED',
      `User ${updatedUser.email} promoted to SYSTEM_ADMIN via development bootstrap.`
    );

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      passwordHash: updatedUser.passwordHash,
      systemRole: updatedUser.systemRole as SystemRole,
      emailVerified: updatedUser.emailVerified,
      mfaEnabled: updatedUser.mfaEnabled,
      mfaSecret: updatedUser.mfaSecret,
      mfaRecoveryCodes: updatedUser.mfaRecoveryCodes,
      totpLastUsedSteps: updatedUser.totpLastUsedSteps as any,
      tokenVersion: updatedUser.tokenVersion,
      createdAt: updatedUser.createdAt.toISOString(),
    };
  }
}

export const rbacService = new RbacService();
