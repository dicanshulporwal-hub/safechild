import { prisma } from '../db/prisma';
import { Child, Policy } from '@safebrowse/shared';
import { nanoid } from 'nanoid';

export class ChildService {
  public async getChildrenForParent(parentId: string, familyId?: string): Promise<Child[]> {
    if (familyId) {
      const list = await prisma.child.findMany({
        where: { familyId },
      });
      return list.map((c) => ({
        id: c.id,
        familyId: c.familyId,
        parentId: c.parentId,
        name: c.name,
        age: c.age || undefined,
        avatar: c.avatar || '🧒',
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      }));
    }

    // Get all families user belongs to
    const memberships = await prisma.familyMember.findMany({
      where: { userId: parentId },
      select: { familyId: true },
    });
    const familyIds = memberships.map((m) => m.familyId);

    const list = await prisma.child.findMany({
      where: { familyId: { in: familyIds } },
    });

    return list.map((c) => ({
      id: c.id,
      familyId: c.familyId,
      parentId: c.parentId,
      name: c.name,
      age: c.age || undefined,
      avatar: c.avatar || '🧒',
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  public async getChild(childId: string): Promise<Child | null> {
    const c = await prisma.child.findUnique({
      where: { id: childId },
    });
    if (!c) return null;
    return {
      id: c.id,
      familyId: c.familyId,
      parentId: c.parentId,
      name: c.name,
      age: c.age || undefined,
      avatar: c.avatar || '🧒',
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  public async createChild(
    parentId: string,
    name: string,
    age?: number,
    avatar?: string,
    targetFamilyId?: string
  ): Promise<{ child: Child; policy: Policy }> {
    if (!targetFamilyId || typeof targetFamilyId !== 'string' || !targetFamilyId.trim()) {
      throw new Error('Mandatory tenancy error: Valid familyId is required to create a child.');
    }

    const childId = `child-${nanoid(8)}`;
    const policyId = `policy-${nanoid(8)}`;

    return prisma.$transaction(async (tx) => {
      const family = await tx.family.findUnique({
        where: { id: targetFamilyId },
      });
      if (!family) {
        throw new Error('Mandatory tenancy error: Referenced family does not exist.');
      }

      const membership = await tx.familyMember.findUnique({
        where: {
          familyId_userId: {
            familyId: family.id,
            userId: parentId,
          },
        },
      });
      if (!membership) {
        throw new Error('Forbidden: You do not belong to this family.');
      }

      const childRecord = await tx.child.create({
        data: {
          id: childId,
          parentId: parentId,
          familyId: family.id,
          name: name.trim(),
          age: age || null,
          avatar: avatar || '🧑',
        },
      });

      const defaultRules = [
        {
          id: `r-${nanoid(6)}`,
          domain: 'youtube.com',
          action: 'BLOCK',
          addedAt: new Date().toISOString(),
        },
        {
          id: `r-${nanoid(6)}`,
          domain: 'wikipedia.org',
          action: 'ALLOW',
          addedAt: new Date().toISOString(),
        },
      ];

      const policyRecord = await tx.policy.create({
        data: {
          id: policyId,
          childId: childRecord.id,
          familyId: family.id,
          version: 1,
          isPaused: false,
          rules: defaultRules,
        },
      });

      const actor = await tx.user.findUnique({ where: { id: parentId } });
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: family.id,
          actorUserId: parentId,
          actorName: actor?.name || 'Parent',
          action: 'CHILD_CREATED',
          childId: childRecord.id,
          details: `Created child profile '${childRecord.name}'`,
        },
      });

      const domainChild: Child = {
        id: childRecord.id,
        familyId: childRecord.familyId,
        parentId: childRecord.parentId,
        name: childRecord.name,
        age: childRecord.age || undefined,
        avatar: childRecord.avatar || '🧑',
        createdAt: childRecord.createdAt.toISOString(),
        updatedAt: childRecord.updatedAt.toISOString(),
      };

      const domainPolicy: Policy = {
        id: policyRecord.id,
        childId: policyRecord.childId,
        familyId: policyRecord.familyId,
        version: policyRecord.version,
        isPaused: policyRecord.isPaused,
        rules: defaultRules as any,
        updatedAt: policyRecord.updatedAt.toISOString(),
      };

      return { child: domainChild, policy: domainPolicy };
    });
  }

  public async deleteChild(childId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const child = await tx.child.findUnique({
        where: { id: childId },
      });
      if (!child) return;

      await tx.child.delete({
        where: { id: childId },
      });

      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: child.familyId,
          actorUserId: child.parentId,
          actorName: 'Parent',
          action: 'CHILD_DELETED',
          childId: child.id,
          details: `Deleted child profile '${child.name}'`,
        },
      });
    });
  }
}

export const childService = new ChildService();
