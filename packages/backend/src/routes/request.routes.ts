import { Router } from 'express';
import { requestService } from '../services/request.service';
import { deviceService } from '../services/device.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { childService } from '../services/child.service';

export const requestRouter = Router();

// Child creates access request from blocked screen
requestRouter.post('/', (req, res) => {
  try {
    const { childId, deviceId, domain, reason } = req.body;
    if (!childId || !deviceId || !domain) {
      return res.status(400).json({ error: 'childId, deviceId and domain are required.' });
    }

    if (deviceService.isDeviceRevoked(deviceId)) {
      return res.status(403).json({ error: 'Forbidden. Device credentials have been revoked.' });
    }

    const request = requestService.createRequest(childId, deviceId, domain, reason);
    res.json(request);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Parent resolves access request with strict tenancy validation
requestRouter.post('/:id/resolve', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { action, duration } = req.body;
    if (!action || !['APPROVE', 'DENY'].includes(action)) {
      return res.status(400).json({ error: 'Valid action (APPROVE or DENY) is required.' });
    }

    const result = requestService.resolveRequest(req.params.id, req.userId!, action, duration);
    res.json(result);
  } catch (e: any) {
    if (e.message.startsWith('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});

// Get pending requests for parent
requestRouter.get('/pending', authMiddleware, (req: AuthenticatedRequest, res) => {
  const requests = requestService.getPendingRequestsForParent(req.userId!);
  res.json(requests);
});

// Get all requests for a child
requestRouter.get('/child/:childId', authMiddleware, (req: AuthenticatedRequest, res) => {
  const child = childService.getChild(req.params.childId);
  if (!child || child.parentId !== req.userId) {
    return res.status(404).json({ error: 'Child not found.' });
  }
  const requests = requestService.getRequestsForChild(req.params.childId);
  res.json(requests);
});
