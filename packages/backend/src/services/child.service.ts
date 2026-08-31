import { db } from '../db/store';
import { Child, Policy } from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { familyService } from './family.service';

export class ChildService {
  public getChildrenForParent(parentId: string): Child[] {
    const family = familyService.getOrCreateUserFamily(parentId);
    return Array.from(db.children.values()).filter(
      (c) => c.parentId === parentId || c.parentId === family.ownerUserId
    );
  }

  public getChild(childId: string): Child | undefined {
    return db.children.get(childId);
  }

  public createChild(parentId: string, name: string, age?: number, avatar?: string): { child: Child; policy: Policy } {
    const childId = `child-${nanoid(8)}`;
    const family = familyService.getOrCreateUserFamily(parentId);

    const child: Child = {
      id: childId,
      parentId: family.ownerUserId, // Bind child to family owner so all co-parents have access
      name: name.trim(),
      age: age || undefined,
      avatar: avatar || '🧑',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Auto-create initial policy for child
    const policy: Policy = {
      id: `policy-${nanoid(8)}`,
      childId: child.id,
      version: 1,
      isPaused: false,
      rules: [
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
      ],
      updatedAt: new Date().toISOString(),
    };

    db.children.set(child.id, child);
    db.policies.set(child.id, policy);
    db.save();

    const actor = db.users.get(parentId);
    familyService.logAudit(
      family.id,
      parentId,
      actor?.name || 'Parent',
      'CHILD_CREATED',
      `Created child profile '${child.name}'`,
      child.id
    );

    return { child, policy };
  }

  public deleteChild(childId: string) {
    const child = db.children.get(childId);
    db.children.delete(childId);
    db.policies.delete(childId);
    // Remove paired devices for this child
    for (const [id, dev] of db.devices.entries()) {
      if (dev.childId === childId) {
        db.devices.delete(id);
      }
    }
    db.save();

    if (child) {
      const family = familyService.getOrCreateUserFamily(child.parentId);
      familyService.logAudit(
        family.id,
        child.parentId,
        'Parent',
        'CHILD_DELETED',
        `Deleted child profile '${child.name}'`,
        child.id
      );
    }
  }
}

export const childService = new ChildService();
