import { Router } from 'express';
import { prisma } from '../db/prisma';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { requireSystemAdmin } from '../middleware/rbac';
import { notificationService } from '../services/notification.service';
import { timelineService } from '../services/timeline.service';
import { policyService } from '../services/policy.service';
import { evaluatePolicyDetailed } from '@safebrowse/shared';
import { rbacService, FamilyPermission, SystemPermission } from '../services/rbac.service';

export const operationsRouter = Router();

// Beta Operations Dashboard Metrics — Protected by SYSTEM_ADMIN role
operationsRouter.get(
  '/metrics',
  authMiddleware,
  requireVerifiedEmail,
  requireSystemAdmin(SystemPermission.SYSTEM_OPERATIONS_READ),
  async (req: AuthenticatedRequest, res) => {
    const familiesCount = await prisma.family.count();
    const usersCount = await prisma.user.count();
    const childrenCount = await prisma.child.count();
    const allDevices = await prisma.device.findMany({
      include: {
        child: {
          select: { policy: { select: { version: true } } },
        },
      },
    });
    const devicesCount = allDevices.length;

    let protectedCount = 0;
    let warningCount = 0;
    let inactiveCount = 0;
    let offlineCount = 0;
    let syncedDevicesCount = 0;
    let policyEligibleCount = 0;

    const now = Date.now();

    allDevices.forEach((dev: any) => {
      const elapsedSec = (now - new Date(dev.lastHeartbeatAt).getTime()) / 1000;
      if (dev.isRevoked || !dev.healthStatus || dev.healthStatus === 'inactive') {
        inactiveCount++;
      } else if (elapsedSec > 120) {
        offlineCount++;
      } else if (dev.healthState === 'WARNING' || dev.healthStatus === 'syncing') {
        warningCount++;
      } else {
        protectedCount++;
      }

      if (!dev.isRevoked && elapsedSec <= 120) {
        policyEligibleCount++;
        const configuredVersion = dev.child?.policy?.version ?? 1;
        if (dev.activePolicyVersion === configuredVersion) {
          syncedDevicesCount++;
        }
      }
    });

    const policySyncSuccessRate = policyEligibleCount > 0
      ? `${((syncedDevicesCount / policyEligibleCount) * 100).toFixed(1)}%`
      : null;

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
      policySyncSuccessRate,
      policySyncSuccessRateAvailable: policyEligibleCount > 0,
      agentCrashRate: null,
      agentCrashRateAvailable: false,
    });
  }
);

// Notifications feed for authenticated parent
operationsRouter.get(
  '/notifications',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res) => {
    const list = await notificationService.getNotificationsForParent(req.userId!);
    res.json(list);
  }
);

// Protection Timeline for child (Requires family membership & CHILD_READ)
operationsRouter.get(
  '/timeline/:childId',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res) => {
    const family = await rbacService.getFamilyForChild(req.params.childId);
    if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
      return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    }
    if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.CHILD_READ))) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions.' });
    }

    const list = await timelineService.getEventsForChild(req.params.childId);
    res.json(list);
  }
);

// Policy Simulator API (Evaluates domain against child's real policy engine - Requires family membership & POLICY_READ)
operationsRouter.post(
  '/simulator/:childId',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res) => {
    try {
      const family = await rbacService.getFamilyForChild(req.params.childId);
      if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
        return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
      }
      if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.POLICY_READ))) {
        return res.status(403).json({ error: 'Forbidden: Insufficient family permissions.' });
      }

      const { domain, time } = req.body;
      if (!domain) {
        return res.status(400).json({ error: 'domain is required for simulation.' });
      }

      const policy = await policyService.getPolicyForChild(req.params.childId);
      const evaluationTime = time ? new Date(time) : new Date();

      const decision = evaluatePolicyDetailed(policy, domain, evaluationTime);
      res.json(decision);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// Public Service Status Page (status.safebrowse.io API)
operationsRouter.get('/status', (req, res) => {
  res.json({
    status: 'OPERATIONAL',
    timestamp: new Date().toISOString(),
    uptime: null,
    uptimeAvailable: false,
    services: [
      { name: 'Core Policy Evaluation Engine', status: 'OPERATIONAL' },
      { name: 'DNS Filtering Engine', status: 'OPERATIONAL' },
      { name: 'Real-time WebSocket Gateway', status: 'OPERATIONAL' },
      { name: 'Backend REST API & Identity Service', status: 'OPERATIONAL' },
      { name: 'Ask Parent Cloud Notification Broker', status: 'OPERATIONAL' },
    ],
  });
});
