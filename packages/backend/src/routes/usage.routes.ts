import { Router, Response } from 'express';
import { usageService } from '../services/usage.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { rbacService, FamilyPermission } from '../services/rbac.service';
import { childService } from '../services/child.service';
import { familyService } from '../services/family.service';

export const usageRouter = Router();

// Helper to verify usage permissions
function checkUsageAccess(req: AuthenticatedRequest, res: Response, childId: string, permission: FamilyPermission) {
  const child = childService.getChild(childId);
  if (!child) {
    res.status(404).json({ error: 'Child profile not found.' });
    return null;
  }

  const family = rbacService.getFamilyForChild(child.id);
  if (!family || !rbacService.getFamilyMembership(req.userId!, family.id)) {
    res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    return null;
  }

  if (!rbacService.hasFamilyPermission(req.userId!, family.id, permission)) {
    res.status(403).json({ error: `Forbidden: Insufficient family permissions for ${permission}.` });
    return null;
  }

  return { child, family };
}

// GET /api/usage/child/:childId -> Get active budgets and consumed usage (Parent auth + Verified Email + USAGE_READ)
usageRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = checkUsageAccess(req, res, req.params.childId, FamilyPermission.USAGE_READ);
    if (!access) return;

    const summaries = usageService.getBudgetsWithUsage(req.params.childId);
    res.json(summaries);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/budget -> Create or update Screen Time Budget (Parent auth + Verified Email + USAGE_MANAGE)
usageRouter.post('/child/:childId/budget', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = checkUsageAccess(req, res, req.params.childId, FamilyPermission.USAGE_MANAGE);
    if (!access) return;

    const { target, targetType, dailyLimitMinutes } = req.body;
    if (!target || !targetType || !dailyLimitMinutes) {
      return res.status(400).json({ error: 'target, targetType, and dailyLimitMinutes are required.' });
    }
    const budget = usageService.setUsageBudget(
      req.params.childId,
      target,
      targetType,
      Number(dailyLimitMinutes),
      req.userId
    );
    res.json(budget);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/budget/:budgetId/bonus -> Add Bonus Minutes (Parent auth + Verified Email + USAGE_MANAGE)
usageRouter.post('/child/:childId/budget/:budgetId/bonus', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = checkUsageAccess(req, res, req.params.childId, FamilyPermission.USAGE_MANAGE);
    if (!access) return;

    const { bonusMinutes } = req.body;
    const budget = usageService.addBonusTime(
      req.params.childId,
      req.params.budgetId,
      Number(bonusMinutes || 15),
      req.userId
    );
    res.json(budget);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/budget/:budgetId/unlimited -> Grant Unlimited Today (Parent auth + Verified Email + USAGE_MANAGE)
usageRouter.post('/child/:childId/budget/:budgetId/unlimited', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = checkUsageAccess(req, res, req.params.childId, FamilyPermission.USAGE_MANAGE);
    if (!access) return;

    const budget = usageService.setUnlimitedToday(
      req.params.childId,
      req.params.budgetId,
      req.userId
    );
    res.json(budget);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/usage/child/:childId/budget/:budgetId -> Remove Budget (Parent auth + Verified Email + USAGE_MANAGE)
usageRouter.delete('/child/:childId/budget/:budgetId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = checkUsageAccess(req, res, req.params.childId, FamilyPermission.USAGE_MANAGE);
    if (!access) return;

    const policy = usageService.removeUsageBudget(req.params.childId, req.params.budgetId);
    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/safesearch -> Update SafeSearch configuration (Parent auth + Verified Email + USAGE_MANAGE)
usageRouter.post('/child/:childId/safesearch', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = checkUsageAccess(req, res, req.params.childId, FamilyPermission.USAGE_MANAGE);
    if (!access) return;

    const { googleSafeSearch, bingSafeSearch, duckDuckGoSafeSearch, youtubeRestrictedMode } = req.body;
    const policy = usageService.updateSafeSearch(
      req.params.childId,
      {
        googleSafeSearch: Boolean(googleSafeSearch),
        bingSafeSearch: Boolean(bingSafeSearch),
        duckDuckGoSafeSearch: Boolean(duckDuckGoSafeSearch),
        youtubeRestrictedMode: youtubeRestrictedMode || 'OFF',
      },
      req.userId
    );
    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/sync -> Device reports active usage increment (Device auth required)
usageRouter.post('/sync', deviceAuthMiddleware, (req: AuthenticatedDeviceRequest, res: Response) => {
  try {
    const { target, targetType, secondsIncrement, clientWallIso } = req.body;
    if (!target || !targetType || secondsIncrement === undefined) {
      return res.status(400).json({ error: 'Missing required sync fields: target, targetType, secondsIncrement.' });
    }
    const result = usageService.recordUsageSync(
      req.childId!,
      req.deviceId!,
      target,
      targetType,
      Number(secondsIncrement),
      clientWallIso
    );
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/usage/digest -> Weekly Privacy Digest (Parent auth + Verified Email + USAGE_READ)
usageRouter.get('/digest', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const reqFamilyId = req.query.familyId as string | undefined;
    if (reqFamilyId) {
      if (!rbacService.hasFamilyPermission(req.userId!, reqFamilyId, FamilyPermission.USAGE_READ)) {
        return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view usage digest.' });
      }
      const digest = usageService.getWeeklyDigest(req.userId!, reqFamilyId);
      return res.json(digest);
    }

    const userFamilies = rbacService.getUserFamilyMemberships(req.userId!)
      .filter((m) => rbacService.hasFamilyPermission(req.userId!, m.familyId, FamilyPermission.USAGE_READ));
    if (userFamilies.length === 0) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view usage digest.' });
    }

    const digest = usageService.getWeeklyDigest(req.userId!);
    res.json(digest);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
