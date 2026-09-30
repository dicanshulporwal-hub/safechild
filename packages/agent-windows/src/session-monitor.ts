import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { accountManager, WindowsAccountManager, ResolvedUserPolicy, MultiSessionCheckResult } from './account-manager';
import { configManager } from './config-manager';
import { logServiceMessage } from './network-manager';

const execFileAsync = promisify(execFile);

export type SessionChangeCallback = (userPolicy: ResolvedUserPolicy, previousPolicy: ResolvedUserPolicy | null) => void;

export class WindowsSessionMonitor {
  private checkIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private currentResolvedPolicy: ResolvedUserPolicy | null = null;
  private multiSessionState: MultiSessionCheckResult = {
    hasMultipleSessions: false,
    sessionCount: 1,
    activeUsers: [],
    warning: null,
  };
  private callbacks: SessionChangeCallback[] = [];
  private isRunning: boolean = false;
  private customDnsFlushFn: (() => Promise<void>) | null = null;
  private accountMgr: WindowsAccountManager;

  constructor(checkIntervalMs: number = 2500, accountMgr?: WindowsAccountManager) {
    this.checkIntervalMs = checkIntervalMs;
    this.accountMgr = accountMgr || accountManager;
  }

  public setAccountManagerForTesting(mgr: WindowsAccountManager): void {
    this.accountMgr = mgr;
  }

  public setDnsFlushForTesting(flushFn: (() => Promise<void>) | null): void {
    this.customDnsFlushFn = flushFn;
  }

  public setFlushDnsHandlerForTesting(flushFn: (() => Promise<void> | void) | null): void {
    if (flushFn) {
      this.customDnsFlushFn = async () => { await flushFn(); };
    } else {
      this.customDnsFlushFn = null;
    }
  }

  public setMockConsoleUser(username: string, sid: string): void {
    this.accountMgr.setMockConsoleSidForTesting(sid);
  }

  public async pollActiveSession(): Promise<ResolvedUserPolicy> {
    return this.checkSessionNow();
  }

  public onSessionChange(callback: SessionChangeCallback): void {
    this.callbacks.push(callback);
  }

  public getCurrentPolicy(): ResolvedUserPolicy | null {
    return this.currentResolvedPolicy;
  }

  public getMultiSessionState(): MultiSessionCheckResult {
    return this.multiSessionState;
  }

  public hasMultipleSessions(): boolean {
    return this.multiSessionState.hasMultipleSessions;
  }

  public getSessionWarning(): string | null {
    return this.multiSessionState.warning;
  }

  /**
   * Flushes local Windows DNS client cache to guarantee that cached DNS resolutions
   * from one Windows account do not leak across Fast User Switching (FUS).
   */
  public async flushDnsCache(): Promise<void> {
    if (this.customDnsFlushFn) {
      await this.customDnsFlushFn();
      return;
    }

    if (process.platform !== 'win32') {
      logServiceMessage('INFO', '[SessionMonitor] DNS cache flush simulated for user transition.');
      return;
    }

    try {
      const psPath = configManager.getPowerShellPath();
      await execFileAsync(psPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Clear-DnsClientCache -ErrorAction SilentlyContinue',
      ]);
      logServiceMessage('INFO', '[SessionMonitor] [OK] Windows DNS client cache successfully flushed on user switch.');
    } catch (err: any) {
      logServiceMessage('WARN', `[SessionMonitor] DNS cache flush notice: ${err.message}`);
    }
  }

  /**
   * Performs an immediate active console user check.
   * If a change in user or policy mapping is detected:
   * 1. Flushes local DNS cache immediately.
   * 2. Fires all session change callbacks.
   */
  public async checkSessionNow(): Promise<ResolvedUserPolicy> {
    const resolved = await this.accountMgr.resolveUserPolicy();
    const prev = this.currentResolvedPolicy;

    // Evaluate concurrent interactive user sessions (Multi-Session Safety Guard)
    const multiCheck = await this.accountMgr.detectMultipleInteractiveSessions();
    const hadMultiple = this.multiSessionState.hasMultipleSessions;
    this.multiSessionState = multiCheck;

    if (multiCheck.hasMultipleSessions && !hadMultiple) {
      logServiceMessage(
        'WARN',
        `[SessionMonitor] [ATTENTION_REQUIRED] Multiple Windows users are currently signed in: ${multiCheck.activeUsers.join(', ')}. Sign out other Windows users for reliable SafeBrowse protection.`
      );
    } else if (!multiCheck.hasMultipleSessions && hadMultiple) {
      logServiceMessage(
        'INFO',
        `[SessionMonitor] Concurrent session condition cleared. Single active user detected: ${resolved.accountName}.`
      );
    }

    const userChanged =
      !prev ||
      prev.sid !== resolved.sid ||
      prev.accountName !== resolved.accountName ||
      prev.isManaged !== resolved.isManaged ||
      prev.childId !== resolved.childId ||
      multiCheck.hasMultipleSessions !== hadMultiple;

    if (userChanged) {
      this.currentResolvedPolicy = resolved;

      if (prev !== null) {
        logServiceMessage(
          'INFO',
          `[SessionMonitor] Windows Console User Transition: ${prev.accountName} (${prev.sid || 'N/A'}) -> ${resolved.accountName} (${resolved.sid || 'N/A'})`
        );
        if (resolved.isManaged) {
          logServiceMessage(
            'INFO',
            `[SessionMonitor] Managed Child Active: ${resolved.childName} (${resolved.childId}). Applying child filtering policy.`
          );
        } else {
          logServiceMessage(
            'INFO',
            `[SessionMonitor] Unmanaged / Parent Account Active: ${resolved.accountName}. SafeBrowse child restrictions BYPASSED (transparent mode).`
          );
        }
      }

      // Flush DNS resolver cache on user registration and transition
      await this.flushDnsCache();

      for (const cb of this.callbacks) {
        try {
          cb(resolved, prev);
        } catch (e: any) {
          console.error(`[SessionMonitor] Error in session callback: ${e.message}`);
        }
      }
    }

    return resolved;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial check
    this.checkSessionNow().catch(() => {});

    // Periodic check loop
    this.timer = setInterval(() => {
      this.checkSessionNow().catch(() => {});
    }, this.checkIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const sessionMonitor = new WindowsSessionMonitor();
