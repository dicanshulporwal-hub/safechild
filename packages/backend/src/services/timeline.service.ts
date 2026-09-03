import { prisma } from '../db/prisma';
import { TimelineEvent } from '@safebrowse/protocol';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export class TimelineService {
  private timelineLogs: TimelineEvent[] = [];

  public async logEvent(event: Omit<TimelineEvent, 'id' | 'timestamp'>): Promise<TimelineEvent> {
    const fullEvent: TimelineEvent = {
      ...event,
      id: `evt-${nanoid(10)}`,
      timestamp: new Date().toISOString(),
    };

    this.timelineLogs.push(fullEvent);
    if (this.timelineLogs.length > 1000) {
      this.timelineLogs = this.timelineLogs.slice(-1000);
    }

    const child = await prisma.child.findUnique({
      where: { id: event.childId },
    });

    if (child) {
      wsManager.broadcast({
        type: 'TIMELINE_EVENT',
        payload: fullEvent,
        parentId: child.parentId,
        childId: event.childId,
      });
    }

    return fullEvent;
  }

  public getEventsForChild(childId: string): TimelineEvent[] {
    return this.timelineLogs
      .filter((e) => e.childId === childId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
}

export const timelineService = new TimelineService();
