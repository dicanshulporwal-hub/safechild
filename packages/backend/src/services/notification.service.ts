import { prisma } from '../db/prisma';
import { NotificationItem } from '@safebrowse/protocol';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';
import { rbacService } from './rbac.service';

export class NotificationService {
  private notifications: NotificationItem[] = [];

  public async createNotification(
    childId: string,
    type: NotificationItem['type'],
    title: string,
    message: string,
    deviceId?: string,
    deviceName?: string
  ): Promise<NotificationItem> {
    const child = await prisma.child.findUnique({
      where: { id: childId },
    });
    const childName = child ? child.name : 'Child';

    const item: NotificationItem = {
      id: `notif-${nanoid(10)}`,
      childId,
      childName,
      deviceId,
      deviceName,
      type,
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    };

    this.notifications.unshift(item);
    if (this.notifications.length > 200) {
      this.notifications = this.notifications.slice(0, 200);
    }

    if (child) {
      wsManager.broadcast({
        type: 'NOTIFICATION_CREATED',
        payload: item,
        parentId: child.parentId,
        childId,
      });
    }

    return item;
  }

  public async getNotificationsForParent(parentId: string, familyId?: string): Promise<NotificationItem[]> {
    const userFamilyIds = (await rbacService.getUserFamilyMemberships(parentId)).map((m) => m.familyId);
    const targetFamilyIds = familyId ? [familyId] : userFamilyIds;
    const allowedSet = targetFamilyIds.filter((fid) => userFamilyIds.includes(fid));

    const children = await prisma.child.findMany({
      where: { familyId: { in: allowedSet } },
      select: { id: true },
    });
    const familyChildIds = children.map((c) => c.id);

    return this.notifications.filter((n) => familyChildIds.includes(n.childId));
  }

  public markAsRead(notificationId: string) {
    const found = this.notifications.find((n) => n.id === notificationId);
    if (found) {
      found.read = true;
    }
  }
}

export const notificationService = new NotificationService();
