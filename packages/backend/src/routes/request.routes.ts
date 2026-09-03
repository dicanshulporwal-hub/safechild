import { Router, Response } from 'express';
import { requestService } from '../services/request.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { childService } from '../services/child.service';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { rbacService, FamilyPermission } from '../services/rbac.service';

export const requestRouter = Router();

// Child creates access request from blocked screen (Device authentication required)
requestRouter.post('/', deviceAuthMiddleware, async (req: AuthenticatedDeviceRequest, res: Response) => {
  try {
    const { domain, reason } = req.body;
    if (!domain) {
      return res.status(400).json({ error: 'domain is required.' });
    }

    const request = await requestService.createRequest(req.childId!, req.deviceId!, domain, reason);
    res.json(request);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Parent resolves access request with strict family RBAC and approval rules
requestRouter.post('/:id/resolve', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, duration } = req.body;
    if (!action || !['APPROVE', 'DENY'].includes(action)) {
      return res.status(400).json({ error: 'Valid action (APPROVE or DENY) is required.' });
    }

    const result = await requestService.resolveRequest(req.params.id, req.userId!, action, duration);
    res.json(result);
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});

// Get pending requests for parent's family
requestRouter.get('/pending', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  const reqFamilyId = req.query.familyId as string | undefined;
  if (reqFamilyId) {
    if (!(await rbacService.hasFamilyPermission(req.userId!, reqFamilyId, FamilyPermission.REQUEST_READ))) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view requests.' });
    }
    const requests = await requestService.getPendingRequestsForParent(req.userId!, reqFamilyId);
    return res.json(requests);
  }

  const userMemberships = await rbacService.getUserFamilyMemberships(req.userId!);
  const userFamilies: typeof userMemberships = [];
  for (const m of userMemberships) {
    if (await rbacService.hasFamilyPermission(req.userId!, m.familyId, FamilyPermission.REQUEST_READ)) {
      userFamilies.push(m);
    }
  }

  if (userFamilies.length === 0) {
    return res.json([]);
  }

  const requests = await requestService.getPendingRequestsForParent(req.userId!);
  res.json(requests);
});

// Get all requests for a child
requestRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  const child = await childService.getChild(req.params.childId);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = await rbacService.getFamilyForChild(child.id);
  if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.REQUEST_READ))) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view requests.' });
  }

  const requests = await requestService.getRequestsForChild(req.params.childId);
  res.json(requests);
});
