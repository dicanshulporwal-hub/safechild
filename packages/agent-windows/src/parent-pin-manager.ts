import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { configManager, ConfigManager } from './config-manager';
import { logServiceMessage } from './network-manager';

export interface PinVerifierRecord {
  salt: string;
  verifier: string;
  kdf: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagementSession {
  token: string;
  createdAt: number;
  expiresAt: number;
  boundSid?: string;
  boundUsername?: string;
}

export class ParentPinManager {
  private configMgr: ConfigManager;
  private customPinFilePath: string | null = null;
  private activeSession: ManagementSession | null = null;
  private failedAttempts = 0;
  private lockedUntil = 0;
  public static readonly SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
  public static readonly MAX_FAILED_ATTEMPTS = 3;
  public static readonly LOCKOUT_MS = 60 * 1000; // 60-second local retry lockout

  constructor(customConfigMgr?: ConfigManager, customPinFilePath?: string) {
    this.configMgr = customConfigMgr || configManager;
    this.customPinFilePath = customPinFilePath || null;
  }

  private getPinFilePath(): string {
    if (this.customPinFilePath) {
      return this.customPinFilePath;
    }
    return path.join(this.configMgr.getSecureDir(), 'parent-pin.json');
  }

  /**
   * Returns true if a Parent PIN has been created and persisted.
   */
  public async isPinSet(): Promise<boolean> {
    try {
      const pinPath = this.getPinFilePath();
      if (!fs.existsSync(pinPath)) {
        return false;
      }
      const raw = fs.readFileSync(pinPath, 'utf8');
      const data = JSON.parse(raw);
      return Boolean(data && data.salt && data.verifier);
    } catch (err: any) {
      logServiceMessage('WARN', `[ParentPinManager] isPinSet check failed on ${this.getPinFilePath()}: ${err.message}`);
      return false;
    }
  }

