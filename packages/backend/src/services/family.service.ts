import { prisma } from '../db/prisma';
import {
  Family,
  FamilyMember,
  FamilyInvitation,
  FamilyRole,
  FamilyApprovalRule,
  FamilyAuditLog,
  FatalConsistencyError,
} from '../types/models';
import { nanoid } from 'nanoid';
import crypto from 'crypto';
import { hashToken, verifyStepUpAuth } from '../utils/security';
import { rbacService, FamilyPermission } from './rbac.service';

export interface FamilyOverview {
  family: Family;
  myRole: FamilyRole;
  members: Array<{
    memberId: string;
    userId: string;
    name: string;
    email: string;
    role: FamilyRole;
    mfaEnabled: boolean;
    joinedAt: string;
    isOwner: boolean;
  }>;
  invitations: Array<Omit<FamilyInvitation, 'tokenHash'>>;
  stats: {
    childrenCount: number;
    devicesCount: number;
    parentsCount: number;
  };
}

export class FamilyService {
  /**
   * Get the primary family for a user (or auto-create if missing)
   */
  public async getOrCreateUserFamily(userId: string): Promise<Family> {
    const membership = await prisma.familyMember.findFirst({
      where: { userId },
      include: { family: true },
    });

    if (membership && membership.family) {
      return {
        id: membership.family.id,
        name: membership.family.name,
        ownerUserId: membership.family.ownerUserId,
        requireMfa: membership.family.requireMfa,
        approvalRule: membership.family.approvalRule as FamilyApprovalRule,
        createdAt: membership.family.createdAt.toISOString(),
        updatedAt: membership.family.updatedAt.toISOString(),
      };
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const familyName = user ? `${user.name.split(' ')[0]}’s Family` : 'My Family';
    const familyId = `fam-${nanoid(10)}`;

    return prisma.$transaction(async (tx) => {
      const createdFamily = await tx.family.create({
        data: {
          id: familyId,
          name: familyName,
          ownerUserId: userId,
          requireMfa: false,
          approvalRule: 'OWNER_OR_PARENT',
        },
      });

      await tx.familyMember.create({
        data: {
          id: `fm-${nanoid(10)}`,
          familyId,
          userId,
          role: 'OWNER',
        },
      });

      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId,
          actorUserId: userId,
          actorName: user?.name || 'Owner',
          action: 'FAMILY_CREATED',
          details: `Created family '${createdFamily.name}'`,
        },
      });

      return {
        id: createdFamily.id,
        name: createdFamily.name,
        ownerUserId: createdFamily.ownerUserId,
        requireMfa: createdFamily.requireMfa,
        approvalRule: createdFamily.approvalRule as FamilyApprovalRule,
        createdAt: createdFamily.createdAt.toISOString(),
        updatedAt: createdFamily.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Get complete family overview for current user
   */
  public async getFamilyOverview(userId: string, targetFamilyId?: string): Promise<FamilyOverview> {
    let family: Family;
    if (targetFamilyId) {
      const fam = await prisma.family.findUnique({ where: { id: targetFamilyId } });
      if (!fam) throw new Error('Family not found.');
      family = {
        id: fam.id,
        name: fam.name,
        ownerUserId: fam.ownerUserId,
        requireMfa: fam.requireMfa,
        approvalRule: fam.approvalRule as FamilyApprovalRule,
        createdAt: fam.createdAt.toISOString(),
        updatedAt: fam.updatedAt.toISOString(),
      };
    } else {
      const membership =
        (await prisma.familyMember.findFirst({
          where: { userId, role: 'OWNER' },
          include: { family: true },
          orderBy: { joinedAt: 'desc' },
        })) ||
        (await prisma.familyMember.findFirst({
          where: { userId },
          include: { family: true },
          orderBy: { joinedAt: 'desc' },
        }));

      if (membership && membership.family) {
        family = {
          id: membership.family.id,
          name: membership.family.name,
          ownerUserId: membership.family.ownerUserId,
          requireMfa: membership.family.requireMfa,
          approvalRule: membership.family.approvalRule as FamilyApprovalRule,
          createdAt: membership.family.createdAt.toISOString(),
          updatedAt: membership.family.updatedAt.toISOString(),
        };
      } else {
        family = await this.getOrCreateUserFamily(userId);
      }
    }

    const membersWithUsers = await prisma.familyMember.findMany({
      where: { familyId: family.id },
      include: { user: true },
    });

    const membersList = membersWithUsers.map((fm) => ({
      memberId: fm.id,
      userId: fm.user.id,
      name: fm.user.name,
      email: fm.user.email,
      role: fm.role as FamilyRole,
      mfaEnabled: Boolean(fm.user.mfaEnabled),
      joinedAt: fm.joinedAt.toISOString(),
      isOwner: family.ownerUserId === fm.user.id,
    }));

    const rawInvitations = await prisma.familyInvitation.findMany({
      where: { familyId: family.id, status: 'PENDING' },
    });

    const invitations = rawInvitations.map(({ tokenHash, ...rest }) => ({
      ...rest,
      role: rest.role as FamilyRole,
      status: rest.status as any,
      createdAt: rest.createdAt.toISOString(),
      expiresAt: rest.expiresAt.toISOString(),
      acceptedAt: rest.acceptedAt ? rest.acceptedAt.toISOString() : undefined,
      revokedAt: rest.revokedAt ? rest.revokedAt.toISOString() : undefined,
    }));

    const myMembership = membersList.find((m) => m.userId === userId);
    const myRole = myMembership ? myMembership.role : 'OWNER';

    const childrenCount = await prisma.child.count({
      where: { familyId: family.id },
    });

    const devicesCount = await prisma.device.count({
      where: { familyId: family.id },
    });

    return {
      family,
      myRole,
      members: membersList,
      invitations,
      stats: {
        childrenCount,
        devicesCount,
        parentsCount: membersList.length,
      },
    };
  }

  /**
   * Update family settings (Name, MFA Requirement, Approval Rule)
   */
  public async updateFamily(
    familyId: string,
    actorUserId: string,
    updates: { name?: string; requireMfa?: boolean; approvalRule?: 'OWNER_ONLY' | 'OWNER_OR_PARENT' }
  ): Promise<Family> {
    const membership = await rbacService.getFamilyMembership(actorUserId, familyId);
    if (!membership) {
      throw new Error('Forbidden. You do not belong to this family.');
    }

    const hasPerm = await rbacService.hasFamilyPermission(
      actorUserId,
      familyId,
      FamilyPermission.FAMILY_SETTINGS_MANAGE
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Only authorized family managers can edit family settings.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const fam = await tx.family.update({
        where: { id: familyId },
        data: {
          name: updates.name ? updates.name.trim() : undefined,
          requireMfa: updates.requireMfa !== undefined ? updates.requireMfa : undefined,
          approvalRule: updates.approvalRule ? (updates.approvalRule as any) : undefined,
        },
      });

      const actor = await tx.user.findUnique({ where: { id: actorUserId } });
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId,
          actorUserId,
          actorName: actor?.name || 'Member',
          action: 'FAMILY_UPDATED',
          details: `Updated family settings: ${JSON.stringify(updates)}`,
        },
      });

      return fam;
    });

    return {
      id: updated.id,
      name: updated.name,
      ownerUserId: updated.ownerUserId,
      requireMfa: updated.requireMfa,
      approvalRule: updated.approvalRule as FamilyApprovalRule,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Invite a co-parent or viewer
   */
  public async inviteMember(
    familyId: string,
    email: string,
    role: FamilyRole,
    invitedByUserId: string
  ): Promise<{ invitation: Omit<FamilyInvitation, 'tokenHash'>; rawToken: string }> {
    const hasPerm = await rbacService.hasFamilyPermission(
      invitedByUserId,
      familyId,
      FamilyPermission.FAMILY_MEMBER_INVITE
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Insufficient permissions to invite members to this family.');
    }

    if (role === 'OWNER') {
      throw new Error('Cannot invite a user directly as OWNER. Use ownership transfer.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check existing members
    const existingMember = await prisma.familyMember.findFirst({
      where: {
        familyId,
        user: { email: normalizedEmail },
      },
    });
    if (existingMember) {
      throw new Error('User is already a member of this family.');
    }

    const rawToken = `sb_inv_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(rawToken);
    const id = `inv-${nanoid(10)}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const created = await prisma.$transaction(async (tx) => {
      // Invalidate existing pending invites for this email
      await tx.familyInvitation.updateMany({
        where: { familyId, email: normalizedEmail, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });

      const inv = await tx.familyInvitation.create({
        data: {
          id,
          familyId,
          email: normalizedEmail,
          role: role as any,
          tokenHash,
          expiresAt,
          status: 'PENDING',
          invitedByUserId,
        },
      });

      const actor = await tx.user.findUnique({ where: { id: invitedByUserId } });
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId,
          actorUserId: invitedByUserId,
          actorName: actor?.name || 'Member',
          action: 'INVITATION_CREATED',
          details: `Invited ${normalizedEmail} as ${role}`,
        },
      });

      return inv;
    });

    return {
      invitation: {
        id: created.id,
        familyId: created.familyId,
        email: created.email,
        role: created.role as FamilyRole,
        expiresAt: created.expiresAt.toISOString(),
        status: created.status as any,
        invitedByUserId: created.invitedByUserId,
        createdAt: created.createdAt.toISOString(),
      },
      rawToken,
    };
  }

  public async inviteParent(
    familyId: string,
    invitedByUserId: string,
    email: string,
    role: FamilyRole
  ): Promise<any> {
    const res = await this.inviteMember(familyId, email, role, invitedByUserId);
    return {
      ...res.invitation,
      token: res.rawToken,
    };
  }

  public async revokeInvitation(invitationId: string, actorUserId: string): Promise<void> {
    await prisma.familyInvitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }

  /**
   * Accept an invitation (Single-use transactional claim)
   */
  public async acceptInvitation(
    rawToken: string,
    acceptingUserId: string
  ): Promise<{ familyId: string; role: FamilyRole }> {
    const tokenHash = hashToken(rawToken.trim());

    return prisma.$transaction(async (tx) => {
      const invitation = await tx.familyInvitation.findUnique({
        where: { tokenHash },
      });

      if (!invitation) {
        throw new Error('Invalid or expired invitation token.');
      }

      if (invitation.status !== 'PENDING') {
        throw new Error('This invitation has already been accepted, revoked, or expired.');
      }

      if (invitation.expiresAt.getTime() <= Date.now()) {
        await tx.familyInvitation.update({
          where: { id: invitation.id },
          data: { status: 'EXPIRED' },
        });
        throw new Error('This invitation has expired.');
      }

      const acceptingUser = await tx.user.findUnique({
        where: { id: acceptingUserId },
      });
      if (!acceptingUser) throw new Error('User not found.');

      // Check existing membership
      const existing = await tx.familyMember.findUnique({
        where: {
          familyId_userId: {
            familyId: invitation.familyId,
            userId: acceptingUserId,
          },
        },
      });
      if (existing) {
        throw new Error('You are already a member of this family.');
      }

      // Mark invitation accepted
      await tx.familyInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      });

      // Add family membership
      await tx.familyMember.create({
        data: {
          id: `fm-${nanoid(10)}`,
          familyId: invitation.familyId,
          userId: acceptingUserId,
          role: invitation.role,
        },
      });

      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: invitation.familyId,
          actorUserId: acceptingUserId,
          actorName: acceptingUser.name,
          action: 'INVITATION_ACCEPTED',
          details: `${acceptingUser.name} (${acceptingUser.email}) joined family as ${invitation.role}`,
        },
      });

      return {
        familyId: invitation.familyId,
        role: invitation.role as FamilyRole,
      };
    });
  }

  /**
   * Remove member from family
   */
  public async removeMember(familyId: string, memberIdOrUserId: string, actorUserId: string): Promise<void> {
    const family = await prisma.family.findUnique({ where: { id: familyId } });
    if (!family) throw new Error('Family not found.');

    const memberRecord = await prisma.familyMember.findFirst({
      where: {
        familyId,
        OR: [{ id: memberIdOrUserId }, { userId: memberIdOrUserId }],
      },
      include: { user: true },
    });

    if (!memberRecord) {
      throw new Error('User is not a member of this family.');
    }

    const isSelfRemoval = memberRecord.userId === actorUserId;

    if (!isSelfRemoval) {
      const hasPerm = await rbacService.hasFamilyPermission(
        actorUserId,
        familyId,
        FamilyPermission.FAMILY_MEMBER_REMOVE
      );
      if (!hasPerm) {
        throw new Error('Forbidden. Insufficient permissions to remove members from this family.');
      }
    }

    if (family.ownerUserId === memberRecord.userId || memberRecord.role === 'OWNER') {
      throw new Error('Cannot remove the Family Owner. Transfer ownership before leaving or removing owner.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.familyMember.delete({
        where: { id: memberRecord.id },
      });

      const actor = await tx.user.findUnique({ where: { id: actorUserId } });
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId,
          actorUserId,
          actorName: actor?.name || 'Member',
          action: isSelfRemoval ? 'MEMBER_LEFT' : 'MEMBER_REMOVED',
          details: isSelfRemoval
            ? `${memberRecord.user.name} left the family.`
            : `Removed ${memberRecord.user.name} (${memberRecord.user.email}) from family.`,
        },
      });
    });
  }

  /**
   * Change member role
   */
  public async changeMemberRole(
    familyId: string,
    targetUserId: string,
    newRole: FamilyRole,
    actorUserId: string
  ): Promise<void> {
    const hasPerm = await rbacService.hasFamilyPermission(
      actorUserId,
      familyId,
      FamilyPermission.FAMILY_ROLE_CHANGE
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Only Family Owners can change member roles.');
    }

    if (newRole === 'OWNER') {
      throw new Error('Cannot assign OWNER role via changeMemberRole. Use transferOwnership.');
    }

    const family = await prisma.family.findUnique({ where: { id: familyId } });
    if (!family) throw new Error('Family not found.');

    if (family.ownerUserId === targetUserId) {
      throw new Error('Cannot change the role of the Family Owner. Transfer ownership first.');
    }

    await prisma.$transaction(async (tx) => {
      const member = await tx.familyMember.findUnique({
        where: {
          familyId_userId: {
            familyId,
            userId: targetUserId,
          },
        },
        include: { user: true },
      });

      if (!member) throw new Error('Target user is not a member of this family.');

      await tx.familyMember.update({
        where: { id: member.id },
        data: { role: newRole as any },
      });

      const actor = await tx.user.findUnique({ where: { id: actorUserId } });
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId,
          actorUserId,
          actorName: actor?.name || 'Owner',
          action: 'ROLE_CHANGED',
          details: `Changed role of ${member.user.name} to ${newRole}`,
        },
      });
    });
  }

  /**
   * Transfer Family Ownership with Single-Owner Invariant, Step-Up Auth Replay Protection & Row Lock
   */
  public async transferOwnership(
    familyId: string,
    newOwnerUserId: string,
    currentOwnerUserId: string,
    password?: string,
    otpCode?: string,
    timeSec?: number
  ): Promise<void> {
    return prisma.$transaction(async (tx) => {
      // 1. Row-level locking to serialize concurrent transactions
      const lockedFamilies: any[] = await tx.$queryRaw`SELECT * FROM "Family" WHERE "id" = ${familyId} FOR UPDATE`;
      if (!lockedFamilies || lockedFamilies.length === 0) {
        throw new Error('Family not found.');
      }
      const family = lockedFamilies[0];

      if (family.ownerUserId !== currentOwnerUserId) {
        throw new Error('Forbidden. Only the current Family Owner can transfer ownership.');
      }

      if (newOwnerUserId === currentOwnerUserId) {
        throw new Error('Cannot transfer ownership to yourself.');
      }

      // 2. Validate target member
      const newOwnerMembership = await tx.familyMember.findUnique({
        where: {
          familyId_userId: {
            familyId,
            userId: newOwnerUserId,
          },
        },
      });
      if (!newOwnerMembership) {
        throw new Error('Target user is not a member of this family.');
      }

      // 3. Step-up authentication
      const currentOwner = await tx.user.findUnique({ where: { id: currentOwnerUserId } });
      if (!currentOwner) throw new Error('Current owner user not found.');

      if (!password) {
        throw new Error('Step-up authentication required: password must be provided.');
      }

      const stepUp = verifyStepUpAuth(currentOwner as any, password, otpCode, timeSec);

      // 4. Atomically consume recovery code or record accepted TOTP timestep
      const updatedRecoveryCodes = [...(currentOwner.mfaRecoveryCodes || [])];
      const updatedTotpLastUsed = (currentOwner.totpLastUsedSteps as any)
        ? { ...(currentOwner.totpLastUsedSteps as any) }
        : {};

      if (stepUp.method === 'TOTP' && stepUp.totpTimeStep !== undefined) {
        const lastUsed = updatedTotpLastUsed['family_ownership_transfer'];
        if (lastUsed !== undefined && lastUsed === stepUp.totpTimeStep) {
          throw new Error(
            'This TOTP code has already been used for ownership transfer. Please wait for the next code.'
          );
        }
        updatedTotpLastUsed['family_ownership_transfer'] = stepUp.totpTimeStep;
      } else if (stepUp.method === 'RECOVERY_CODE' && stepUp.recoveryCodeIndex !== undefined) {
        updatedRecoveryCodes.splice(stepUp.recoveryCodeIndex, 1);
      }

      await tx.user.update({
        where: { id: currentOwnerUserId },
        data: {
          mfaRecoveryCodes: updatedRecoveryCodes,
          totpLastUsedSteps: updatedTotpLastUsed,
        },
      });

      // 5. Demote previous OWNER to PARENT
      await tx.familyMember.update({
        where: {
          familyId_userId: {
            familyId,
            userId: currentOwnerUserId,
          },
        },
        data: { role: 'PARENT' },
      });

      // 6. Promote target member to OWNER (PostgreSQL partial unique index + trigger enforce single-owner)
      await tx.familyMember.update({
        where: {
          familyId_userId: {
            familyId,
            userId: newOwnerUserId,
          },
        },
        data: { role: 'OWNER' },
      });

      // 7. Update Family.ownerUserId
      await tx.family.update({
        where: { id: familyId },
        data: {
          ownerUserId: newOwnerUserId,
          updatedAt: new Date(),
        },
      });

      // 8. Insert ownership-transfer audit event
      const newOwner = await tx.user.findUnique({ where: { id: newOwnerUserId } });
      const auditLogId = `log-${nanoid(10)}`;
      await tx.familyAuditLog.create({
        data: {
          id: auditLogId,
          familyId,
          actorUserId: currentOwnerUserId,
          actorName: currentOwner.name || 'Owner',
          action: 'OWNERSHIP_TRANSFERRED',
          details: `Transferred family ownership to ${newOwner?.name || 'Parent'} (${newOwner?.email || ''})`,
        },
      });

      // 9. Strict invariant check: exactly one OWNER in PostgreSQL
      const ownerCount = await tx.familyMember.count({
        where: {
          familyId,
          role: 'OWNER',
        },
      });
      if (ownerCount !== 1) {
        throw new FatalConsistencyError('FATAL: Ownership invariant violation: multiple or zero owners detected.');
      }
    });
  }

  public async logAudit(
    familyId: string,
    actorUserId: string,
    actorName: string,
    action: string,
    details: string,
    childId?: string
  ): Promise<FamilyAuditLog> {
    const entry = await prisma.familyAuditLog.create({
      data: {
        id: `log-${nanoid(10)}`,
        familyId,
        actorUserId,
        actorName,
        action,
        childId: childId || null,
        details,
      },
    });
    return {
      id: entry.id,
      familyId: entry.familyId,
      actorUserId: entry.actorUserId,
      actorName: entry.actorName,
      action: entry.action,
      childId: entry.childId || undefined,
      details: entry.details,
      timestamp: entry.timestamp.toISOString(),
    };
  }

  public async getAuditLogs(familyId: string, actorUserId: string): Promise<FamilyAuditLog[]> {
    const hasPerm = await rbacService.hasFamilyPermission(
      actorUserId,
      familyId,
      FamilyPermission.FAMILY_AUDIT_READ
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Insufficient permissions to view family audit logs.');
    }

    const logs = await prisma.familyAuditLog.findMany({
      where: { familyId },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    return logs.map((log) => ({
      id: log.id,
      familyId: log.familyId,
      actorUserId: log.actorUserId,
      actorName: log.actorName,
      action: log.action,
      childId: log.childId || undefined,
      details: log.details,
      timestamp: log.timestamp.toISOString(),
    }));
  }
}

export const familyService = new FamilyService();
