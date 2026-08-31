import { Router } from 'express';
import { usageService } from '../services/usage.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';

export const usageRouter = Router();

// GET /api/usage/child/:childId -> Get active budgets and consumed usage (Parent auth + Verified Email)
usageRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
    const summaries = usageService.getBudgetsWithUsage(req.params.childId);
    res.json(summaries);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/budget -> Create or update Screen Time Budget (Parent auth + Verified Email)
usageRouter.post('/child/:childId/budget', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
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

// POST /api/usage/child/:childId/budget/:budgetId/bonus -> Add Bonus Minutes (Parent auth + Verified Email)
usageRouter.post('/child/:childId/budget/:budgetId/bonus', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
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

// POST /api/usage/child/:childId/budget/:budgetId/unlimited -> Grant Unlimited Today (Parent auth + Verified Email)
usageRouter.post('/child/:childId/budget/:budgetId/unlimited', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
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

// DELETE /api/usage/child/:childId/budget/:budgetId -> Remove Budget (Parent auth + Verified Email)
usageRouter.delete('/child/:childId/budget/:budgetId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
    const policy = usageService.removeUsageBudget(req.params.childId, req.params.budgetId);
    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/safesearch -> Update SafeSearch configuration (Parent auth + Verified Email)
usageRouter.post('/child/:childId/safesearch', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
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
usageRouter.post('/sync', deviceAuthMiddleware, (req: AuthenticatedDeviceRequest, res) => {
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

// GET /api/usage/digest -> Weekly Privacy Digest (Parent auth + Verified Email)
usageRouter.get('/digest', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res) => {
  try {
    const digest = usageService.getWeeklyDigest(req.userId!);
    res.json(digest);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
