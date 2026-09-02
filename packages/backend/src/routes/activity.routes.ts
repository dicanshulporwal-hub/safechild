import { Router, Response } from 'express';
import { activityService } from '../services/activity.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { childService } from '../services/child.service';
import { rbacService, FamilyPermission } from '../services/rbac.service';

export const activityRouter = Router();

// Device telemetry logging (Device authentication required)
activityRouter.post('/', deviceAuthMiddleware, (req: AuthenticatedDeviceRequest, res: Response) => {
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

// Helper to verify activity access using centralized family tenancy
function checkActivityAccess(req: AuthenticatedRequest, res: Response, childId: string) {
  const child = childService.getChild(childId);
  if (!child) {
    res.status(404).json({ error: 'Child not found.' });
    return null;
  }

  const family = rbacService.getFamilyForChild(child.id);
  if (!family || !rbacService.getFamilyMembership(req.userId!, family.id)) {
    res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    return null;
  }

  if (!rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ)) {
    res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view child activity.' });
    return null;
  }

  return { child, family };
}

// Parent gets activity log for child (Parent auth + Verified Email + Family RBAC)
activityRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  const access = checkActivityAccess(req, res, req.params.childId);
  if (!access) return;

  const logs = activityService.getActivityForChild(req.params.childId);
  res.json(logs);
});

// Parent gets stats for child dashboard (Parent auth + Verified Email + Family RBAC)
activityRouter.get('/stats/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  const access = checkActivityAccess(req, res, req.params.childId);
  if (!access) return;

  const stats = activityService.getStatsForChild(req.params.childId);
  res.json(stats);
});
