import { exec } from 'child_process';
import { promisify } from 'util';
import { Policy, UsageBudget } from '@safebrowse/shared';
import { DeviceConfig } from './sync-client';
import { sessionMonitor } from './session-monitor';
import { ResolvedUserPolicy } from './account-manager';

const execAsync = promisify(exec);

export interface ProcessUsageState {
  processName: string;
  consumedSeconds: number;
  lastDate: string; // 'YYYY-MM-DD'
  warned5Min: boolean;
  warned1Min: boolean;
}

export interface ProcessInfo {
  pid: number;
  imageName: string;
  userName?: string;
  sessionId?: number;
}

export interface ProcessLimiterOptions {
  checkIntervalMs?: number;
  syncIntervalMs?: number;
  simulate?: boolean; // For testing without killing system processes
  getActiveUserPolicy?: () => ResolvedUserPolicy | null;
  hasMultipleSessions?: () => boolean;
}

/**
 * Immutable protected Windows system, core shell, and SafeBrowse service binaries.
 * Attempting to terminate any process in this list is strictly forbidden and fail-safe rejected.
 */
export const PROTECTED_SYSTEM_PROCESSES: ReadonlySet<string> = new Set([
  'system',
  'system idle process',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'lsaiso.exe',
  'svchost.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'explorer.exe',
  'taskhostw.exe',
  'sihost.exe',
  'conhost.exe',
  'audiodg.exe',
  'searchhost.exe',
  'searchindexer.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
  'runtimebroker.exe',
  'applicationframehost.exe',
  'ctfmon.exe',
  'spoolsv.exe',
  'taskmgr.exe',
  'securityhealthsystray.exe',
  'securityhealthservice.exe',
  'msmpeng.exe',
  'dllhost.exe',
  'smartscreen.exe',
  'userinit.exe',
  'logonui.exe',
  'werfault.exe',
  'wlanext.exe',
  'dashost.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'safebrowsechild-pilot.exe',
  'safebrowseservicehost.exe',
  'safebrowsechildservice.exe',
  'safebrowsechildservice',
  'node.exe',
]);

/**
 * Verifies whether an image name belongs to protected Windows system or SafeBrowse binaries.
 */
export function isProtectedProcess(imageName: string): boolean {
  if (!imageName) return true;
  const lower = imageName.trim().toLowerCase();
  const withExe = lower.endsWith('.exe') ? lower : `${lower}.exe`;
  const withoutExe = lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
  return (
    PROTECTED_SYSTEM_PROCESSES.has(lower) ||
    PROTECTED_SYSTEM_PROCESSES.has(withExe) ||
    PROTECTED_SYSTEM_PROCESSES.has(withoutExe)
  );
}

