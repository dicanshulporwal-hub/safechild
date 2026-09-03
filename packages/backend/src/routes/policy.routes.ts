import { Router, Response } from 'express';
import { policyService } from '../services/policy.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { childService } from '../services/child.service';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { rbacService, FamilyPermission } from '../services/rbac.service';
import { prisma } from '../db/prisma';

export const policyRouter = Router();

// Helper to check policy permissions
async function checkPolicyAccess(
  req: AuthenticatedRequest,
  res: Response,
  childId: string,
  permission: FamilyPermission
) {
  const child = await childService.getChild(childId);
  if (!child) {
    res.status(404).json({ error: 'Child profile not found.' });
    return null;
  }

  const family = await rbacService.getFamilyForChild(child.id);
  if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
    res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    return null;
  }

  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, permission))) {
    res.status(403).json({ error: `Forbidden: Insufficient family permissions for ${permission}.` });
    return null;
  }

  return { child, family };
}

// Get policy for a child (Parent auth required + POLICY_READ permission)
policyRouter.get(
  '/child/:childId',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_READ);
    if (!access) return;

    const policy = await policyService.getPolicyForChild(req.params.childId);
    res.json(policy);
  }
);

// Get policy for a child device (Device fetches during sync - Device authentication required)
policyRouter.get(
  '/device/:deviceId',
  deviceAuthMiddleware,
  async (req: AuthenticatedDeviceRequest, res: Response) => {
    try {
      const result = await policyService.getPolicyForDevice(req.deviceId!);
      res.json(result);
    } catch (e: any) {
      res.status(404).json({ error: e.message });
    }
  }
);

// Add or update website rule (Parent auth required + POLICY_MANAGE permission)
policyRouter.post(
  '/child/:childId/rules',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_MANAGE);
      if (!access) return;

      const { domain, action, reason, duration } = req.body;
      if (!domain || !action) {
        return res.status(400).json({ error: 'domain and action (BLOCK/ALLOW) are required.' });
      }

      const updatedPolicy = await policyService.addRule(
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
  }
);

// Delete a rule (Parent auth required + POLICY_MANAGE permission)
policyRouter.delete(
  '/child/:childId/rules/:ruleId',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_MANAGE);
      if (!access) return;

      const updatedPolicy = await policyService.removeRule(req.params.childId, req.params.ruleId);
      res.json(updatedPolicy);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// Pause / unpause internet for a child (Parent auth required + POLICY_MANAGE permission)
policyRouter.post(
  '/child/:childId/pause',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_MANAGE);
      if (!access) return;

      const { isPaused, duration } = req.body;
      const updatedPolicy = await policyService.setInternetPause(
        req.params.childId,
        Boolean(isPaused),
        duration
      );
      res.json(updatedPolicy);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// Update Category Controls (Parent auth required + POLICY_MANAGE permission)
policyRouter.post(
  '/child/:childId/categories',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_MANAGE);
      if (!access) return;

      const { categoryControls } = req.body;
      const updated = await prisma.policy.update({
        where: { childId: req.params.childId },
        data: {
          blockedCategories: Array.isArray(categoryControls) ? categoryControls : [],
          version: { increment: 1 },
        },
      });

      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// Toggle Study Mode (Parent auth required + POLICY_MANAGE permission)
policyRouter.post(
  '/child/:childId/study-mode',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_MANAGE);
      if (!access) return;

      const { active } = req.body;
      const updated = await prisma.policy.update({
        where: { childId: req.params.childId },
        data: {
          studyMode: Boolean(active),
          version: { increment: 1 },
        },
      });

      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// Update Bedtime Schedule (Parent auth required + POLICY_MANAGE permission)
policyRouter.post(
  '/child/:childId/bedtime',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const access = await checkPolicyAccess(req, res, req.params.childId, FamilyPermission.POLICY_MANAGE);
      if (!access) return;

      const { bedtime } = req.body;
      const updated = await prisma.policy.update({
        where: { childId: req.params.childId },
        data: {
          routines: bedtime as any,
          version: { increment: 1 },
        },
      });

      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);
