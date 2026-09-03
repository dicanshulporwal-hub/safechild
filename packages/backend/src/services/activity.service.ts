import { prisma } from '../db/prisma';
import { ActivityEvent, normalizeDomain } from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export class ActivityService {
  /**
   * Log privacy-first activity event (Domain-level only)
   */
  public async logActivity(
    childId: string,
    deviceId: string,
    rawDomain: string,
    action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED'
  ): Promise<ActivityEvent> {
    const domain = normalizeDomain(rawDomain);
    const child = await prisma.child.findUnique({
      where: { id: childId },
    });
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!child) {
      throw new Error('Child not found.');
    }

    const id = `act-${nanoid(8)}`;
    const now = new Date();

    const created = await prisma.activityEvent.create({
      data: {
        id,
        familyId: child.familyId,
        childId,
        deviceId,
        domain,
        action,
        category: 'GENERAL',
        timestamp: now,
      },
    });

    const event: ActivityEvent = {
      id: created.id,
      childId: created.childId,
      deviceId: created.deviceId || deviceId,
      deviceName: device ? device.name : 'Child Device',
      domain: created.domain,
      action: created.action as any,
      timestamp: created.timestamp.toISOString(),
    };

    wsManager.broadcast({
      type: 'ACTIVITY_LOGGED',
      payload: event,
      parentId: child.parentId,
      childId,
    });

    return event;
  }

  public async getActivityForChild(childId: string, limit: number = 50): Promise<ActivityEvent[]> {
    const list = await prisma.activityEvent.findMany({
      where: { childId },
      include: { device: true },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return list.map((a) => ({
      id: a.id,
      childId: a.childId,
      deviceId: a.deviceId || '',
      deviceName: a.device?.name || 'Child Device',
      domain: a.domain,
      action: a.action as any,
      timestamp: a.timestamp.toISOString(),
    }));
  }

  public async getStatsForChild(childId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const todayEvents = await prisma.activityEvent.findMany({
      where: {
        childId,
        timestamp: { gte: startOfDay },
      },
    });

    const blockedCount = todayEvents.filter((a) => a.action === 'BLOCKED').length;
    const pendingRequestsCount = await prisma.accessRequest.count({
      where: {
        childId,
        status: 'PENDING',
      },
    });

    return {
      todayBlockedCount: blockedCount,
      pendingRequestsCount,
      totalEventsToday: todayEvents.length,
    };
  }
}

export const activityService = new ActivityService();
