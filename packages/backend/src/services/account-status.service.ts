import { prisma } from '../db/prisma';
import { nanoid } from 'nanoid';

export class AccountStatusService {
  public async disableUser(actorUserId: string, targetUserId: string, reason: string, ipAddress?: string) {
    const normalizedReason = (reason || '').trim();
    if (!normalizedReason) {
      throw new Error('A disable reason is required.');
    }
    if (actorUserId === targetUserId) {
      throw new Error('You cannot disable your own account.');
    }

    return prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetUserId } });
      if (!target) {
        throw new Error('Parent user not found.');
      }

      if (target.status === 'DISABLED') {
        return target;
      }

      if (target.systemRole === 'SYSTEM_ADMIN') {
        const activeAdminCount = await tx.user.count({
          where: {
            systemRole: 'SYSTEM_ADMIN',
            status: 'ACTIVE',
          },
        });
        if (activeAdminCount <= 1) {
          throw new Error('The last active SYSTEM_ADMIN cannot be disabled.');
        }
      }

      const updated = await tx.user.update({
        where: { id: targetUserId },
        data: {
          status: 'DISABLED',
          disabledAt: new Date(),
          disabledReason: normalizedReason,
          disabledByUserId: actorUserId,
          tokenVersion: { increment: 1 },
        },
      });

      await tx.userSession.updateMany({
        where: { userId: targetUserId },
        data: { isRevoked: true },
      });

      await tx.mfaChallenge.updateMany({
        where: { userId: targetUserId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });

      const actor = await tx.user.findUnique({
        where: { id: actorUserId },
        select: { email: true },
      });

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId,
          actorEmail: actor?.email || 'unknown',
          action: 'ADMIN_DISABLE_USER',
          details: `Disabled user ${target.email} (${target.id}). Reason: ${normalizedReason}`,
          ipAddress: ipAddress || null,
        },
      });

      return updated;
    });
  }

  public async enableUser(actorUserId: string, targetUserId: string, ipAddress?: string) {
    return prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetUserId } });
      if (!target) {
        throw new Error('Parent user not found.');
      }

      const updated = await tx.user.update({
        where: { id: targetUserId },
        data: {
          status: 'ACTIVE',
          disabledAt: null,
          disabledReason: null,
          disabledByUserId: null,
        },
      });

      const actor = await tx.user.findUnique({
        where: { id: actorUserId },
        select: { email: true },
      });

      await tx.systemAuditLog.create({
        data: {
          id: `syslog-${nanoid(10)}`,
          actorUserId,
          actorEmail: actor?.email || 'unknown',
          action: 'ADMIN_ENABLE_USER',
          details: `Enabled user ${target.email} (${target.id}). User must sign in again; prior sessions remain revoked.`,
          ipAddress: ipAddress || null,
        },
      });

      return updated;
    });
  }

  public async assertRoleChangeAllowed(targetUserId: string, newRole: 'USER' | 'SYSTEM_ADMIN') {
    if (newRole !== 'USER') return;

    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target || target.systemRole !== 'SYSTEM_ADMIN') return;

    const activeAdminCount = await prisma.user.count({
      where: {
        systemRole: 'SYSTEM_ADMIN',
        status: 'ACTIVE',
      },
    });

    if (target.status === 'ACTIVE' && activeAdminCount <= 1) {
      throw new Error('The last active SYSTEM_ADMIN cannot be demoted.');
    }
  }
}

export const accountStatusService = new AccountStatusService();
