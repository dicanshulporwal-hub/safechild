import { Router } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { supportConsoleService } from '../services/support.service';

export const supportRouter = Router();

// Fleet overview for support engineers / operations
supportRouter.get('/fleet', authMiddleware, (req: AuthenticatedRequest, res) => {
  const fleet = supportConsoleService.getFleetOverview();
  res.json({
    totalDevices: fleet.length,
    devices: fleet,
  });
});

// Trigger safe remote agent rollback
supportRouter.post('/rollback', authMiddleware, (req: AuthenticatedRequest, res) => {
  const { targetVersion, affectedDevices } = req.body;
  if (!targetVersion) {
    return res.status(400).json({ error: 'targetVersion is required.' });
  }

  const result = supportConsoleService.triggerRemoteRollback(targetVersion, affectedDevices);
  res.json(result);
});
