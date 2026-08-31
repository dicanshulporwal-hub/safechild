import { Router, Response } from 'express';
import { childService } from '../services/child.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { rbacService, FamilyPermission } from '../services/rbac.service';
import { familyService } from '../services/family.service';
import { db } from '../db/store';

export const childRouter = Router();

// All child routes require verified email
childRouter.use(authMiddleware, requireVerifiedEmail);

// List children for logged-in parent's family
childRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const family = familyService.getOrCreateUserFamily(req.userId!);
  if (!rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ)) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view children.' });
  }

  const children = childService.getChildrenForParent(req.userId!);
  res.json(children);
});

// Create child profile
childRouter.post('/', (req: AuthenticatedRequest, res: Response) => {
  try {
    const family = familyService.getOrCreateUserFamily(req.userId!);
    if (!rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_MANAGE)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to create child profiles.' });
    }

    const { name, age, avatar } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Child name is required.' });
    }
    const result = childService.createChild(req.userId!, name, age, avatar);
    res.json(result);
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Get single child
childRouter.get('/:id', (req: AuthenticatedRequest, res: Response) => {
  const child = childService.getChild(req.params.id);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = rbacService.getFamilyForChild(child.id);
  if (!family || !rbacService.getFamilyMembership(req.userId!, family.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ)) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view this child profile.' });
  }

  res.json(child);
});

// Delete child
childRouter.delete('/:id', (req: AuthenticatedRequest, res: Response) => {
  const child = childService.getChild(req.params.id);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = rbacService.getFamilyForChild(child.id);
  if (!family || !rbacService.getFamilyMembership(req.userId!, family.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_MANAGE)) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to delete child profiles.' });
  }

  childService.deleteChild(req.params.id);
  res.json({ success: true });
});
