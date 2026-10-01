import { Router, Response } from 'express';
import { activityService } from '../services/activity.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { childService } from '../services/child.service';
import { rbacService, FamilyPermission } from '../services/rbac.service';

export const activityRouter = Router();

// Device telemetry logging (Device authentication required)
activityRouter.post('/', deviceAuthMiddleware, async (req: AuthenticatedDeviceRequest, res: Response) => {
  try {
    const { domain, action, childId, events } = req.body;

    const normalizeAction = (
      act: string
    ): 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED' | null => {
      const upper = (act || '').toUpperCase();
      if (upper === 'BLOCK' || upper === 'BLOCKED') return 'BLOCKED';
      if (upper === 'ALLOW' || upper === 'ALLOWED') return 'ALLOWED';
      if (upper === 'TEMPORARY_ACCESSED' || upper === 'TEMPORARY_ALLOW') return 'TEMPORARY_ACCESSED';
      return null;
    };

    // Support batch event submission from agent outbox
    if (Array.isArray(events) && events.length > 0) {
      const results = [];
      let rejected = 0;
      for (const ev of events) {
        if (!ev?.domain || !ev?.action) {
          rejected++;
          continue;
        }
        const targetChild = ev.childId || childId || req.childId!;
        const normalized = normalizeAction(ev.action);
        if (!normalized) {
          rejected++;
          continue;
        }
        try {
          const recorded = await activityService.logActivity(
            targetChild,
            req.deviceId!,
            ev.domain,
            normalized,
            {
              category: ev.category,
              reason: ev.reason,
              timestamp: ev.timestamp,
            }
          );
          results.push(recorded);
        } catch {
          rejected++;
        }
      }
      return res.json({
        success: rejected === 0,
        count: results.length,
        rejected,
        events: results,
      });
    }

    if (!domain || !action) {
      return res.status(400).json({ error: 'domain and action are required.' });
    }

    const targetChild = childId || req.childId!;
    const normalized = normalizeAction(action);
    if (!normalized) {
      return res.status(400).json({ error: 'Unsupported activity action.' });
    }
    const event = await activityService.logActivity(
      targetChild,
      req.deviceId!,
      domain,
      normalized,
      {
        category: req.body.category,
        reason: req.body.reason,
        timestamp: req.body.timestamp,
      }
    );
    res.json(event);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Helper to verify activity access using centralized family tenancy
async function checkActivityAccess(req: AuthenticatedRequest, res: Response, childId: string) {
  const child = await childService.getChild(childId);
  if (!child) {
    res.status(404).json({ error: 'Child not found.' });
    return null;
  }

  const family = await rbacService.getFamilyForChild(child.id);
  if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
    res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    return null;
  }

  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ))) {
    res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view child activity.' });
    return null;
  }

  return { child, family };
}

// Parent gets activity log for child (Parent auth + Verified Email + Family RBAC)
activityRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  const access = await checkActivityAccess(req, res, req.params.childId);
  if (!access) return;

  const logs = await activityService.getActivityForChild(req.params.childId);
  res.json(logs);
});

// Parent gets stats for child dashboard (Parent auth + Verified Email + Family RBAC)
activityRouter.get('/stats/:childId', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  const access = await checkActivityAccess(req, res, req.params.childId);
  if (!access) return;

  const stats = await activityService.getStatsForChild(req.params.childId);
  res.json(stats);
});
