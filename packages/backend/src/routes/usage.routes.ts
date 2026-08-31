import { Router } from 'express';
import { usageService } from '../services/usage.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';

export const usageRouter = Router();

// GET /api/usage/child/:childId -> Get active budgets and consumed usage
usageRouter.get('/child/:childId', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const summaries = usageService.getBudgetsWithUsage(req.params.childId);
    res.json(summaries);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/budget -> Create or update Screen Time Budget
usageRouter.post('/child/:childId/budget', authMiddleware, (req: AuthenticatedRequest, res) => {
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

// POST /api/usage/child/:childId/budget/:budgetId/bonus -> Add Bonus Minutes
usageRouter.post('/child/:childId/budget/:budgetId/bonus', authMiddleware, (req: AuthenticatedRequest, res) => {
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

// POST /api/usage/child/:childId/budget/:budgetId/unlimited -> Grant Unlimited Today
usageRouter.post('/child/:childId/budget/:budgetId/unlimited', authMiddleware, (req: AuthenticatedRequest, res) => {
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

// DELETE /api/usage/child/:childId/budget/:budgetId -> Remove Budget
usageRouter.delete('/child/:childId/budget/:budgetId', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const policy = usageService.removeUsageBudget(req.params.childId, req.params.budgetId);
    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/usage/child/:childId/safesearch -> Update SafeSearch configuration
usageRouter.post('/child/:childId/safesearch', authMiddleware, (req: AuthenticatedRequest, res) => {
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

// POST /api/usage/sync -> Device reports active usage increment
usageRouter.post('/sync', (req, res) => {
  try {
    const { childId, deviceId, target, targetType, secondsIncrement, clientWallIso } = req.body;
    if (!childId || !deviceId || !target || !targetType || secondsIncrement === undefined) {
      return res.status(400).json({ error: 'Missing required sync fields.' });
    }
    const result = usageService.recordUsageSync(
      childId,
      deviceId,
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

// GET /api/usage/digest -> Weekly Privacy Digest
usageRouter.get('/digest', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const digest = usageService.getWeeklyDigest(req.userId!);
    res.json(digest);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
