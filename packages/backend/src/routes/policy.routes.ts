import { Router } from 'express';
import { policyService } from '../services/policy.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { childService } from '../services/child.service';
import { deviceService } from '../services/device.service';
import { db } from '../db/store';

export const policyRouter = Router();

// Get policy for a child (Parent auth)
policyRouter.get('/child/:childId', authMiddleware, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.childId);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child profile not found.' });
  }
  const policy = policyService.getPolicyForChild(req.params.childId);
  res.json(policy);
});

// Get policy for a child device (Device fetches during sync)
policyRouter.get('/device/:deviceId', (req, res) => {
  const device = db.devices.get(req.params.deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found.' });
  }

  if (deviceService.isDeviceRevoked(device.id)) {
    return res.status(403).json({ error: 'Forbidden. Device credentials have been revoked.' });
  }

  try {
    const result = policyService.getPolicyForDevice(req.params.deviceId);
    res.json(result);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

// Add or update website rule (Parent auth)
policyRouter.post('/child/:childId/rules', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { domain, action, reason, duration } = req.body;
    if (!domain || !action) {
      return res.status(400).json({ error: 'domain and action (BLOCK/ALLOW) are required.' });
    }

    const child = childService.getChild(req.params.childId);
    if (!child || child.parentId !== req.userId) {
      return res.status(404).json({ error: 'Child profile not found.' });
    }

    const updatedPolicy = policyService.addRule(
      req.params.childId,
      domain,
      action,
      reason,
      duration
    );
    res.json(updatedPolicy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a rule (Parent auth)
policyRouter.delete('/child/:childId/rules/:ruleId', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const child = childService.getChild(req.params.childId);
    if (!child || child.parentId !== req.userId) {
      return res.status(404).json({ error: 'Child profile not found.' });
    }

    const updatedPolicy = policyService.removeRule(req.params.childId, req.params.ruleId);
    res.json(updatedPolicy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Pause / unpause internet for a child (Parent auth)
policyRouter.post('/child/:childId/pause', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { isPaused, duration } = req.body;
    const child = childService.getChild(req.params.childId);
    if (!child || child.parentId !== req.userId) {
      return res.status(404).json({ error: 'Child profile not found.' });
    }

    const updatedPolicy = policyService.setInternetPause(
      req.params.childId,
      Boolean(isPaused),
      duration
    );
    res.json(updatedPolicy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Update Category Controls (Parent auth)
policyRouter.post('/child/:childId/categories', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { categoryControls } = req.body;
    const child = childService.getChild(req.params.childId);
    if (!child || child.parentId !== req.userId) {
      return res.status(404).json({ error: 'Child profile not found.' });
    }

    const policy = policyService.getPolicyForChild(req.params.childId);
    policy.categoryControls = categoryControls;
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Toggle Study Mode (Parent auth)
policyRouter.post('/child/:childId/study-mode', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { active } = req.body;
    const child = childService.getChild(req.params.childId);
    if (!child || child.parentId !== req.userId) {
      return res.status(404).json({ error: 'Child profile not found.' });
    }

    const policy = policyService.getPolicyForChild(req.params.childId);
    policy.studyMode = {
      active: Boolean(active),
      allowedCategories: ['EDUCATION'],
    };
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Update Bedtime Schedule (Parent auth)
policyRouter.post('/child/:childId/bedtime', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { bedtime } = req.body;
    const child = childService.getChild(req.params.childId);
    if (!child || child.parentId !== req.userId) {
      return res.status(404).json({ error: 'Child profile not found.' });
    }

    const policy = policyService.getPolicyForChild(req.params.childId);
    policy.bedtime = bedtime;
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    res.json(policy);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
