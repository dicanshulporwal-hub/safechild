import { Router } from 'express';
import { activityService } from '../services/activity.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { childService } from '../services/child.service';

export const activityRouter = Router();

// Device telemetry logging (Device authentication required)
activityRouter.post('/', deviceAuthMiddleware, (req: AuthenticatedDeviceRequest, res) => {
  try {
    const { domain, action } = req.body;
    if (!domain || !action) {
      return res.status(400).json({ error: 'domain and action are required.' });
    }

    const event = activityService.logActivity(req.childId!, req.deviceId!, domain, action);
    res.json(event);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Parent gets activity log for child (Parent auth + Verified Email)
activityRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.childId);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const logs = activityService.getActivityForChild(req.params.childId);
  res.json(logs);
});

// Parent gets stats for child dashboard (Parent auth + Verified Email)
activityRouter.get('/stats/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.childId);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const stats = activityService.getStatsForChild(req.params.childId);
  res.json(stats);
});
