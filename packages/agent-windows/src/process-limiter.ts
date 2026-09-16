import { exec } from 'child_process';
import { promisify } from 'util';
import { Policy, UsageBudget, isWithinBedtime } from '@safebrowse/shared';
import { DeviceConfig } from './sync-client';

const execAsync = promisify(exec);

export interface ProcessUsageState {
  processName: string;
  consumedSeconds: number;
  lastDate: string; // 'YYYY-MM-DD'
  warned5Min: boolean;
  warned1Min: boolean;
}

export interface ProcessLimiterOptions {
  checkIntervalMs?: number;
  syncIntervalMs?: number;
  simulate?: boolean; // For testing without killing system processes
}

export class WindowsProcessLimiter {
  private config: DeviceConfig;
  private getPolicy: () => Policy | null;
  private options: ProcessLimiterOptions;
  private usageTracker: Map<string, ProcessUsageState> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private mockRunningProcesses: string[] | null = null;

  constructor(
    config: DeviceConfig,
    getPolicy: () => Policy | null,
    options: ProcessLimiterOptions = {}
  ) {
    this.config = config;
    this.getPolicy = getPolicy;
    this.options = {
      checkIntervalMs: options.checkIntervalMs || 5000,
      syncIntervalMs: options.syncIntervalMs || 30000,
      simulate: options.simulate ?? (process.platform !== 'win32'),
    };
  }

  public setMockProcesses(processes: string[] | null) {
    this.mockRunningProcesses = processes;
  }

