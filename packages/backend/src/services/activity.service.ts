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
    action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED',
    metadata?: {
      category?: string;
      reason?: string;
      timestamp?: string;
    }
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
    if (!device) {
      throw new Error('Device not found.');
    }
    if (device.familyId !== child.familyId) {
      throw new Error('Forbidden: Device and child do not belong to the same family.');
    }

    const id = `act-${nanoid(8)}`;
    const now = new Date();

    let eventTimestamp = now;
    if (metadata?.timestamp) {
      const candidate = new Date(metadata.timestamp);
      const maxFutureMs = 5 * 60 * 1000;
      const maxPastMs = 30 * 24 * 60 * 60 * 1000;
      if (
        !Number.isNaN(candidate.getTime()) &&
        candidate.getTime() <= now.getTime() + maxFutureMs &&
        candidate.getTime() >= now.getTime() - maxPastMs
      ) {
        eventTimestamp = candidate;
      }
    }

    const category = (metadata?.category || 'GENERAL').toString().trim().slice(0, 64) || 'GENERAL';
    const blockedReason = metadata?.reason ? metadata.reason.toString().trim().slice(0, 512) : null;

    // The current relational schema can link a device only to its primary child.
    // Secondary mapped children remain family-validated but store a null device FK.
    const canLinkDevice = device.childId === childId;

    const created = await prisma.activityEvent.create({
      data: {
        id,
        familyId: child.familyId,
        childId,
        deviceId: canLinkDevice ? deviceId : null,
        domain,
        action,
        category,
        blockedReason,
        timestamp: eventTimestamp,
      },
    });

    const event: ActivityEvent = {
      id: created.id,
      childId: created.childId,
      deviceId: created.deviceId || deviceId,
      deviceName: device.name,
      domain: created.domain,
      category: created.category as any,
      action: created.action as any,
      reason: created.blockedReason || undefined,
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
      category: a.category as any,
      action: a.action as any,
      reason: a.blockedReason || undefined,
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
