import { Router } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { feedbackService } from '../services/feedback.service';

export const feedbackRouter = Router();

// Submit general beta feedback
feedbackRouter.post('/', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { category, notes } = req.body;
    if (!category) {
      return res.status(400).json({ error: 'category is required.' });
    }

    const item = feedbackService.submitFeedback(req.userId!, category, notes);
    res.json({ success: true, feedback: item });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Report False Positive block
feedbackRouter.post('/false-positive', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { childId, domain, matchedRuleType, policyVersion, category, deviceId, notes } = req.body;
    if (!childId || !domain) {
      return res.status(400).json({ error: 'childId and domain are required.' });
    }

    const report = feedbackService.reportFalsePositive(
      req.userId!,
      childId,
      domain,
      matchedRuleType || 'MANUAL_REPORT',
      policyVersion || 1,
      category,
      deviceId,
      notes
    );

    res.json({ success: true, report });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Admin list feedback
feedbackRouter.get('/list', authMiddleware, (req: AuthenticatedRequest, res) => {
  res.json({
    feedback: feedbackService.getAllFeedback(),
    falsePositives: feedbackService.getAllFalsePositives(),
  });
});
