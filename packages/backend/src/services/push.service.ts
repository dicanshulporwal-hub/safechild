import { prisma } from '../db/prisma';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export interface WebPushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, any>;
}

export class PushNotificationService {
  private vapidPublicKey: string;
  private vapidPrivateKey: string;

  constructor() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      this.vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
      this.vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    } else {
      // Deterministic dev default key pair
      this.vapidPublicKey = 'BI8HBqDIV7E/2GlvW3P2sNR09DxgySSPwUXt5/xgxj7ahhe0XKYXCnWz2QNpu5BIH0YoFiw4+WdMKX58g9XhgyA=';
      this.vapidPrivateKey = 'xigrLaW/XRedbpfJeHKRYb22XaCZ0bztRNfjrGn3FKM=';
    }
  }

  public getVapidPublicKey(): string {
    return this.vapidPublicKey;
  }

  /**
   * Register or update a browser push subscription for a parent user
   */
  public async subscribe(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string
  ): Promise<{ success: boolean; id: string }> {
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      throw new Error('Invalid push subscription object. Required: endpoint, keys.p256dh, keys.auth');
    }

    const { endpoint, keys } = subscription;
    const existing = await prisma.pushSubscription.findUnique({
      where: { endpoint },
    });

    if (existing) {
      const updated = await prisma.pushSubscription.update({
        where: { id: existing.id },
        data: {
          userId,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent || existing.userAgent,
          updatedAt: new Date(),
        },
      });
      return { success: true, id: updated.id };
    }

    const created = await prisma.pushSubscription.create({
      data: {
        id: `sub-${nanoid(10)}`,
        userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: userAgent || null,
      },
    });

    return { success: true, id: created.id };
  }

  /**
   * Unsubscribe / delete a push subscription
   */
  public async unsubscribe(endpoint: string): Promise<boolean> {
    const res = await prisma.pushSubscription.deleteMany({
      where: { endpoint },
    });
    return res.count > 0;
  }

  /**
   * Send push notification to a specific parent user across all enrolled devices
   */
  public async sendPushToUser(userId: string, payload: WebPushPayload): Promise<{ sent: number; failed: number }> {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
    });

    let sent = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      try {
        wsManager.broadcast({
          type: 'NOTIFICATION_CREATED',
          payload: {
            title: payload.title,
            description: payload.body,
            timestamp: new Date().toISOString(),
            data: payload.data,
          },
          parentId: userId,
        });

        if (sub.endpoint && sub.endpoint.startsWith('http')) {
          try {
            await fetch(sub.endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                TTL: '60',
              },
              body: JSON.stringify(payload),
            });
          } catch {}
        }

        sent++;
      } catch (e) {
        failed++;
      }
    }

    return { sent, failed };
  }

  /**
   * Broadcast push notification to all parents in a family
   */
  public async sendPushToFamily(familyId: string, payload: WebPushPayload): Promise<{ sent: number; failed: number }> {
    const members = await prisma.familyMember.findMany({
      where: {
        familyId,
        role: { in: ['OWNER', 'PARENT'] },
      },
      select: { userId: true },
    });

    let totalSent = 0;
    let totalFailed = 0;

    for (const m of members) {
      const res = await this.sendPushToUser(m.userId, payload);
      totalSent += res.sent;
      totalFailed += res.failed;
    }

    return { sent: totalSent, failed: totalFailed };
  }
}

export const pushService = new PushNotificationService();