  private getTodayDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Enumerate currently running process image names
   */
  public async getRunningProcessNames(): Promise<string[]> {
    if (this.mockRunningProcesses !== null) {
      return [...this.mockRunningProcesses];
    }

    if (process.platform !== 'win32') {
      return [];
    }

    try {
      // Use tasklist in CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
      const { stdout } = await execAsync('tasklist /FO CSV /NH');
      const lines = stdout.split('\n');
      const processNames = new Set<string>();

      for (const line of lines) {
        const match = line.match(/^"([^"]+)"/);
        if (match && match[1]) {
          processNames.add(match[1].toLowerCase());
        }
      }

      return Array.from(processNames);
    } catch (e: any) {
      console.warn(`[Process Limiter] Failed to enumerate processes: ${e.message}`);
      return [];
    }
  }

  /**
   * Terminate a running process by image name
   */
  public async terminateProcess(imageName: string): Promise<boolean> {
    console.log(`[Process Limiter] 🛑 HARD TERMINATING PROCESS: ${imageName}`);

    if (this.options.simulate || process.platform !== 'win32') {
      if (this.mockRunningProcesses) {
        this.mockRunningProcesses = this.mockRunningProcesses.filter(
          (p) => p.toLowerCase() !== imageName.toLowerCase()
        );
      }
      return true;
    }

    try {
      await execAsync(`taskkill /F /T /IM "${imageName}"`);
      return true;
    } catch (e: any) {
      console.warn(`[Process Limiter] taskkill notice for ${imageName}: ${e.message}`);
      return false;
    }
  }

  /**
   * Evaluate a single process against active budget and policies
   */
  public evaluateProcess(
    processName: string,
    policy: Policy,
    now: Date = new Date()
  ): {
    action: 'ALLOW' | 'WARN_5MIN' | 'WARN_1MIN' | 'TERMINATE';
    reason: string;
    consumedSeconds: number;
    limitSeconds: number;
    remainingSeconds: number;
  } {
    const today = this.getTodayDateString();
    const key = processName.toLowerCase();

    // 1. Check Global Internet Pause
    if (policy.isPaused) {
      return {
        action: 'TERMINATE',
        reason: 'GLOBAL_INTERNET_PAUSED',
        consumedSeconds: 0,
        limitSeconds: 0,
        remainingSeconds: 0,
      };
    }

    // 2. Check Bedtime Schedule
    if (policy.bedtime && policy.bedtime.enabled) {
      if (isWithinBedtime(now, policy.bedtime)) {
        return {
          action: 'TERMINATE',
          reason: 'BEDTIME_CURFEW_ACTIVE',
          consumedSeconds: 0,
          limitSeconds: 0,
          remainingSeconds: 0,
        };
      }
    }

    // 3. Find matching usage budget
    const budgets: UsageBudget[] = (policy.usageBudgets as any[]) || [];
    const matchedBudget = budgets.find((b) => {
      if (!b.enabled) return false;
      const target = b.target.toLowerCase();
      return target === key || target.replace('.exe', '') === key.replace('.exe', '');
    });

    if (!matchedBudget) {
      return {
        action: 'ALLOW',
        reason: 'NO_LIMIT_SET',
        consumedSeconds: 0,
        limitSeconds: Infinity,
        remainingSeconds: Infinity,
      };
    }

    // If parent granted unlimited time today
    if (matchedBudget.unlimitedToday) {
      return {
        action: 'ALLOW',
        reason: 'UNLIMITED_TODAY_GRANTED',
        consumedSeconds: 0,
        limitSeconds: Infinity,
        remainingSeconds: Infinity,
      };
    }

    // Retrieve or initialize tracking state
    let state = this.usageTracker.get(key);
    if (!state || state.lastDate !== today) {
      state = {
        processName: key,
        consumedSeconds: 0,
        lastDate: today,
        warned5Min: false,
        warned1Min: false,
      };
      this.usageTracker.set(key, state);
    }

    const totalAllowedSeconds = (matchedBudget.dailyLimitSeconds || 3600) + (matchedBudget.bonusSeconds || 0);
    const remainingSeconds = Math.max(0, totalAllowedSeconds - state.consumedSeconds);

    if (remainingSeconds <= 0) {
      return {
        action: 'TERMINATE',
        reason: 'DAILY_APP_TIME_EXHAUSTED',
        consumedSeconds: state.consumedSeconds,
        limitSeconds: totalAllowedSeconds,
        remainingSeconds: 0,
      };
    }

    if (remainingSeconds <= 60 && !state.warned1Min) {
      state.warned1Min = true;
      return {
        action: 'WARN_1MIN',
        reason: '1_MINUTE_REMAINING',
        consumedSeconds: state.consumedSeconds,
        limitSeconds: totalAllowedSeconds,
        remainingSeconds,
      };
    }

    if (remainingSeconds <= 300 && !state.warned5Min) {
      state.warned5Min = true;
      return {
        action: 'WARN_5MIN',
        reason: '5_MINUTES_REMAINING',
        consumedSeconds: state.consumedSeconds,
        limitSeconds: totalAllowedSeconds,
        remainingSeconds,
      };
    }

    return {
      action: 'ALLOW',
      reason: 'WITHIN_DAILY_BUDGET',
      consumedSeconds: state.consumedSeconds,
      limitSeconds: totalAllowedSeconds,
      remainingSeconds,
    };
  }

  /**
   * Periodic enforcement loop: checks all active processes
   */
  public async checkAndEnforce(): Promise<void> {
    const policy = this.getPolicy();
    if (!policy) return;

    const runningProcesses = await this.getRunningProcessNames();
    const intervalSec = Math.round((this.options.checkIntervalMs || 5000) / 1000);

    for (const proc of runningProcesses) {
      const result = this.evaluateProcess(proc, policy);

      // Increment tracking if running
      const key = proc.toLowerCase();
      const state = this.usageTracker.get(key);
      if (state) {
        state.consumedSeconds += intervalSec;
      }

      if (result.action === 'TERMINATE') {
        console.log(`[Process Limiter] ⚠️ Enforcing limit for ${proc}: ${result.reason} (Consumed: ${Math.round(result.consumedSeconds / 60)}m / ${Math.round(result.limitSeconds / 60)}m)`);
        await this.terminateProcess(proc);
      } else if (result.action === 'WARN_5MIN' || result.action === 'WARN_1MIN') {
        console.log(`[Process Limiter] 🔔 Child Warning for ${proc}: ${Math.round(result.remainingSeconds / 60)} minutes remaining today.`);
      }
    }
  }

  /**
   * Sync active usage stats to backend
   */
  public async syncUsageToBackend(): Promise<void> {
    const today = this.getTodayDateString();
    for (const [proc, state] of this.usageTracker.entries()) {
      if (state.lastDate === today && state.consumedSeconds > 0) {
        try {
          await fetch(`${this.config.backendUrl}/api/usage/session`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-device-id': this.config.deviceId,
              'x-device-token': this.config.deviceToken,
            },
            body: JSON.stringify({
              childId: this.config.childId,
              deviceId: this.config.deviceId,
              appName: proc,
              durationSeconds: state.consumedSeconds,
              date: today,
            }),
          });
        } catch {}
      }
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.checkTimer = setInterval(() => {
      this.checkAndEnforce().catch(() => {});
    }, this.options.checkIntervalMs);

    this.syncTimer = setInterval(() => {
      this.syncUsageToBackend().catch(() => {});
    }, this.options.syncIntervalMs);

    console.log(`[Process Limiter] 🎮 Windows Application Watchdog running (Polling interval: ${this.options.checkIntervalMs}ms)`);
  }

  public stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.checkTimer = null;
    this.syncTimer = null;
    this.isRunning = false;
    console.log('[Process Limiter] Windows Application Watchdog stopped.');
  }

  public getUsageState(processName: string): ProcessUsageState | undefined {
    return this.usageTracker.get(processName.toLowerCase());
  }

  public setUsageState(processName: string, state: ProcessUsageState): void {
    this.usageTracker.set(processName.toLowerCase(), state);
  }
}
