import * as fs from 'fs';
import * as path from 'path';
import { DeviceConfig, configManager } from './config-manager';
import { logServiceMessage } from './network-manager';

export interface QueuedActivityEvent {
  id: string;
  domain: string;
  action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED';
  childId: string;
  timestamp: string;
  category?: string;
  reason?: string;
}

export class WindowsActivityReporter {
  private config: DeviceConfig | null = null;
  private queue: QueuedActivityEvent[] = [];
  private outboxFilePath: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing: boolean = false;
  private static readonly MAX_QUEUE_SIZE = 500;
  private static readonly FLUSH_INTERVAL_MS = 8000;
  private customSender: ((events: QueuedActivityEvent[]) => Promise<boolean>) | null = null;

  constructor(customBaseDir?: string) {
    const baseDir = customBaseDir || configManager.getBaseDir();
    this.outboxFilePath = path.join(baseDir, 'activity-outbox.json');
    this.loadOutbox();
  }

  public setCustomSenderForTesting(sender: ((events: QueuedActivityEvent[]) => Promise<boolean>) | null): void {
    this.customSender = sender;
  }

  public setConfig(config: DeviceConfig): void {
    this.config = config;
  }

  private loadOutbox(): void {
    try {
      if (fs.existsSync(this.outboxFilePath)) {
        const raw = fs.readFileSync(this.outboxFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.queue = parsed.slice(-WindowsActivityReporter.MAX_QUEUE_SIZE);
        }
      }
    } catch {}
  }

  private saveOutbox(): void {
    try {
      const baseDir = path.dirname(this.outboxFilePath);
      if (!fs.existsSync(baseDir)) {
        try { fs.mkdirSync(baseDir, { recursive: true }); } catch {}
      }
      configManager.ensureDirectories();
      fs.writeFileSync(this.outboxFilePath, JSON.stringify(this.queue, null, 2), 'utf8');
    } catch {}
  }

  /**
   * Records a DNS activity event for an active managed child.
   * If childId is null or missing (e.g. parent/unmanaged account),
   * this method silently drops the event to preserve parent privacy.
   */
  public recordEvent(event: {
    domain: string;
    action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED';
    childId: string | null;
    category?: string;
    reason?: string;
  }): void {
    if (!event.childId) {
      // Unmanaged / Parent account: do not log activity
      return;
    }

    const queued: QueuedActivityEvent = {
      id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      domain: event.domain,
      action: event.action,
      childId: event.childId,
      timestamp: new Date().toISOString(),
      category: event.category,
      reason: event.reason,
    };

    this.queue.push(queued);
    if (this.queue.length > WindowsActivityReporter.MAX_QUEUE_SIZE) {
      this.queue.shift(); // Bound memory
    }

    this.saveOutbox();
  }

  /**
   * Flushes queued activity events to the backend in batches.
   */
  public async flushOutbox(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;

    try {
      const batch = this.queue.slice(0, 50);

      if (this.customSender) {
        const success = await this.customSender(batch);
        if (success) {
          this.queue = this.queue.slice(batch.length);
          this.saveOutbox();
        }
        return;
      }

      if (!this.config) {
        const loaded = await configManager.loadDeviceConfig();
        if (loaded) this.config = loaded;
      }

      if (!this.config || !this.config.backendUrl || !this.config.deviceToken) {
        return;
      }

      const res = await fetch(`${this.config.backendUrl}/api/activity`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': this.config.deviceId,
          'x-device-token': this.config.deviceToken,
        },
        body: JSON.stringify({
          events: batch,
        }),
      });

      if (res.ok) {
        this.queue = this.queue.slice(batch.length);
        this.saveOutbox();
      }
    } catch (err: any) {
      logServiceMessage('WARN', `[ActivityReporter] Telemetry flush deferred: ${err.message}`);
    } finally {
      this.isFlushing = false;
    }
  }

  public start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushOutbox().catch(() => {});
    }, WindowsActivityReporter.FLUSH_INTERVAL_MS);
  }

  public stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

export const activityReporter = new WindowsActivityReporter();
