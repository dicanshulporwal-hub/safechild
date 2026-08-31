import { Router } from 'express';
import { activityService } from '../services/activity.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { childService } from '../services/child.service';

export const activityRouter = Router();

// Device telemetry logging (Privacy-first)
activityRouter.post('/', (req, res) => {
  try {
    const { childId, deviceId, domain, action } = req.body;
    if (!childId || !deviceId || !domain || !action) {
      return res.status(400).json({ error: 'childId, deviceId, domain and action are required.' });
    }

    const event = activityService.logActivity(childId, deviceId, domain, action);
    res.json(event);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Parent gets activity log for child
activityRouter.get('/child/:childId', authMiddleware, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.childId);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const logs = activityService.getActivityForChild(req.params.childId);
  res.json(logs);
});

// Parent gets stats for child dashboard
activityRouter.get('/stats/:childId', authMiddleware, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.childId);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const stats = activityService.getStatsForChild(req.params.childId);
  res.json(stats);
});
