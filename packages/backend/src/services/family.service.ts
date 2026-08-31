import { db, Family, FamilyMember, FamilyInvitation, FamilyRole, FamilyAuditLog } from '../db/store';
import { nanoid } from 'nanoid';
import crypto from 'crypto';
import { wsManager } from './websocket.service';

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
  invitations: FamilyInvitation[];
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
  public getOrCreateUserFamily(userId: string): Family {
    // Look up membership
    const membership = Array.from(db.familyMembers.values()).find((m) => m.userId === userId);
    if (membership) {
      const fam = db.families.get(membership.familyId);
      if (fam) return fam;
    }

    const user = db.users.get(userId);
    const familyName = user ? `${user.name.split(' ')[0]}’s Family` : 'My Family';

    const familyId = `fam-${nanoid(10)}`;
    const now = new Date().toISOString();

    const newFamily: Family = {
      id: familyId,
      name: familyName,
      ownerUserId: userId,
      requireMfa: false,
      approvalRule: 'ANY_PARENT',
      createdAt: now,
      updatedAt: now,
    };

    db.families.set(familyId, newFamily);

    const member: FamilyMember = {
      id: `fm-${nanoid(10)}`,
      familyId,
      userId,
      role: 'OWNER',
      joinedAt: now,
    };

    db.familyMembers.set(member.id, member);
    db.save();

    this.logAudit(familyId, userId, user?.name || 'Owner', 'FAMILY_CREATED', `Created family '${newFamily.name}'`);
    return newFamily;
  }

  /**
   * Get complete family overview for current user
   */
  public getFamilyOverview(userId: string): FamilyOverview {
    const family = this.getOrCreateUserFamily(userId);
    const membersList: FamilyOverview['members'] = [];

    for (const fm of db.familyMembers.values()) {
      if (fm.familyId === family.id) {
        const u = db.users.get(fm.userId);
        if (u) {
          membersList.push({
            memberId: fm.id,
            userId: u.id,
            name: u.name,
            email: u.email,
            role: fm.role,
            mfaEnabled: Boolean(u.mfaEnabled),
            joinedAt: fm.joinedAt,
            isOwner: family.ownerUserId === u.id,
          });
        }
      }
    }

    const invitations = Array.from(db.familyInvitations.values()).filter(
      (inv) => inv.familyId === family.id && inv.status === 'PENDING'
    );

    const myMembership = membersList.find((m) => m.userId === userId);
    const myRole = myMembership ? myMembership.role : 'OWNER';

    const children = Array.from(db.children.values()).filter((c) => c.parentId === family.ownerUserId);
    const childIds = children.map((c) => c.id);
    const devices = Array.from(db.devices.values()).filter((d) => childIds.includes(d.childId));

    return {
      family,
      myRole,
      members: membersList,
      invitations,
      stats: {
        childrenCount: children.length,
        devicesCount: devices.length,
        parentsCount: membersList.length,
      },
    };
  }

  /**
   * Update family settings
   */
  public updateFamily(
    familyId: string,
    actorUserId: string,
    updates: { name?: string; requireMfa?: boolean; approvalRule?: 'ANY_PARENT' | 'OWNER_ONLY' }
  ): Family {
    const family = db.families.get(familyId);
    if (!family) throw new Error('Family not found.');

    const membership = Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === familyId && m.userId === actorUserId
    );
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'PARENT')) {
      throw new Error('Forbidden. Only authorized parents can edit family settings.');
    }

    if (updates.name) family.name = updates.name.trim();
    if (typeof updates.requireMfa === 'boolean') {
      if (membership.role !== 'OWNER') throw new Error('Only the Family Owner can enforce MFA requirements.');
      family.requireMfa = updates.requireMfa;
    }
    if (updates.approvalRule) family.approvalRule = updates.approvalRule;

    family.updatedAt = new Date().toISOString();
    db.families.set(familyId, family);
    db.save();

    const actor = db.users.get(actorUserId);
    this.logAudit(familyId, actorUserId, actor?.name || 'Parent', 'FAMILY_SETTINGS_UPDATED', `Updated family settings`);
    return family;
  }

  /**
   * Invite a Co-Parent to the Family
   */
  public inviteParent(
    familyId: string,
    actorUserId: string,
    email: string,
    role: FamilyRole = 'PARENT'
  ): FamilyInvitation {
    const family = db.families.get(familyId);
    if (!family) throw new Error('Family not found.');

    const membership = Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === familyId && m.userId === actorUserId
    );
    if (!membership || membership.role !== 'OWNER') {
      throw new Error('Forbidden. Only the Family Owner can invite new co-parents.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user is already a member
    const existingMember = Array.from(db.familyMembers.values()).find((m) => {
      if (m.familyId === familyId) {
        const u = db.users.get(m.userId);
        return u?.email.toLowerCase() === normalizedEmail;
      }
      return false;
    });
    if (existingMember) {
      throw new Error('User is already a member of this family.');
    }

    const token = `inv_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48 hours

    const invitation: FamilyInvitation = {
      id: `inv-${nanoid(10)}`,
      familyId,
      email: normalizedEmail,
      role,
      token,
      expiresAt,
      status: 'PENDING',
      invitedByUserId: actorUserId,
      createdAt: new Date().toISOString(),
    };

    db.familyInvitations.set(invitation.id, invitation);
    db.save();

    const actor = db.users.get(actorUserId);
    this.logAudit(
      familyId,
      actorUserId,
      actor?.name || 'Owner',
      'COPARENT_INVITED',
      `Invited '${normalizedEmail}' as ${role}`
    );

    return invitation;
  }

  /**
   * Accept an Invitation to join a family
   */
  public acceptInvitation(token: string, acceptingUserId: string): { family: Family; role: FamilyRole } {
    const cleanToken = token.trim();
    const invitation = Array.from(db.familyInvitations.values()).find(
      (inv) => inv.token === cleanToken && inv.status === 'PENDING'
    );

    if (!invitation) {
      throw new Error('Invalid or expired invitation link.');
    }

    if (new Date() > new Date(invitation.expiresAt)) {
      invitation.status = 'EXPIRED';
      db.familyInvitations.set(invitation.id, invitation);
      db.save();
      throw new Error('This invitation has expired.');
    }

    const family = db.families.get(invitation.familyId);
    if (!family) throw new Error('Family no longer exists.');

    const user = db.users.get(acceptingUserId);
    if (!user) throw new Error('User account not found.');

    // Strict Email Binding Check
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new Error('INVITATION_EMAIL_MISMATCH: This invitation was issued for a different email address.');
    }

    // Add as member
    const memberId = `fm-${nanoid(10)}`;
    const member: FamilyMember = {
      id: memberId,
      familyId: family.id,
      userId: acceptingUserId,
      role: invitation.role,
      joinedAt: new Date().toISOString(),
    };

    db.familyMembers.set(memberId, member);

    // Clean up empty auto-created initial family if present
    for (const [fmId, fm] of db.familyMembers.entries()) {
      if (fm.userId === acceptingUserId && fm.familyId !== family.id) {
        const otherFam = db.families.get(fm.familyId);
        if (otherFam && otherFam.ownerUserId === acceptingUserId) {
          const hasKids = Array.from(db.children.values()).some((c) => c.parentId === acceptingUserId);
          if (!hasKids) {
            db.familyMembers.delete(fmId);
            db.families.delete(otherFam.id);
          }
        }
      }
    }

    invitation.status = 'ACCEPTED';
    invitation.acceptedAt = new Date().toISOString();
    db.familyInvitations.set(invitation.id, invitation);
    db.save();

    this.logAudit(
      family.id,
      acceptingUserId,
      user.name,
      'COPARENT_JOINED',
      `${user.name} (${user.email}) accepted invitation and joined as ${invitation.role}`
    );

    return { family, role: invitation.role };
  }

  /**
   * Revoke an Invitation
   */
  public revokeInvitation(invitationId: string, actorUserId: string) {
    const invitation = db.familyInvitations.get(invitationId);
    if (!invitation) throw new Error('Invitation not found.');

    const family = db.families.get(invitation.familyId);
    if (!family || family.ownerUserId !== actorUserId) {
      throw new Error('Forbidden. Only the Family Owner can revoke invitations.');
    }

    invitation.status = 'REVOKED';
    invitation.revokedAt = new Date().toISOString();
    db.familyInvitations.set(invitation.id, invitation);
    db.save();

    const actor = db.users.get(actorUserId);
    this.logAudit(family.id, actorUserId, actor?.name || 'Owner', 'INVITATION_REVOKED', `Revoked invitation for '${invitation.email}'`);
  }

  /**
   * Remove a Co-Parent Member
   */
  public removeMember(familyId: string, memberId: string, actorUserId: string) {
    const family = db.families.get(familyId);
    if (!family) throw new Error('Family not found.');

    if (family.ownerUserId !== actorUserId) {
      throw new Error('Forbidden. Only the Family Owner can remove members.');
    }

    const member = db.familyMembers.get(memberId);
    if (!member || member.familyId !== familyId) {
      throw new Error('Member not found in this family.');
    }

    if (member.userId === family.ownerUserId) {
      throw new Error('Cannot remove the Family Owner. Please transfer ownership first.');
    }

    const removedUser = db.users.get(member.userId);
    db.familyMembers.delete(memberId);
    db.save();

    const actor = db.users.get(actorUserId);
    this.logAudit(
      familyId,
      actorUserId,
      actor?.name || 'Owner',
      'MEMBER_REMOVED',
      `Removed member ${removedUser?.name || 'Parent'} (${removedUser?.email || ''})`
    );
  }

  /**
   * Transfer Family Ownership with Single-Owner Invariant & Step-Up Auth
   */
  public transferOwnership(
    familyId: string,
    newOwnerUserId: string,
    currentOwnerUserId: string,
    password?: string,
    otpCode?: string
  ) {
    const family = db.families.get(familyId);
    if (!family) throw new Error('Family not found.');

    if (family.ownerUserId !== currentOwnerUserId) {
      throw new Error('Forbidden. Only the current Family Owner can transfer ownership.');
    }

    if (newOwnerUserId === currentOwnerUserId) {
      throw new Error('Cannot transfer ownership to yourself.');
    }

    const currentOwner = db.users.get(currentOwnerUserId);
    if (!currentOwner) throw new Error('Current owner user not found.');

    // Step-up authentication if credentials provided
    if (password) {
      const { verifyStepUpAuth } = require('../utils/security');
      verifyStepUpAuth(currentOwner, password, otpCode);
    }

    const newOwnerMembership = Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === familyId && m.userId === newOwnerUserId
    );
    if (!newOwnerMembership) {
      throw new Error('Target user is not a member of this family.');
    }

    // Atomic compare-and-swap
    const oldOwnerMembership = Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === familyId && m.userId === currentOwnerUserId
    );
    if (oldOwnerMembership) {
      oldOwnerMembership.role = 'PARENT';
      db.familyMembers.set(oldOwnerMembership.id, oldOwnerMembership);
    }

    newOwnerMembership.role = 'OWNER';
    db.familyMembers.set(newOwnerMembership.id, newOwnerMembership);

    family.ownerUserId = newOwnerUserId;
    family.updatedAt = new Date().toISOString();
    db.families.set(familyId, family);

    // Invariant verification: Exactly ONE active owner
    const owners = Array.from(db.familyMembers.values()).filter(
      (m) => m.familyId === familyId && m.role === 'OWNER'
    );
    if (owners.length !== 1) {
      throw new Error('FATAL: Ownership invariant violation. Rolled back.');
    }

    db.save();

    const oldOwner = db.users.get(currentOwnerUserId);
    const newOwner = db.users.get(newOwnerUserId);
    this.logAudit(
      familyId,
      currentOwnerUserId,
      oldOwner?.name || 'Owner',
      'OWNERSHIP_TRANSFERRED',
      `Transferred family ownership to ${newOwner?.name || 'Parent'} (${newOwner?.email || ''})`
    );
  }

  /**
   * Get Family Audit Logs
   */
  public getAuditLogs(familyId: string, actorUserId: string): FamilyAuditLog[] {
    const membership = Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === familyId && m.userId === actorUserId
    );
    if (!membership) {
      throw new Error('Forbidden. You do not belong to this family.');
    }

    return db.familyAuditLogs.filter((log) => log.familyId === familyId).reverse();
  }

  public logAudit(familyId: string, actorUserId: string, actorName: string, action: string, details: string, childId?: string) {
    const log: FamilyAuditLog = {
      id: `log-${nanoid(10)}`,
      familyId,
      actorUserId,
      actorName,
      action,
      childId,
      details,
      timestamp: new Date().toISOString(),
    };
    db.familyAuditLogs.push(log);
    db.save();
  }
}

export const familyService = new FamilyService();
