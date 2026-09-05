import { Router, Response } from 'express';
import { childService } from '../services/child.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { rbacService, FamilyPermission } from '../services/rbac.service';
import { familyService } from '../services/family.service';
import { prisma } from '../db/prisma';

export const childRouter = Router();

// All child routes require verified email
childRouter.use(authMiddleware, requireVerifiedEmail);

// List children for logged-in parent's family (or specific familyId)
childRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const familyId = req.query.familyId as string | undefined;
  if (familyId) {
    if (!(await rbacService.getFamilyMembership(req.userId!, familyId))) {
      return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    }
    if (!(await rbacService.hasFamilyPermission(req.userId!, familyId, FamilyPermission.CHILD_READ))) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view children.' });
    }
    const children = await childService.getChildrenForParent(req.userId!, familyId);
    return res.json(children);
  }

  const family = await familyService.getOrCreateUserFamily(req.userId!);
  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ))) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view children.' });
  }

  const children = await childService.getChildrenForParent(req.userId!);
  res.json(children);
});

// Create child profile
childRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, age, avatar, familyId } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Child name is required.' });
    }

    let parsedAge: number | undefined = undefined;
    if (age !== undefined && age !== null && age !== '') {
      parsedAge = typeof age === 'number' ? age : parseInt(age, 10);
      if (isNaN(parsedAge) || parsedAge < 1 || parsedAge > 18 || !Number.isInteger(parsedAge)) {
        return res.status(400).json({ error: 'Invalid age: Must be a positive integer between 1 and 18.' });
      }
    }

    let targetFamilyId: string;
    if (familyId && typeof familyId === 'string' && familyId.trim()) {
      const trimmedFamilyId = familyId.trim();
      const targetFamily = await prisma.family.findUnique({
        where: { id: trimmedFamilyId },
      });
      if (!targetFamily) {
        return res.status(404).json({ error: 'Referenced family does not exist.' });
      }

      const membership = await rbacService.getFamilyMembership(req.userId!, targetFamily.id);
      if (!membership) {
        return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
      }
      targetFamilyId = targetFamily.id;
    } else {
      const userFamily = await familyService.getOrCreateUserFamily(req.userId!);
      targetFamilyId = userFamily.id;
    }

    if (!(await rbacService.hasFamilyPermission(req.userId!, targetFamilyId, FamilyPermission.CHILD_MANAGE))) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to create child profiles.' });
    }

    const result = await childService.createChild(req.userId!, name.trim(), parsedAge, avatar, targetFamilyId);
    res.json(result);
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : e.message.includes('not exist') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Get single child
childRouter.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const child = await childService.getChild(req.params.id);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = await rbacService.getFamilyForChild(child.id);
  if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ))) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view this child profile.' });
  }

  res.json(child);
});

// Delete child
childRouter.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const child = await childService.getChild(req.params.id);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = await rbacService.getFamilyForChild(child.id);
  if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_MANAGE))) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to delete child profiles.' });
  }

  await childService.deleteChild(req.params.id);
  res.json({ success: true });
});