  /**
   * Sets or changes the SafeBrowse Parent PIN using a salted KDF verifier.
   * PIN must be 6 to 8 digits. Never persists plaintext PIN.
   */
  public async setPin(pin: string): Promise<void> {
    const cleanPin = String(pin || '').trim();
    if (!/^\d{6,8}$/.test(cleanPin)) {
      throw new Error('SafeBrowse Parent PIN must be between 6 and 8 numeric digits.');
    }

    const salt = crypto.randomBytes(32).toString('hex');
    const verifier = crypto
      .pbkdf2Sync(cleanPin, salt, 100000, 32, 'sha256')
      .toString('hex');

    const record: PinVerifierRecord = {
      salt,
      verifier,
      kdf: 'pbkdf2-sha256-100k',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const pinPath = this.getPinFilePath();
    const dir = path.dirname(pinPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${pinPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tempPath, pinPath);

    // Apply strict ACLs on Windows: SYSTEM & Administrators only
    if (process.platform === 'win32' || this.configMgr.getPlatform() === 'win32') {
      try {
        this.configMgr.applyWindowsAcls(dir, 'secure');
        this.configMgr.applyWindowsAcls(pinPath, 'secure');
      } catch (aclErr: any) {
        logServiceMessage('WARN', `[ParentPinManager] ACL warning: ${aclErr.message}`);
      }
    }

    // Invalidate existing sessions on PIN change
    this.invalidateSession();
    logServiceMessage('INFO', '[ParentPinManager] SafeBrowse Parent PIN verifier securely stored.');
  }

  /**
   * Verifies the entered PIN against the salted KDF verifier.
   * On success, generates a short-lived in-memory management session token.
   */
  public async verifyPin(
    pin: string,
    boundSid?: string,
    boundUsername?: string
  ): Promise<{
    success: boolean;
    sessionToken?: string;
    error?: string;
    attemptsRemaining?: number;
    retryAfterMs?: number;
    locked?: boolean;
  }> {
    const now = Date.now();
    if (this.lockedUntil > now) {
      return {
        success: false,
        error: 'Too many incorrect PIN attempts. Try again shortly.',
        attemptsRemaining: 0,
        retryAfterMs: this.lockedUntil - now,
        locked: true,
      };
    }
    if (this.lockedUntil && this.lockedUntil <= now) {
      this.failedAttempts = 0;
      this.lockedUntil = 0;
    }

    const cleanPin = String(pin || '').trim();
    if (!/^\d{6,8}$/.test(cleanPin)) {
      return { success: false, error: 'Invalid PIN format. PIN must be 6-8 digits.' };
    }

    const pinPath = this.getPinFilePath();
    if (!fs.existsSync(pinPath)) {
      return {
        success: false,
        error: 'SafeBrowse Parent PIN has not been configured. Protected management is locked.',
      };
    }

    let record: PinVerifierRecord;
    try {
      const raw = fs.readFileSync(pinPath, 'utf8');
      record = JSON.parse(raw);
      if (!record || !record.salt || !record.verifier) {
        return { success: false, error: 'Corrupted PIN verifier record.' };
      }
    } catch {
      return { success: false, error: 'Failed to read PIN verifier.' };
    }

    const candidateHash = crypto
      .pbkdf2Sync(cleanPin, record.salt, 100000, 32, 'sha256')
      .toString('hex');

    const expectedBuf = Buffer.from(record.verifier, 'utf8');
    const candidateBuf = Buffer.from(candidateHash, 'utf8');

    if (
      expectedBuf.length !== candidateBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, candidateBuf)
    ) {
      this.failedAttempts += 1;
      const attemptsRemaining = Math.max(0, ParentPinManager.MAX_FAILED_ATTEMPTS - this.failedAttempts);
      if (attemptsRemaining === 0) {
        this.lockedUntil = Date.now() + ParentPinManager.LOCKOUT_MS;
        logServiceMessage('WARN', '[ParentPinManager] Parent PIN locked temporarily after 3 incorrect attempts.');
        return {
          success: false,
          error: 'Incorrect SafeBrowse Parent PIN. Too many attempts; PIN entry is temporarily locked.',
          attemptsRemaining: 0,
          retryAfterMs: ParentPinManager.LOCKOUT_MS,
          locked: true,
        };
      }
      logServiceMessage('WARN', `[ParentPinManager] Parent PIN verification failed. ${attemptsRemaining} attempt(s) remaining.`);
      return {
        success: false,
        error: `Incorrect SafeBrowse Parent PIN. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining.`,
        attemptsRemaining,
        locked: false,
      };
    }

    // Successful verification clears the local failure counter.
    this.failedAttempts = 0;
    this.lockedUntil = 0;

    // Generate short-lived management session
    const token = `mgmt_${crypto.randomBytes(24).toString('hex')}`;
    this.activeSession = {
      token,
      createdAt: now,
      expiresAt: now + ParentPinManager.SESSION_TTL_MS,
      boundSid,
      boundUsername,
    };

    logServiceMessage('INFO', '[ParentPinManager] Parent PIN verified. Temporary management session unlocked.');
    return { success: true, sessionToken: token };
  }

  /**
   * Validates an active in-memory management session token.
   * Returns false if token is expired, invalid, absent, or if console user switched.
   */
  public validateSession(sessionToken?: string, currentSid?: string): boolean {
    if (!sessionToken || !this.activeSession) {
      return false;
    }
    if (this.activeSession.token !== sessionToken) {
      return false;
    }
    if (Date.now() > this.activeSession.expiresAt) {
      this.invalidateSession();
      return false;
    }
    if (currentSid && this.activeSession.boundSid && this.activeSession.boundSid !== currentSid) {
      logServiceMessage(
        'WARN',
        `[ParentPinManager] Management session invalidated due to user switch (bound: ${this.activeSession.boundSid}, current: ${currentSid}).`
      );
      this.invalidateSession();
      return false;
    }
    return true;
  }

  public getActiveSession(): ManagementSession | null {
    return this.activeSession;
  }

  /**
   * Invalidates the active management session (e.g. on timeout, lock, switch user, or logout).
   */
  public invalidateSession(sessionToken?: string): void {
    if (!sessionToken || (this.activeSession && this.activeSession.token === sessionToken)) {
      this.activeSession = null;
    }
  }

  /**
   * Resets PIN using cloud-authorized reset or disconnect workflow.
   */
  public async clearPin(): Promise<void> {
    this.invalidateSession();
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    try {
      const pinPath = this.getPinFilePath();
      if (fs.existsSync(pinPath)) {
        fs.unlinkSync(pinPath);
      }
    } catch {}
  }
}

export const parentPinManager = new ParentPinManager();
