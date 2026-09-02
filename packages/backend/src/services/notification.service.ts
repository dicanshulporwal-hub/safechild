import { db } from '../db/store';
import { NotificationItem } from '@safebrowse/protocol';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export class NotificationService {
  private notifications: NotificationItem[] = [];

  public createNotification(
    childId: string,
    type: NotificationItem['type'],
    title: string,
    message: string,
    deviceId?: string,
    deviceName?: string
  ): NotificationItem {
    const child = db.children.get(childId);
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

  public getNotificationsForParent(parentId: string, familyId?: string): NotificationItem[] {
    const userFamilyIds = Array.from(db.familyMembers.values())
      .filter((m) => m.userId === parentId)
      .map((m) => m.familyId);
    const ownedFamilies = Array.from(db.families.values())
      .filter((f) => f.ownerUserId === parentId)
      .map((f) => f.id);
    const allFamilyIds = new Set([...userFamilyIds, ...ownedFamilies]);
    const targetFamilyIds = familyId ? [familyId] : Array.from(allFamilyIds);
    const allowedSet = new Set<string>(targetFamilyIds.filter((fid: string) => allFamilyIds.has(fid)));

    const familyChildIds = Array.from(db.children.values())
      .filter((c) => c.familyId && allowedSet.has(c.familyId))
      .map((c) => c.id);

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
