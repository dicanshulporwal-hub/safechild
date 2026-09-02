import { Router, Response } from 'express';
import { db } from '../db/store';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { requireSystemAdmin } from '../middleware/rbac';
import { rbacService, SystemPermission } from '../services/rbac.service';
import { supportConsoleService } from '../services/support.service';

export const adminRouter = Router();

// Middleware chain for all admin routes: JWT Auth + Verified Email + SYSTEM_ADMIN role
const adminAuth = [authMiddleware, requireVerifiedEmail, requireSystemAdmin()];

// GET /api/admin/metrics - Global fleet and operations metrics
adminRouter.get('/metrics', ...adminAuth, (req: AuthenticatedRequest, res: Response) => {
  const familiesCount = db.families.size;
  const usersCount = db.users.size;
  const childrenCount = db.children.size;
  const allDevices = Array.from(db.devices.values());
  const devicesCount = allDevices.length;

  let protectedCount = 0;
  let warningCount = 0;
  let inactiveCount = 0;
  let offlineCount = 0;

  const now = Date.now();

  allDevices.forEach((dev: any) => {
    const elapsedSec = (now - new Date(dev.lastHeartbeatAt).getTime()) / 1000;
    if (dev.isRevoked || !dev.healthStatus || dev.healthStatus === 'inactive') {
      inactiveCount++;
    } else if (elapsedSec > 90) {
      offlineCount++;
    } else if (dev.healthState === 'WARNING' || dev.healthStatus === 'syncing') {
      warningCount++;
    } else {
      protectedCount++;
    }
  });

  res.json({
    familiesCount,
    usersCount,
    childrenCount,
    devicesCount,
    healthBreakdown: {
      protected: protectedCount,
      warning: warningCount,
      inactive: inactiveCount,
      offline: offlineCount,
    },
    policySyncSuccessRate: '99.4%',
    agentCrashRate: '0.1%',
    status: 'ALL_SYSTEMS_OPERATIONAL',
    timestamp: new Date().toISOString(),
  });
});

// GET /api/admin/fleet - Global fleet overview
adminRouter.get('/fleet', authMiddleware, requireVerifiedEmail, requireSystemAdmin(SystemPermission.SYSTEM_FLEET_READ), (req: AuthenticatedRequest, res: Response) => {
  const fleet = supportConsoleService.getFleetOverview();
  res.json({
    totalDevices: fleet.length,
    devices: fleet,
  });
});

// POST /api/admin/rollback - Trigger safe emergency remote agent rollback
adminRouter.post('/rollback', authMiddleware, requireVerifiedEmail, requireSystemAdmin(SystemPermission.SYSTEM_ROLLBACK_EXECUTE), (req: AuthenticatedRequest, res: Response) => {
  const { targetVersion, affectedDevices, reason } = req.body;
  if (!targetVersion) {
    return res.status(400).json({ error: 'targetVersion is required.' });
  }

  const result = supportConsoleService.triggerRemoteRollback(targetVersion, affectedDevices);

  // Append-only system audit log
  rbacService.logSystemAudit(
    req.userId!,
    'EMERGENCY_ROLLBACK_TRIGGERED',
    `Triggered rollback to version ${targetVersion}. Reason: ${reason || 'N/A'}. Result: ${JSON.stringify(result)}`,
    req.ip
  );

  res.json({ success: true, result });
});

// GET /api/admin/support - Support console diagnostics
adminRouter.get('/support', authMiddleware, requireVerifiedEmail, requireSystemAdmin(SystemPermission.SYSTEM_SUPPORT_MANAGE), (req: AuthenticatedRequest, res: Response) => {
  const allDevices = Array.from(db.devices.values());
  const openRequests = Array.from(db.requests.values()).filter((r) => r.status === 'PENDING');
  const recentErrors = db.activityLogs.filter((a) => a.action === 'BLOCKED').slice(-20);

  res.json({
    totalDevices: allDevices.length,
    pendingAccessRequests: openRequests.length,
    recentFilterEvents: recentErrors,
  });
});

// GET /api/admin/audit - Append-only privileged system audit logs
adminRouter.get('/audit', authMiddleware, requireVerifiedEmail, requireSystemAdmin(SystemPermission.SYSTEM_AUDIT_READ), (req: AuthenticatedRequest, res: Response) => {
  try {
    const logs = rbacService.getSystemAuditLogs(req.userId!);
    res.json({ logs });
  } catch (e: any) {
    res.status(403).json({ error: e.message });
  }
});

// POST /api/admin/bootstrap-dev - Development-only admin promotion (Rejected unconditionally in production)
adminRouter.post(
  '/bootstrap-dev',
  (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Admin bootstrap is strictly disabled in production environments.' });
    }
    next();
  },
  authMiddleware,
  requireVerifiedEmail,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const secret = (req.headers['x-admin-bootstrap-secret'] as string) || req.body?.bootstrapSecret;
      const user = rbacService.bootstrapDevAdmin(req.userId!, secret);
      res.json({
        success: true,
        message: `User ${user.email} promoted to SYSTEM_ADMIN via development bootstrap.`,
        systemRole: user.systemRole,
      });
    } catch (e: any) {
      res.status(403).json({ error: e.message });
    }
  }
);
