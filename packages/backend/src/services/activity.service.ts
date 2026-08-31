import { db } from '../db/store';
import { ActivityEvent, normalizeDomain } from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export class ActivityService {
  /**
   * Log privacy-first activity event (Domain-level only)
   */
  public logActivity(
    childId: string,
    deviceId: string,
    rawDomain: string,
    action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED'
  ): ActivityEvent {
    const domain = normalizeDomain(rawDomain);
    const device = db.devices.get(deviceId);
    const child = db.children.get(childId);

    const event: ActivityEvent = {
      id: `act-${nanoid(8)}`,
      childId,
      deviceId,
      deviceName: device ? device.name : 'Child Device',
      domain,
      action,
      timestamp: new Date().toISOString(),
    };

    db.activityLogs.push(event);
    if (db.activityLogs.length > 1000) {
      db.activityLogs.shift();
    }
    db.save();

    // Broadcast activity to parent
    wsManager.broadcast({
      type: 'ACTIVITY_LOGGED',
      payload: event,
      parentId: child ? child.parentId : undefined,
      childId,
    });

    return event;
  }

  public getActivityForChild(childId: string, limit: number = 50): ActivityEvent[] {
    return db.activityLogs
      .filter((a) => a.childId === childId)
      .slice(-limit)
      .reverse();
  }

  public getStatsForChild(childId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const todayEvents = db.activityLogs.filter(
      (a) => a.childId === childId && new Date(a.timestamp).getTime() >= startOfDay
    );

    const blockedCount = todayEvents.filter((a) => a.action === 'BLOCKED').length;
    const pendingRequestsCount = Array.from(db.requests.values()).filter(
      (r) => r.childId === childId && r.status === 'PENDING'
    ).length;

    return {
      todayBlockedCount: blockedCount,
      pendingRequestsCount,
      totalEventsToday: todayEvents.length,
    };
  }
}

export const activityService = new ActivityService();