export class WindowsProcessLimiter {
  private config: DeviceConfig;
  private getPolicy: () => Policy | null;
  private options: ProcessLimiterOptions;
  private usageTracker: Map<string, ProcessUsageState> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private mockProcesses: ProcessInfo[] | null = null;

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
      getActiveUserPolicy: options.getActiveUserPolicy,
      hasMultipleSessions: options.hasMultipleSessions,
    };
  }

  public setMockProcesses(processes: Array<string | ProcessInfo> | null): void {
    if (processes === null) {
      this.mockProcesses = null;
      return;
    }
    this.mockProcesses = processes.map((item, idx) => {
      if (typeof item === 'string') {
        return {
          pid: 2000 + idx,
          imageName: item,
          userName: 'ChildUser',
          sessionId: 1,
        };
      }
      return item;
    });
  }

  private getTodayDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Helper to parse CSV lines produced by tasklist /FO CSV
   */
  public parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      fields.push(match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : ''));
      if (regex.lastIndex === match.index) {
        regex.lastIndex++;
      }
    }
    return fields;
  }

  /**
   * Enumerate currently running processes with PID, image name, user name, and session ID.
   */
  public async getRunningProcesses(): Promise<ProcessInfo[]> {
    if (this.mockProcesses !== null) {
      return [...this.mockProcesses];
    }

    if (process.platform !== 'win32') {
      return [];
    }

    try {
      // tasklist /V in CSV format: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
      const { stdout } = await execAsync('tasklist /V /FO CSV /NH');
      const lines = stdout.split(/\r?\n/);
      const results: ProcessInfo[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        const cols = this.parseCsvLine(line);
        if (cols.length >= 2) {
          const imageName = (cols[0] || '').toLowerCase().trim();
          const pid = parseInt(cols[1], 10);
          const sessionId = cols.length > 3 ? parseInt(cols[3], 10) : undefined;
          const userName = cols.length > 6 ? cols[6].trim() : undefined;

          if (!isNaN(pid) && imageName) {
            results.push({
              pid,
              imageName,
              userName,
              sessionId: isNaN(sessionId as number) ? undefined : sessionId,
            });
          }
        }
      }
      return results;
    } catch (e: any) {
      console.warn(`[Process Limiter] Failed to enumerate processes with tasklist /V: ${e.message}`);
      // Fallback to basic tasklist /FO CSV /NH if /V failed
      try {
        const { stdout } = await execAsync('tasklist /FO CSV /NH');
        const lines = stdout.split(/\r?\n/);
        const results: ProcessInfo[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const cols = this.parseCsvLine(line);
          if (cols.length >= 2) {
            const imageName = (cols[0] || '').toLowerCase().trim();
            const pid = parseInt(cols[1], 10);
            if (!isNaN(pid) && imageName) {
              results.push({ pid, imageName });
            }
          }
        }
        return results;
      } catch (err: any) {
        console.warn(`[Process Limiter] Failed fallback process enumeration: ${err.message}`);
        return [];
      }
    }
  }

  /**
   * Enumerate currently running process image names (lowercase)
   */
  public async getRunningProcessNames(): Promise<string[]> {
    const list = await this.getRunningProcesses();
    return Array.from(new Set(list.map((p) => p.imageName.toLowerCase())));
  }

  /**
   * Terminate a specific process strictly by PID with full verification.
   * NEVER uses /IM or image-wide taskkill.
   * Fail-safe refuses termination of system processes, PID <= 4, or unverified owners.
   */
  public async terminateProcessByPid(
    pid: number,
    imageName: string,
    processUserName?: string,
    expectedUserName?: string
  ): Promise<boolean> {
    if (pid <= 4) {
      console.warn(`[Process Limiter] 🛡️ REFUSED: Cannot terminate system PID ${pid} (${imageName})`);
      return false;
    }

    if (isProtectedProcess(imageName)) {
      console.warn(
        `[Process Limiter] 🛡️ REFUSED: Protected system process ${imageName} cannot be terminated (PROTECTED_PROCESS)`
      );
      return false;
    }

    // Verify process ownership if usernames are provided
    if (processUserName && expectedUserName) {
      const cleanProcUser = processUserName.includes('\\')
        ? processUserName.split('\\')[1].toLowerCase().trim()
        : processUserName.toLowerCase().trim();
      const cleanExpected = expectedUserName.includes('\\')
        ? expectedUserName.split('\\')[1].toLowerCase().trim()
        : expectedUserName.toLowerCase().trim();

      if (cleanProcUser !== cleanExpected) {
        console.warn(
          `[Process Limiter] 🛡️ REFUSED: Process PID ${pid} (${imageName}) owner '${processUserName}' does not match expected managed child '${expectedUserName}'`
        );
        return false;
      }
    }

    console.log(`[Process Limiter] 🛑 HARD TERMINATING CHILD PROCESS: ${imageName} (PID ${pid})`);

    if (this.options.simulate || process.platform !== 'win32') {
      if (this.mockProcesses) {
        this.mockProcesses = this.mockProcesses.filter((p) => p.pid !== pid);
      }
      return true;
    }

    try {
      // STRICTLY PID TARGETED taskkill - NEVER /IM, NEVER image-wide!
      await execAsync(`taskkill /F /PID ${pid}`);
      return true;
    } catch (e: any) {
      console.warn(`[Process Limiter] taskkill notice for PID ${pid} (${imageName}): ${e.message}`);
      return false;
    }
  }

  /**
   * Legacy helper: terminate running child process matching image name.
   * Safely discovers candidate PIDs and invokes terminateProcessByPid.
   * Refuses to kill protected system processes.
   */
  public async terminateProcess(imageName: string): Promise<boolean> {
    if (isProtectedProcess(imageName)) {
      console.warn(
        `[Process Limiter] 🛡️ REFUSED: Protected system process ${imageName} cannot be terminated (PROTECTED_PROCESS)`
      );
      return false;
    }

    const procs = await this.getRunningProcesses();
    const targets = procs.filter((p) => {
      const k = p.imageName.toLowerCase();
      const targetKey = imageName.toLowerCase();
      return k === targetKey || k === `${targetKey}.exe` || `${k}.exe` === targetKey;
    });

    if (targets.length === 0) {
      if (this.options.simulate || process.platform !== 'win32') {
        if (this.mockProcesses) {
          this.mockProcesses = this.mockProcesses.filter(
            (p) => p.imageName.toLowerCase() !== imageName.toLowerCase()
          );
        }
        return true;
      }
      return false;
    }

    let allKilled = true;
    const activeUser = this.options.getActiveUserPolicy
      ? this.options.getActiveUserPolicy()
      : sessionMonitor.getCurrentPolicy();

    for (const target of targets) {
      const success = await this.terminateProcessByPid(
        target.pid,
        target.imageName,
        target.userName,
        activeUser?.accountName
      );
      if (!success) {
        allKilled = false;
      }
    }
    return allKilled;
  }

  /**
   * Evaluate a single process against active budget and policies.
   *
   * ARCHITECTURAL RULE:
   * Dinner Time (isPaused) and Bedtime curfew MUST NEVER TERMINATE PROCESSES.
   * They are strictly network-level restrictions handled by loopback DNS.
   * ZERO process termination for Dinner Time or Bedtime.
   *
   * Scope is strictly narrowed to explicit targetType === 'APP' budget exhaustion.
   */
  public evaluateProcess(
    processName: string,
    policy: Policy,
    _now: Date = new Date()
  ): {
    action: 'ALLOW' | 'WARN_5MIN' | 'WARN_1MIN' | 'TERMINATE';
    reason: string;
    consumedSeconds: number;
    limitSeconds: number;
    remainingSeconds: number;
  } {
    const today = this.getTodayDateString();
    const key = processName.toLowerCase();

    // 1. Immutable System Process Protection Guard
    if (isProtectedProcess(key)) {
      return {
        action: 'ALLOW',
        reason: 'PROTECTED_PROCESS',
        consumedSeconds: 0,
        limitSeconds: Infinity,
        remainingSeconds: Infinity,
      };
    }

    // 2. Find matching usage budget: strictly narrow to APP targetType
    const budgets: UsageBudget[] = (policy.usageBudgets as any[]) || [];
    const matchedBudget = budgets.find((b) => {
      if (!b.enabled) return false;
      // Reject non-APP budgets: DOMAIN and CATEGORY budgets must never terminate processes
      if (b.targetType && b.targetType !== 'APP') return false;
      if (!b.targetType) {
        const t = b.target.toLowerCase();
        if (t.includes('.') && !t.endsWith('.exe')) return false; // e.g. 'youtube.com'
        if (
          ['ADULT_CONTENT', 'GAMBLING', 'GAMES', 'SOCIAL_MEDIA', 'EDUCATION', 'STREAMING'].includes(
            b.target.toUpperCase()
          )
        ) {
          return false;
        }
      }
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

    const totalAllowedSeconds =
      (matchedBudget.dailyLimitSeconds || 3600) + (matchedBudget.bonusSeconds || 0);
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
    // 1. Safety Guard: Check multi-session condition (Fast User Switching)
    const hasMultiple = this.options.hasMultipleSessions
      ? this.options.hasMultipleSessions()
      : sessionMonitor.hasMultipleSessions();
    if (hasMultiple) {
      console.log(
        '[Process Limiter] ⚠️ Multiple interactive Windows sessions detected. Process enforcement suspended for safety.'
      );
      return;
    }

    // 2. Safety Guard: Check active console user policy
    const activeUser = this.options.getActiveUserPolicy
      ? this.options.getActiveUserPolicy()
      : sessionMonitor.getCurrentPolicy();
    if (activeUser && !activeUser.isManaged) {
      // Parent or unmanaged user is active at console: zero enforcement
      return;
    }

    const policy = this.getPolicy();
    if (!policy) return;

    // 3. Enumerate running processes
    const runningProcesses = await this.getRunningProcesses();
    const intervalSec = Math.round((this.options.checkIntervalMs || 5000) / 1000);

    // Group by process name so usage tracking counts each app once per interval
    const seenNamesInThisTick = new Set<string>();

    for (const proc of runningProcesses) {
      const key = proc.imageName.toLowerCase();

      // Protected processes are never evaluated or tracked
      if (isProtectedProcess(key)) {
        continue;
      }

      // Check ownership if username is known
      if (activeUser && proc.userName) {
        const cleanProcUser = proc.userName.includes('\\')
          ? proc.userName.split('\\')[1].toLowerCase().trim()
          : proc.userName.toLowerCase().trim();
        const cleanActive = activeUser.accountName.toLowerCase().trim();
        if (cleanProcUser !== cleanActive) {
          // Process does not belong to active managed child (e.g. SYSTEM or Parent user)
          continue;
        }
      }

      const result = this.evaluateProcess(proc.imageName, policy);

      // Increment tracking once per interval for this app name
      if (!seenNamesInThisTick.has(key)) {
        seenNamesInThisTick.add(key);
        const state = this.usageTracker.get(key);
        if (state) {
          state.consumedSeconds += intervalSec;
        }
      }

      if (result.action === 'TERMINATE') {
        console.log(
          `[Process Limiter] ⚠️ Enforcing limit for ${proc.imageName} (PID ${proc.pid}): ${result.reason} (Consumed: ${Math.round(result.consumedSeconds / 60)}m / ${Math.round(result.limitSeconds / 60)}m)`
        );
        await this.terminateProcessByPid(
          proc.pid,
          proc.imageName,
          proc.userName,
          activeUser?.accountName
        );
      } else if (result.action === 'WARN_5MIN' || result.action === 'WARN_1MIN') {
        console.log(
          `[Process Limiter] 🔔 Child Warning for ${proc.imageName}: ${Math.round(result.remainingSeconds / 60)} minutes remaining today.`
        );
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

    console.log(
      `[Process Limiter] 🎮 Windows Application Watchdog running (Polling interval: ${this.options.checkIntervalMs}ms)`
    );
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

