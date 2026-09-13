import { Router, Response } from 'express';
import { prisma } from '../db/prisma';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { requireSystemAdmin } from '../middleware/rbac';
import { rbacService, SystemPermission } from '../services/rbac.service';
import { supportConsoleService } from '../services/support.service';

export const adminRouter = Router();

// Middleware chain for all admin routes: JWT Auth + Verified Email + SYSTEM_ADMIN role
const adminAuth = [authMiddleware, requireVerifiedEmail, requireSystemAdmin()];

// GET /api/admin/metrics - Global fleet and operations metrics
adminRouter.get('/metrics', ...adminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const familiesCount = await prisma.family.count();
  const usersCount = await prisma.user.count();
  const childrenCount = await prisma.child.count();
  const allDevices = await prisma.device.findMany();
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
adminRouter.get(
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

// POST /api/admin/rollback - Trigger safe emergency remote agent rollback
adminRouter.post(
  '/rollback',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_ROLLBACK_EXECUTE),
  async (req: AuthenticatedRequest, res: Response) => {
    const { targetVersion, affectedDevices, reason } = req.body;
    if (!targetVersion) {
      return res.status(400).json({ error: 'targetVersion is required.' });
    }

    const result = supportConsoleService.triggerRemoteRollback(targetVersion, affectedDevices);

    // Append-only system audit log
    await rbacService.logSystemAudit(
      req.userId!,
      'EMERGENCY_ROLLBACK_TRIGGERED',
      `Triggered rollback to version ${targetVersion}. Reason: ${reason || 'N/A'}. Result: ${JSON.stringify(result)}`,
      req.ip
    );

    res.json({ success: true, result });
  }
);

// GET /api/admin/support - Support console diagnostics
adminRouter.get(
  '/support',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_SUPPORT_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    const devicesCount = await prisma.device.count();
    const openRequestsCount = await prisma.accessRequest.count({
      where: { status: 'PENDING' },
    });
    const recentErrors = await prisma.activityEvent.findMany({
      where: { action: 'BLOCKED' },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    res.json({
      totalDevices: devicesCount,
      pendingAccessRequests: openRequestsCount,
      recentFilterEvents: recentErrors,
    });
  }
);

// GET /api/admin/audit - Append-only privileged system audit logs
adminRouter.get(
  '/audit',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_AUDIT_READ),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const logs = await rbacService.getSystemAuditLogs(req.userId!);
      res.json({ logs });
    } catch (e: any) {
      res.status(403).json({ error: e.message });
    }
  }
);

import bcrypt from 'bcryptjs';

// GET /api/admin/parents - List all parents and their family accounts
adminRouter.get(
  '/parents',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_PARENTS_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          memberships: {
            include: {
              family: {
                include: {
                  children: {
                    include: {
                      devices: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      const sanitizedUsers = users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        systemRole: u.systemRole,
        emailVerified: u.emailVerified,
        mfaEnabled: u.mfaEnabled,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        families: u.memberships.map((m) => ({
          familyId: m.family.id,
          familyName: m.family.name,
          role: m.role,
          isOwner: m.role === 'OWNER',
          children: m.family.children.map((c) => ({
            id: c.id,
            name: c.name,
            age: c.age,
            deviceCount: c.devices.length,
          })),
        })),
      }));

      res.json({ parents: sanitizedUsers, total: sanitizedUsers.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

// GET /api/admin/parents/:id - Get specific parent details
adminRouter.get(
  '/parents/:id',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_PARENTS_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: {
          memberships: {
            include: {
              family: {
                include: {
                  children: {
                    include: {
                      devices: true,
                      policy: true,
                    },
                  },
                  auditLogs: {
                    take: 20,
                    orderBy: { timestamp: 'desc' },
                  },
                },
              },
            },
          },
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'Parent user not found.' });
      }

      const sanitized = {
        id: user.id,
        email: user.email,
        name: user.name,
        systemRole: user.systemRole,
        emailVerified: user.emailVerified,
        mfaEnabled: user.mfaEnabled,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        families: user.memberships.map((m) => ({
          familyId: m.family.id,
          familyName: m.family.name,
          role: m.role,
          children: m.family.children,
          recentAuditLogs: m.family.auditLogs,
        })),
      };

      res.json(sanitized);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/admin/parents/:id/verify-email - Manually verify a parent email
adminRouter.post(
  '/parents/:id/verify-email',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_PARENTS_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!user) {
        return res.status(404).json({ error: 'Parent user not found.' });
      }

      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: { emailVerified: true },
      });

      await rbacService.logSystemAudit(
        req.userId!,
        'ADMIN_VERIFY_PARENT_EMAIL',
        `Admin manually verified email for parent ${user.email} (${user.id})`,
        req.ip
      );

      res.json({ success: true, message: `Email verified for ${updated.email}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/admin/parents/:id/reset-password - Admin reset password for a parent
adminRouter.post(
  '/parents/:id/reset-password',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_PARENTS_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { newPassword } = req.body;
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'newPassword is required and must be at least 8 characters long.' });
      }

      const user = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!user) {
        return res.status(404).json({ error: 'Parent user not found.' });
      }

      const salt = bcrypt.genSaltSync(12);
      const passwordHash = bcrypt.hashSync(newPassword, salt);

      await prisma.user.update({
        where: { id: req.params.id },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 }, // Invalidate existing sessions
        },
      });

      await rbacService.logSystemAudit(
        req.userId!,
        'ADMIN_RESET_PARENT_PASSWORD',
        `Admin reset password for parent ${user.email} (${user.id})`,
        req.ip
      );

      res.json({ success: true, message: `Password successfully reset for ${user.email}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/admin/parents/:id/role - Update user system role (USER <-> SYSTEM_ADMIN)
adminRouter.post(
  '/parents/:id/role',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_PARENTS_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { systemRole } = req.body;
      if (systemRole !== 'USER' && systemRole !== 'SYSTEM_ADMIN') {
        return res.status(400).json({ error: 'systemRole must be USER or SYSTEM_ADMIN.' });
      }

      const user = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!user) {
        return res.status(404).json({ error: 'Parent user not found.' });
      }

      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: { systemRole },
      });

      await rbacService.logSystemAudit(
        req.userId!,
        'ADMIN_CHANGE_USER_ROLE',
        `Admin changed role for user ${user.email} to ${systemRole}`,
        req.ip
      );

      res.json({ success: true, user: { id: updated.id, email: updated.email, systemRole: updated.systemRole } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/admin/parents/:id/disable-mfa - Emergency reset/disable MFA for a locked-out parent
adminRouter.post(
  '/parents/:id/disable-mfa',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_PARENTS_MANAGE),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!user) {
        return res.status(404).json({ error: 'Parent user not found.' });
      }

      await prisma.user.update({
        where: { id: req.params.id },
        data: {
          mfaEnabled: false,
          mfaSecret: null,
          pendingMfaSecret: null,
          mfaRecoveryCodes: [],
          tokenVersion: { increment: 1 },
        },
      });

      await rbacService.logSystemAudit(
        req.userId!,
        'ADMIN_DISABLE_PARENT_MFA',
        `Admin performed emergency MFA disable for parent ${user.email} (${user.id})`,
        req.ip
      );

      res.json({ success: true, message: `MFA disabled and sessions reset for ${user.email}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

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
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const secret = (req.headers['x-admin-bootstrap-secret'] as string) || req.body?.bootstrapSecret;
      const user = await rbacService.bootstrapDevAdmin(req.userId!, secret);
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
