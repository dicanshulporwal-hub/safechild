import { Router, Response } from 'express';
import { requestService } from '../services/request.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { childService } from '../services/child.service';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { rbacService, FamilyPermission } from '../services/rbac.service';
import { familyService } from '../services/family.service';

export const requestRouter = Router();

// Child creates access request from blocked screen (Device authentication required)
requestRouter.post('/', deviceAuthMiddleware, (req: AuthenticatedDeviceRequest, res: Response) => {
  try {
    const { domain, reason } = req.body;
    if (!domain) {
      return res.status(400).json({ error: 'domain is required.' });
    }

    const request = requestService.createRequest(req.childId!, req.deviceId!, domain, reason);
    res.json(request);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Parent resolves access request with strict family RBAC and approval rules
requestRouter.post('/:id/resolve', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, duration } = req.body;
    if (!action || !['APPROVE', 'DENY'].includes(action)) {
      return res.status(400).json({ error: 'Valid action (APPROVE or DENY) is required.' });
    }

    const result = requestService.resolveRequest(req.params.id, req.userId!, action, duration);
    res.json(result);
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});

// Get pending requests for parent's family
requestRouter.get('/pending', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  const reqFamilyId = req.query.familyId as string | undefined;
  if (reqFamilyId) {
    if (!rbacService.hasFamilyPermission(req.userId!, reqFamilyId, FamilyPermission.REQUEST_READ)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view requests.' });
    }
    const requests = requestService.getPendingRequestsForParent(req.userId!, reqFamilyId);
    return res.json(requests);
  }

  const userFamilies = rbacService.getUserFamilyMemberships(req.userId!)
    .filter((m) => rbacService.hasFamilyPermission(req.userId!, m.familyId, FamilyPermission.REQUEST_READ));
  if (userFamilies.length === 0) {
    return res.json([]);
  }

  const requests = requestService.getPendingRequestsForParent(req.userId!);
  res.json(requests);
});

// Get all requests for a child
requestRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, (req: AuthenticatedRequest, res: Response) => {
  const child = childService.getChild(req.params.childId);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = rbacService.getFamilyForChild(child.id);
  if (!family || !rbacService.getFamilyMembership(req.userId!, family.id)) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.REQUEST_READ)) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view requests.' });
  }

  const requests = requestService.getRequestsForChild(req.params.childId);
  res.json(requests);
});
