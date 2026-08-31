import { Router } from 'express';
import { childService } from '../services/child.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';

export const childRouter = Router();

// List children for logged-in parent
childRouter.get('/', authMiddleware, (req: AuthenticatedRequest, res) => {
  const children = childService.getChildrenForParent(req.userId!);
  res.json(children);
});

// Create child profile
childRouter.post('/', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { name, age, avatar } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Child name is required.' });
    }
    const result = childService.createChild(req.userId!, name, age, avatar);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Get single child
childRouter.get('/:id', authMiddleware, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.id);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }
  res.json(child);
});

// Delete child
childRouter.delete('/:id', authMiddleware, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.id);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }
  childService.deleteChild(req.params.id);
  res.json({ success: true });
});
