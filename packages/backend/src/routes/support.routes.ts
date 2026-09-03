import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { requireSystemAdmin } from '../middleware/rbac';
import { supportConsoleService } from '../services/support.service';
import { rbacService, SystemPermission } from '../services/rbac.service';

export const supportRouter = Router();

// Fleet overview for support engineers / operations — Protected by SYSTEM_ADMIN
supportRouter.get(
  '/fleet',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_FLEET_READ),
  async (req: AuthenticatedRequest, res: Response) => {
    const fleet = await supportConsoleService.getFleetOverview();
    res.json({
      totalDevices: fleet.length,
      devices: fleet,
    });
  }
);

// Trigger safe remote agent rollback — Protected by SYSTEM_ADMIN
supportRouter.post(
  '/rollback',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_ROLLBACK_EXECUTE),
  async (req: AuthenticatedRequest, res: Response) => {
    const { targetVersion, affectedDevices } = req.body;
    if (!targetVersion) {
      return res.status(400).json({ error: 'targetVersion is required.' });
    }

    const result = supportConsoleService.triggerRemoteRollback(targetVersion, affectedDevices);

    await rbacService.logSystemAudit(
      req.userId!,
      'SUPPORT_ROLLBACK_TRIGGERED',
      `Triggered support rollback to ${targetVersion}`,
      req.ip
    );

    res.json(result);
  }
);
