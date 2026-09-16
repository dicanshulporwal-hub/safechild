import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { prisma } from '../db/prisma';
import { rbacService } from '../services/rbac.service';
import { notificationService } from '../services/notification.service';
import { pushService } from '../services/push.service';
import { wsManager } from '../services/websocket.service';
import { nanoid } from 'nanoid';

export const notificationRouter = Router();

// In-memory read state tracker for composite notifications
const readNotificationIds = new Set<string>();

/**
 * GET /api/notifications
 * Returns unified real-time notifications for the logged-in parent
 */
notificationRouter.get(
  '/',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userMemberships = await rbacService.getUserFamilyMemberships(req.userId!);
      const familyIds = userMemberships.map((m) => m.familyId);

      if (familyIds.length === 0) {
        return res.json([]);
      }

      // 1. Fetch children for the parent's families
      const children = await prisma.child.findMany({
        where: { familyId: { in: familyIds } },
        include: { devices: true },
      });
      const childMap = new Map<string, any>();
      children.forEach((c) => childMap.set(c.id, c));

      // 2. Fetch pending access requests
      const pendingRequests = await prisma.accessRequest.findMany({
        where: {
          familyId: { in: familyIds },
          status: 'PENDING',
        },
        include: { device: true },
        orderBy: { requestedAt: 'desc' },
        take: 20,
      });

      const requestNotifications = pendingRequests.map((r) => {
        const child = childMap.get(r.childId);
        return {
          id: `notif-req-${r.id}`,
          requestId: r.id,
          type: 'REQUEST' as const,
          title: 'Website Unlock Request',
          description: `${child?.name || 'Child'} requested access to ${r.domain}${
            r.reason ? ` (${r.reason})` : ''
          }`,
          timestamp: r.requestedAt.toISOString(),
          read: readNotificationIds.has(`notif-req-${r.id}`),
          domain: r.domain,
          childId: r.childId,
          childName: child?.name || 'Child',
          deviceName: r.device?.name || 'Child Device',
        };
      });

      // 3. Fetch high-severity security events (Malware / Adult content blocks)
      const recentThreats = await prisma.activityEvent.findMany({
        where: {
          familyId: { in: familyIds },
          action: 'BLOCKED',
          category: { in: ['MALWARE_SECURITY', 'ADULT_CONTENT', 'PIRACY', 'GAMBLING'] },
        },
        include: { device: true },
        orderBy: { timestamp: 'desc' },
        take: 10,
      });

      const securityNotifications = recentThreats.map((evt) => {
        const child = childMap.get(evt.childId);
        return {
          id: `notif-sec-${evt.id}`,
          type: 'SECURITY' as const,
          title: 'Security Threat Neutralized',
          description: `Blocked high-risk ${evt.category.replace('_', ' ')} domain (${evt.domain}) on ${
            evt.device?.name || 'Child Device'
          }`,
          timestamp: evt.timestamp.toISOString(),
          read: readNotificationIds.has(`notif-sec-${evt.id}`),
          domain: evt.domain,
          childId: evt.childId,
          childName: child?.name || 'Child',
          deviceName: evt.device?.name || 'Child Device',
        };
      });

      // 4. Fetch stored custom/watchdog notifications
      const serviceNotifs = await notificationService.getNotificationsForParent(req.userId!);
      const customNotifs = serviceNotifs.map((n) => ({
        id: n.id,
        type: (n.type as any) || 'SECURITY',
        title: n.title,
        description: n.message,
        timestamp: n.timestamp,
        read: n.read || readNotificationIds.has(n.id),
        childId: n.childId,
        childName: n.childName,
        deviceName: n.deviceName,
      }));

      // Combine and sort by timestamp descending
      const allNotifs = [...requestNotifications, ...securityNotifications, ...customNotifs];
      allNotifs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      res.json(allNotifs.slice(0, 30));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

/**
 * POST /api/notifications/:id/read
 * Mark a single notification as read
 */
notificationRouter.post(
  '/:id/read',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    readNotificationIds.add(id);
    notificationService.markAsRead(id);
    res.json({ success: true, id });
  }
);

/**
 * POST /api/notifications/read-all
 * Mark all notifications as read
 */
notificationRouter.post(
  '/read-all',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    const { ids } = req.body;
    if (Array.isArray(ids)) {
      ids.forEach((id) => readNotificationIds.add(id));
    }
    res.json({ success: true });
  }
);

/**
 * POST /api/notifications/test-alert
 * Trigger an instant test notification event via WebSocket and storage
 */
notificationRouter.post(
  '/test-alert',
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userMemberships = await rbacService.getUserFamilyMemberships(req.userId!);
      if (userMemberships.length === 0) {
        return res.status(404).json({ error: 'Family not found.' });
      }

      const familyId = userMemberships[0].familyId;
      const children = await prisma.child.findMany({ where: { familyId } });
      const child = children[0];
      if (!child) {
        return res.status(404).json({ error: 'No child found in family.' });
      }

      const { type = 'REQUEST', domain = 'discord.com', reason = 'School project collaboration' } = req.body;

      if (type === 'REQUEST') {
        const id = `req-${nanoid(10)}`;
        const now = new Date();
        const createdReq = await prisma.accessRequest.create({
          data: {
            id,
            childId: child.id,
            familyId,
            domain,
            reason,
            status: 'PENDING',
            requestedAt: now,
          },
        });

        const notifPayload = {
          id: `notif-req-${createdReq.id}`,
          requestId: createdReq.id,
          type: 'REQUEST',
          title: 'Website Unlock Request',
          description: `${child.name} requested access to ${domain} (${reason})`,
          timestamp: now.toISOString(),
          read: false,
          domain,
          childId: child.id,
          childName: child.name,
          deviceName: 'Child Device',
        };

        wsManager.broadcast({
          type: 'ACCESS_REQUEST_CREATED',
          payload: createdReq,
          parentId: req.userId,
          childId: child.id,
        });

        wsManager.broadcast({
          type: 'NOTIFICATION_CREATED',
          payload: notifPayload,
          parentId: req.userId,
          childId: child.id,
        });

        return res.json({ success: true, notification: notifPayload });
      } else {
        const notifItem = await notificationService.createNotification(
          child.id,
          'ENFORCEMENT_STOPPED',
          'AI Watchdog Alert',
          `Sentiment alert flagged on ${child.name}'s device for intent check`,
          undefined,
          'Windows PC'
        );

        return res.json({ success: true, notification: notifItem });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

/**
 * GET /api/notifications/vapid-public-key
 * Returns VAPID public key for browser push subscription enrollment
 */
notificationRouter.get(
  '/vapid-public-key',
  authMiddleware,
  (req: AuthenticatedRequest, res: Response) => {
    res.json({
      publicKey: pushService.getVapidPublicKey(),
    });
  }
);

/**
 * POST /api/notifications/push-subscribe
 * Saves or updates browser push notification subscription
 */
notificationRouter.post(
  '/push-subscribe',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { subscription } = req.body;
      const userAgent = req.headers['user-agent'] as string;
      const result = await pushService.subscribe(req.userId!, subscription, userAgent);
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

/**
 * POST /api/notifications/push-unsubscribe
 * Removes browser push notification subscription
 */
notificationRouter.post(
  '/push-unsubscribe',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { endpoint } = req.body;
      const success = await pushService.unsubscribe(endpoint);
      res.json({ success });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

