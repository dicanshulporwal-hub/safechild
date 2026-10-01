import { prisma } from '../db/prisma';
import { TimelineEvent } from '@safebrowse/protocol';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export interface LogTimelineEventInput {
  familyId?: string;
  childId?: string;
  deviceId?: string;
  deviceName?: string;
  eventType: string;
  decision?: string;
  domain?: string;
  reason?: string;
  metadata?: Record<string, any>;
  policyVersion?: number;
  timestamp?: string;
}

export class TimelineService {
  /**
   * Persist security and protection timeline event to PostgreSQL
   */
  public async logEvent(event: LogTimelineEventInput): Promise<TimelineEvent> {
    const id = `evt-${nanoid(10)}`;
    const eventTimestamp = event.timestamp ? new Date(event.timestamp) : new Date();

    let familyId = event.familyId;
    let parentId: string | undefined;

    if (!familyId && event.childId) {
      const child = await prisma.child.findUnique({
        where: { id: event.childId },
        select: { familyId: true, parentId: true },
      });
      if (child) {
        familyId = child.familyId;
        parentId = child.parentId;
      }
    }

    if (!familyId && event.deviceId) {
      const device = await prisma.device.findUnique({
        where: { id: event.deviceId },
        select: { familyId: true, parentId: true, childId: true },
      });
      if (device) {
        familyId = device.familyId;
        parentId = device.parentId;
        if (!event.childId) event.childId = device.childId;
      }
    }

    if (!familyId) {
      throw new Error('Timeline event must belong to a valid family.');
    }

    const created = await prisma.timelineEvent.create({
      data: {
        id,
        familyId,
        childId: event.childId || null,
        deviceId: event.deviceId || null,
        eventType: event.eventType,
        decision: event.decision || null,
        domain: event.domain || null,
        reason: event.reason || null,
        metadata: event.metadata ? (event.metadata as any) : undefined,
        timestamp: eventTimestamp,
      },
    });

    const fullEvent: TimelineEvent = {
      id: created.id,
      familyId: created.familyId,
      childId: created.childId || undefined,
      deviceId: created.deviceId || undefined,
      deviceName: event.deviceName,
      domain: created.domain || undefined,
      eventType: created.eventType as any,
      decision: created.decision || undefined,
      reason: created.reason || '',
      metadata: created.metadata as any,
      policyVersion: event.policyVersion || 1,
      timestamp: created.timestamp.toISOString(),
    };

    if (event.childId) {
      if (!parentId) {
        const child = await prisma.child.findUnique({
          where: { id: event.childId },
          select: { parentId: true },
        });
        parentId = child?.parentId;
      }
      wsManager.broadcast({
        type: 'TIMELINE_EVENT',
        payload: fullEvent,
        parentId,
        childId: event.childId,
      });
    }

    return fullEvent;
  }

  /**
   * Retrieve timeline events for a child directly from PostgreSQL
   */
  public async getEventsForChild(childId: string, limit: number = 50): Promise<TimelineEvent[]> {
    const list = await prisma.timelineEvent.findMany({
      where: { childId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return list.map((e) => ({
      id: e.id,
      familyId: e.familyId,
      childId: e.childId || undefined,
      deviceId: e.deviceId || undefined,
      domain: e.domain || undefined,
      eventType: e.eventType as any,
      decision: e.decision || undefined,
      reason: e.reason || '',
      metadata: e.metadata as any,
      policyVersion: 1,
      timestamp: e.timestamp.toISOString(),
    }));
  }

  /**
   * Retrieve timeline events for an entire family
   */
  public async getEventsForFamily(familyId: string, limit: number = 100): Promise<TimelineEvent[]> {
    const list = await prisma.timelineEvent.findMany({
      where: { familyId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return list.map((e) => ({
      id: e.id,
      familyId: e.familyId,
      childId: e.childId || undefined,
      deviceId: e.deviceId || undefined,
      domain: e.domain || undefined,
      eventType: e.eventType as any,
      decision: e.decision || undefined,
      reason: e.reason || '',
      metadata: e.metadata as any,
      policyVersion: 1,
      timestamp: e.timestamp.toISOString(),
    }));
  }
}

export const timelineService = new TimelineService();
