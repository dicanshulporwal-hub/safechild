import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { configManager } from './config-manager';

const execFileAsync = promisify(execFile);

export interface WindowsAccount {
  name: string;
  sid: string;
  disabled: boolean;
  isCurrentConsoleUser?: boolean;
}

export interface WindowsProfileMapping {
  windowsSid: string;
  windowsUsername: string;
  childId: string | null; // null represents Parent / Unmanaged
  childName?: string | null;
  enabled: boolean;
}

export interface FamilyChildProfile {
  id: string;
  name: string;
  age?: number | null;
  color?: string | null;
  avatar?: string | null;
  policyId?: string | null;
}

export interface FamilyProfilesResponse {
  profiles: FamilyChildProfile[];
  cachedAt?: string;
  fromCache?: boolean;
}

export interface SharedLaptopConfig {
  deviceId: string;
  deviceName?: string;
  mappings: WindowsProfileMapping[];
  updatedAt: string;
}

export interface MappingSaveRequestPayload {
  nonce: string;
  timestamp: string; // ISO 8601
  deviceId: string;
  deviceName?: string;
  mappings: WindowsProfileMapping[];
  payloadHash: string;
}

export function canonicalizeMappings(mappings: WindowsProfileMapping[]): string {
  const sorted = [...mappings].sort((a, b) => (a.windowsSid || '').localeCompare(b.windowsSid || ''));
  const normalized = sorted.map((m) => ({
    childId: m.childId ?? null,
    childName: m.childName ?? null,
    enabled: Boolean(m.enabled && m.childId),
    windowsSid: (m.windowsSid || '').trim().toUpperCase(),
    windowsUsername: (m.windowsUsername || '').trim(),
  }));
  return JSON.stringify(normalized);
}

export function computeMappingPayloadHash(
  nonce: string,
  timestamp: string,
  deviceId: string,
  mappings: WindowsProfileMapping[]
): string {
  const canonicalJson = canonicalizeMappings(mappings);
  const data = `${nonce}:${timestamp}:${deviceId}:${canonicalJson}`;
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export interface ResolvedUserPolicy {
  isManaged: boolean;
  childId: string | null;
  childName: string | null;
  accountName: string;
  sid: string;
}

export interface MultiSessionCheckResult {
  hasMultipleSessions: boolean;
  sessionCount: number;
  activeUsers: string[];
  warning: string | null;
}

export class WindowsAccountManager {
  private customBaseDir: string | null = null;
  private mockAccounts: WindowsAccount[] | null = null;
  private mockConsoleSid: string | null = null;
  private mockInteractiveSessions: string[] | null = null;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      this.customBaseDir = customBaseDir;
    }
  }

  public setMockAccountsForTesting(accounts: WindowsAccount[] | null): void {
    this.mockAccounts = accounts;
  }

  public setMockConsoleSidForTesting(sid: string | null): void {
    this.mockConsoleSid = sid;
  }

  private customStagingDir: string | null = null;

  public setMockInteractiveSessionsForTesting(sessions: string[] | null): void {
    this.mockInteractiveSessions = sessions;
  }

  public setStagingDirForTesting(stagingDir: string | null): void {
    this.customStagingDir = stagingDir;
  }

  public getStagingDir(): string {
    if (this.customStagingDir) {
      return this.customStagingDir;
    }
    return os.tmpdir();
  }

  public getStateDir(): string {
    if (this.customBaseDir) {
      return path.join(this.customBaseDir, 'state');
    }
    return configManager.getStateDir();
  }

  public getMappingsFilePath(): string {
    return path.join(this.getStateDir(), 'profile-mappings.json');
  }

  public getActiveSessionFilePath(): string {
    return path.join(this.getStateDir(), 'active-session.json');
  }

  public getProfilesCacheFilePath(): string {
    return path.join(this.getStateDir(), 'family-profiles-cache.json');
  }

  /**
   * Reads persistent local cache of family child profiles.
   */
  public async getCachedFamilyProfiles(): Promise<{ profiles: FamilyChildProfile[]; cachedAt: string } | null> {
    let filePath = this.getProfilesCacheFilePath();
    if (!fs.existsSync(filePath)) {
      const legacyPath = path.join(this.customBaseDir || configManager.getBaseDir(), 'family-profiles-cache.json');
      if (fs.existsSync(legacyPath)) {
        filePath = legacyPath;
      } else {
        return null;
      }
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.profiles)) {
        return {
          profiles: data.profiles,
          cachedAt: data.cachedAt || data.updatedAt || new Date().toISOString(),
        };
      }
      if (Array.isArray(data)) {
        return {
          profiles: data,
          cachedAt: new Date().toISOString(),
        };
      }
      return null;
    } catch (err: any) {
      console.warn(`[AccountManager] Failed to read family profiles cache: ${err.message}`);
      return null;
    }
  }

  /**
   * Persists family child profiles to local cache with atomic write (temp -> fsync -> rename).
   */
  public async saveCachedFamilyProfiles(profiles: FamilyChildProfile[]): Promise<void> {
    const stateDir = this.getStateDir();
    if (!fs.existsSync(stateDir)) {
      try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
    }
    configManager.ensureDirectories();

    const filePath = this.getProfilesCacheFilePath();
    const tempFile = path.join(stateDir, `family-profiles-cache.json.tmp.${process.pid}.${Date.now()}`);
    const payload = {
      profiles,
      cachedAt: new Date().toISOString(),
    };

    const content = JSON.stringify(payload, null, 2);
    const fd = fs.openSync(tempFile, 'w');
    try {
      fs.writeSync(fd, content, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempFile, filePath);
  }

  /**
   * Fetches family child profiles from cloud with bounded retry and local cache fallback.
   * Never leaks deviceToken in logs or error messages.
   */
  public async fetchFamilyProfilesWithResilience(
    backendUrl: string,
    deviceId: string,
    deviceToken: string,
    options?: {
      maxRetries?: number;
      retryDelayMs?: number;
      fetchFn?: (url: string, init?: any) => Promise<any>;
    }
  ): Promise<FamilyProfilesResponse> {
    const maxRetries = options?.maxRetries ?? 3;
    const baseDelay = options?.retryDelayMs ?? 300;
    const fetchFunc = options?.fetchFn || fetch;

    const fetchUrl = `${backendUrl}/api/devices/family-profiles`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = attempt === 1 ? baseDelay : baseDelay * 2.5;
        await new Promise((res) => setTimeout(res, delay));
      }

      try {
        const resp = await fetchFunc(fetchUrl, {
          method: 'GET',
          headers: {
            'x-device-id': deviceId,
            'x-device-token': deviceToken,
          },
        });

        if (resp.ok) {
          const body: any = await resp.json();
          const rawProfiles = Array.isArray(body)
            ? body
            : Array.isArray(body?.profiles)
            ? body.profiles
            : null;

          if (rawProfiles !== null) {
            const validProfiles: FamilyChildProfile[] = rawProfiles
              .filter((p: any) => p && typeof p === 'object' && p.id && p.name)
              .map((p: any) => ({
                id: String(p.id),
                name: String(p.name),
                age: typeof p.age === 'number' ? p.age : null,
                color: p.color ? String(p.color) : null,
                avatar: p.avatar ? String(p.avatar) : null,
                policyId: p.policyId ? String(p.policyId) : null,
              }));

            await this.saveCachedFamilyProfiles(validProfiles);
            return {
              profiles: validProfiles,
              fromCache: false,
            };
          }
        } else {
          lastError = new Error(`HTTP ${resp.status} ${resp.statusText}`);
          console.warn(`[AccountManager] Cloud profile fetch attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`);
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[AccountManager] Cloud profile fetch attempt ${attempt + 1}/${maxRetries} failed: ${err.message}`);
      }
    }

    // All cloud attempts failed - attempt persistent local cache fallback
    const cached = await this.getCachedFamilyProfiles();
    if (cached && Array.isArray(cached.profiles) && cached.profiles.length > 0) {
      console.info(
        `[AccountManager] Cloud fetch unavailable. Using previously synchronized family profiles (${cached.profiles.length} profiles from ${cached.cachedAt}).`
      );
      return {
        profiles: cached.profiles,
        fromCache: true,
        cachedAt: cached.cachedAt,
      };
    }

    throw new Error(
      `Unable to load family profiles. Check SafeBrowse connection and retry. (${lastError ? lastError.message : 'No profiles available'})`
    );
  }

  /**
   * Evaluates if a given Windows SID or Username belongs to an internal,
   * system, or service identity that should never be presented to parents.
   */
  public isSystemOrServiceAccount(name: string, sid?: string, disabled?: boolean): boolean {
    if (disabled === true) {
      return true;
    }

    const upperName = (name || '').toUpperCase().trim();

    // Standard Windows Well-Known SIDs for system identities
    if (sid) {
      const cleanSid = sid.trim().toUpperCase();
      if (
        cleanSid === 'S-1-5-18' || // Local System
        cleanSid === 'S-1-5-19' || // Local Service
        cleanSid === 'S-1-5-20' || // Network Service
        cleanSid.startsWith('S-1-5-80-') || // Virtual Service Accounts
        cleanSid.startsWith('S-1-5-82-') || // AppPool
        cleanSid.startsWith('S-1-5-90-') || // Window Manager
        cleanSid.startsWith('S-1-5-96-')    // Font Driver Host
      ) {
        return true;
      }

      // Check well-known Relative Identifiers (RIDs):
      // -500: Built-in Administrator
      // -501: Built-in Guest
      // -503: DefaultAccount
      // -504: WDAGUtilityAccount
      if (
        cleanSid.endsWith('-500') ||
        cleanSid.endsWith('-501') ||
        cleanSid.endsWith('-503') ||
        cleanSid.endsWith('-504')
      ) {
        return true;
      }
    }

    const filteredNames = [
      'SYSTEM',
      'LOCAL SERVICE',
      'NETWORK SERVICE',
      'DEFAULTACCOUNT',
      'WDAGUTILITYACCOUNT',
      'TRUSTEDINSTALLER',
      'ADMINISTRATOR',
      'GUEST',
    ];

    if (filteredNames.includes(upperName)) {
      return true;
    }

    if (
      upperName.startsWith('DWM-') ||
      upperName.startsWith('UMFD-') ||
      upperName.startsWith('IUSR') ||
      upperName.startsWith('IIS_') ||
      upperName.startsWith('WDAG') ||
      upperName.includes('SERVICE') ||
      upperName.includes('SANDBOX')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Securely discovers interactive local and Microsoft user accounts on Windows.
   * Strips out service accounts, system accounts, and utility identities.
   */
  public async discoverAccounts(): Promise<WindowsAccount[]> {
    if (this.mockAccounts) {
      const filtered = this.mockAccounts.filter(
        (acc) => !this.isSystemOrServiceAccount(acc.name, acc.sid, acc.disabled)
      );
      filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return filtered;
    }

    if (process.platform !== 'win32') {
      // Non-Windows simulation: return test accounts for development / testing
      return [
        { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
        { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
        { name: 'Rahul', sid: 'S-1-5-21-1000-1000-1000-1002', disabled: false },
      ];
    }

    const psPath = configManager.getPowerShellPath();
    const psScript = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '$users = @(Get-CimInstance Win32_UserAccount -Filter "LocalAccount = True" | Select-Object Name, SID, Disabled)',
      '$users | ConvertTo-Json -Compress',
    ].join('; ');

    try {
      const { stdout } = await execFileAsync(psPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
      ]);

      const trimmed = (stdout || '').trim();
      if (!trimmed) {
        return [];
      }

      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return [];
      }

      const list = Array.isArray(parsed) ? parsed : [parsed];
      const accounts: WindowsAccount[] = [];

      for (const item of list) {
        if (!item || !item.Name || !item.SID) continue;
        const name = String(item.Name);
        const sid = String(item.SID);
        const disabled = Boolean(item.Disabled);

        if (this.isSystemOrServiceAccount(name, sid, disabled)) {
          continue;
        }

        accounts.push({
          name,
          sid,
          disabled,
        });
      }

      accounts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return accounts;
    } catch (err: any) {
      console.warn(`[AccountManager] Failed to discover Windows accounts via WMI: ${err.message}`);
      return [];
    }
  }

  /**
   * Loads saved profile mappings from disk.
   * Checks state directory first, with fallback to legacy base directory.
   */
  public async loadProfileMappings(): Promise<WindowsProfileMapping[]> {
    let filePath = this.getMappingsFilePath();
    if (!fs.existsSync(filePath)) {
      const legacyPath = path.join(this.customBaseDir || configManager.getBaseDir(), 'profile-mappings.json');
      if (fs.existsSync(legacyPath)) {
        filePath = legacyPath;
      } else {
        return [];
      }
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.mappings)) {
        return data.mappings;
      }
      if (Array.isArray(data)) {
        return data;
      }
      return [];
    } catch (err: any) {
      console.warn(`[AccountManager] Error reading profile mappings: ${err.message}`);
      return [];
    }
  }

  /**
   * Persists profile mappings using an atomic, multi-step transaction with validation,
   * rollback safety, reload verification, privilege-aware ACLs, and cache flushing.
   */
  public async saveProfileMappingsTransaction(
    mappings: WindowsProfileMapping[],
    deviceId?: string,
    deviceName?: string,
    options?: { isElevated?: boolean; skipAcl?: boolean; skipVerification?: boolean }
  ): Promise<{ success: boolean; mappings: WindowsProfileMapping[] }> {
    // Step 1: Input Validation
    if (!Array.isArray(mappings)) {
      throw new Error('Invalid mappings: expected an array.');
    }

    // Step 2 & 3: Entry & SID Validation & Duplicate SID Check
    const seenSids = new Set<string>();
    const sanitizedMappings: WindowsProfileMapping[] = [];

    for (const item of mappings) {
      if (!item || typeof item !== 'object') {
        throw new Error('Invalid mapping entry: expected an object.');
      }
      const sid = String(item.windowsSid || '').trim().toUpperCase();
      const username = String(item.windowsUsername || '').trim();

      if (!sid) {
        throw new Error('Mapping entry is missing a valid Windows SID.');
      }
      if (!username) {
        throw new Error(`Mapping entry for SID ${sid} is missing a Windows username.`);
      }

      // Standard Windows SID format validation: e.g. S-1-5-21-...
      if (!/^S-1-\d+(-\d+)+$/i.test(sid)) {
        throw new Error(`Invalid Windows SID format: '${sid}'`);
      }

      if (seenSids.has(sid)) {
        throw new Error(`Duplicate mapping detected for Windows SID: ${sid}`);
      }
      seenSids.add(sid);

      // Step 4: Child ID Validation
      const childId = item.childId ? String(item.childId).trim() : null;
      const childName = item.childName ? String(item.childName).trim() : null;
      const enabled = Boolean(item.enabled && childId);

      sanitizedMappings.push({
        windowsSid: sid,
        windowsUsername: username,
        childId: childId || null,
        childName: childName || null,
        enabled,
      });
    }

    // Step 5: Directory Preparation (ensures state directory exists)
    const stateDir = this.getStateDir();
    if (!fs.existsSync(stateDir)) {
      try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
    }
    configManager.ensureDirectories();

    const filePath = this.getMappingsFilePath();
    // Step 6: Atomic Temp File Creation in state dir
    const tempFile = path.join(stateDir, `profile-mappings.json.tmp.${process.pid}.${Date.now()}`);

    const payload: SharedLaptopConfig = {
      deviceId: deviceId || 'dev-local',
      deviceName: deviceName || 'Family Laptop',
      mappings: sanitizedMappings,
      updatedAt: new Date().toISOString(),
    };

    try {
      // Step 7: Atomic Write & Flush
      const content = JSON.stringify(payload, null, 2);
      const fd = fs.openSync(tempFile, 'w');
      try {
        fs.writeSync(fd, content, 0, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // Step 8: Atomic Rename
      fs.renameSync(tempFile, filePath);

      // Step 9: Privilege-Aware ACL Application (Elevated/SYSTEM only)
      const isElevated = options?.isElevated ?? (await configManager.isAdministrator());
      if (isElevated && !options?.skipAcl && (process.platform === 'win32' || configManager.getPlatform() === 'win32')) {
        configManager.applyWindowsAcls(filePath, 'state');
      }

      // Step 10: Verification of Reload
      if (!options?.skipVerification) {
        const reloaded = await this.loadProfileMappings();
        if (reloaded.length !== sanitizedMappings.length) {
          throw new Error(
            `Verification failed: Expected ${sanitizedMappings.length} mappings, loaded ${reloaded.length}.`
          );
        }
      }

      // Step 11: Session Monitor Notification & Network DNS Cache Flush
      try {
        const { sessionMonitor } = require('./session-monitor');
        if (sessionMonitor && typeof sessionMonitor.checkSessionNow === 'function') {
          await sessionMonitor.checkSessionNow();
        }
      } catch {}

      try {
        const { networkManager } = require('./network-manager');
        if (networkManager && typeof networkManager.flushDnsCache === 'function') {
          await networkManager.flushDnsCache();
        }
      } catch {}

      return { success: true, mappings: sanitizedMappings };
    } catch (err: any) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      throw err;
    }
  }

  /**
   * Persists profile mappings to disk with secure Windows ACLs.
   */
  public async saveProfileMappings(
    mappings: WindowsProfileMapping[],
    deviceId?: string,
    deviceName?: string
  ): Promise<void> {
    await this.saveProfileMappingsTransaction(mappings, deviceId, deviceName);
  }

  /**
   * Creates a staged mapping save request with single-use nonce, timestamp,
   * deviceId binding, and SHA-256 payload integrity hash.
   */
  public async createMappingSaveRequest(
    mappings: WindowsProfileMapping[],
    deviceId: string,
    deviceName?: string
  ): Promise<{ nonce: string; reqPath: string; payload: MappingSaveRequestPayload }> {
    const nonce = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const payloadHash = computeMappingPayloadHash(nonce, timestamp, deviceId, mappings);

    const stagingDir = this.getStagingDir();
    if (!fs.existsSync(stagingDir)) {
      try {
        fs.mkdirSync(stagingDir, { recursive: true });
      } catch {}
    }

    const reqPath = path.join(stagingDir, `sb-mapping-req-${nonce}.json`);
    const payload: MappingSaveRequestPayload = {
      nonce,
      timestamp,
      deviceId,
      deviceName,
      mappings,
      payloadHash,
    };

    fs.writeFileSync(reqPath, JSON.stringify(payload, null, 2), 'utf8');
    return { nonce, reqPath, payload };
  }

  /**
   * Locates a staged mapping save request by nonce across allowed staging directories.
   * Never accepts arbitrary file paths.
   */
  public findMappingSaveRequest(nonce: string): string | null {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)) {
      throw new Error('Invalid nonce format: must be a valid UUID v4.');
    }

    const candidateDirs = [
      this.getStagingDir(),
      os.tmpdir(),
      process.env.TEMP,
      process.env.TMP,
      path.join(configManager.getBaseDir(), 'staging'),
    ].filter(Boolean) as string[];

    const filename = `sb-mapping-req-${nonce}.json`;

    for (const dir of candidateDirs) {
      const candidatePath = path.join(dir, filename);
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    // Windows fallback: check standard user temp dirs if elevated
    if (process.platform === 'win32') {
      try {
        const usersRoot = process.env.SystemDrive ? `${process.env.SystemDrive}\\Users` : 'C:\\Users';
        if (fs.existsSync(usersRoot)) {
          const userDirs = fs.readdirSync(usersRoot);
          for (const u of userDirs) {
            const userTemp = path.join(usersRoot, u, 'AppData', 'Local', 'Temp', filename);
            if (fs.existsSync(userTemp)) {
              return userTemp;
            }
          }
        }
      } catch {}
    }

    return null;
  }

  /**
   * Applies and persists a staged mapping save request after strict verification:
   * 1. Validate nonce UUID format
   * 2. Locate staged file (reject arbitrary paths)
   * 3. Read and immediately unlink file (replay prevention)
   * 4. Verify timestamp freshness (<= 60 seconds)
   * 5. Verify deviceId matches machine configuration
   * 6. Verify payloadHash matches canonicalized payload
   * 7. Check for duplicate SIDs in payload
   * 8. Validate every SID against discovered machine accounts
   * 9. Validate every childId against authoritative family profiles
   * 10. Atomically write to state/profile-mappings.json
   */
  public async applyMappingSaveRequest(
    nonce: string,
    options?: {
      expectedDeviceId?: string;
      maxAgeMs?: number;
      skipSidValidation?: boolean;
      skipChildIdValidation?: boolean;
    }
  ): Promise<{ success: boolean; mappings: WindowsProfileMapping[] }> {
    // 1. Nonce format validation
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)) {
      throw new Error('Invalid nonce format: must be a valid UUID v4.');
    }

    // 2. Locate staged request file
    const reqPath = this.findMappingSaveRequest(nonce);
    if (!reqPath || !fs.existsSync(reqPath)) {
      throw new Error(`Mapping save request file not found for nonce: ${nonce}`);
    }

    // 3. Immediately read and unlink to prevent replay
    let raw: string;
    try {
      raw = fs.readFileSync(reqPath, 'utf8');
    } finally {
      try {
        fs.unlinkSync(reqPath);
      } catch {}
    }

    let payload: MappingSaveRequestPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Invalid mapping save request: malformed JSON.');
    }

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.mappings)) {
      throw new Error('Invalid mapping save request: missing required payload fields.');
    }

    if (payload.nonce !== nonce) {
      throw new Error(`Nonce mismatch: payload contains '${payload.nonce}', expected '${nonce}'.`);
    }

    // 4. Timestamp freshness verification (default <= 60 seconds)
    const maxAge = options?.maxAgeMs ?? 60000;
    const reqTime = new Date(payload.timestamp).getTime();
    if (isNaN(reqTime)) {
      throw new Error('Invalid mapping save request: malformed timestamp.');
    }
    const ageMs = Date.now() - reqTime;
    if (ageMs > maxAge || ageMs < -15000) {
      throw new Error(`Mapping save request has expired (${Math.round(ageMs / 1000)}s old, max allowed is ${Math.round(maxAge / 1000)}s).`);
    }

    // 5. DeviceId verification
    let expectedDevId = options?.expectedDeviceId;
    if (!expectedDevId) {
      try {
        const sanitized = await configManager.loadSanitizedConfig();
        expectedDevId = sanitized?.deviceId;
      } catch {}
    }
    if (expectedDevId && payload.deviceId && payload.deviceId !== expectedDevId) {
      throw new Error(
        `DeviceId mismatch: request specifies '${payload.deviceId}', but machine is configured with '${expectedDevId}'.`
      );
    }

    // 6. Cryptographic payload hash verification (tamper detection)
    const expectedHash = computeMappingPayloadHash(
      payload.nonce,
      payload.timestamp,
      payload.deviceId,
      payload.mappings
    );
    if (payload.payloadHash !== expectedHash) {
      throw new Error('Payload integrity check failed: payloadHash mismatch (tampering detected).');
    }

    // 7. Duplicate SID check
    const seenSids = new Set<string>();
    for (const m of payload.mappings) {
      const cleanSid = String(m?.windowsSid || '').trim().toUpperCase();
      if (!cleanSid) {
        throw new Error('Mapping entry is missing a valid Windows SID.');
      }
      if (seenSids.has(cleanSid)) {
        throw new Error(`Duplicate mapping detected for Windows SID: ${cleanSid}`);
      }
      seenSids.add(cleanSid);
    }

    // 8. SID existence validation against discovered machine accounts
    if (!options?.skipSidValidation) {
      const discovered = await this.discoverAccounts();
      if (discovered.length > 0) {
        const validSids = new Set(discovered.map((a) => a.sid.toUpperCase()));
        for (const m of payload.mappings) {
          const sid = (m.windowsSid || '').trim().toUpperCase();
          if (!validSids.has(sid)) {
            throw new Error(`Validation error: Windows SID '${m.windowsSid}' is not a valid discovered account on this machine.`);
          }
        }
      }
    }

    // 9. Child ID existence validation against authoritative family profiles
    if (!options?.skipChildIdValidation) {
      const cached = await this.getCachedFamilyProfiles();
      if (cached && Array.isArray(cached.profiles) && cached.profiles.length > 0) {
        const validChildIds = new Set(cached.profiles.map((p) => p.id));
        for (const m of payload.mappings) {
          if (m.childId && !validChildIds.has(m.childId)) {
            throw new Error(`Validation error: Child ID '${m.childId}' does not exist in family profiles.`);
          }
        }
      }
    }

    // 10. Persist validated mappings atomically
    return await this.saveProfileMappingsTransaction(
      payload.mappings,
      payload.deviceId,
      payload.deviceName,
      { isElevated: true }
    );
  }

  /**
   * Looks up mapping for a specific Windows SID.
   */
  public async getMappingForSid(sid: string): Promise<WindowsProfileMapping | null> {
    if (!sid) return null;
    const mappings = await this.loadProfileMappings();
    const cleanSid = sid.trim().toUpperCase();
    return mappings.find((m) => (m.windowsSid || '').trim().toUpperCase() === cleanSid) || null;
  }

  /**
   * Looks up mapping by Windows username.
   */
  public async getMappingForUsername(username: string): Promise<WindowsProfileMapping | null> {
    if (!username) return null;
    const mappings = await this.loadProfileMappings();
    const cleanName = username.trim().toLowerCase();
    return (
      mappings.find(
        (m) =>
          (m.windowsUsername || '').trim().toLowerCase() === cleanName ||
          (m.windowsUsername || '').trim().toLowerCase().endsWith(`\\${cleanName}`)
      ) || null
    );
  }

  /**
   * Queries the currently active console user session.
   * Reads from active-session.json written by SafeBrowseServiceHost.cs
   * or evaluates via fallback.
   */
  public async getActiveConsoleSession(): Promise<{ sid: string | null; username: string | null }> {
    if (this.mockConsoleSid) {
      const mapping = await this.getMappingForSid(this.mockConsoleSid);
      return {
        sid: this.mockConsoleSid,
        username: mapping?.windowsUsername || 'ConsoleUser',
      };
    }

    const sessionFile = this.getActiveSessionFilePath();
    if (fs.existsSync(sessionFile)) {
      try {
        const raw = fs.readFileSync(sessionFile, 'utf8');
        const data = JSON.parse(raw);
        if (data.windowsSid) {
          return {
            sid: data.windowsSid,
            username: data.windowsUsername || null,
          };
        }
      } catch {}
    }

    // Native fallback on Windows when running standalone
    if (process.platform === 'win32') {
      try {
        const psPath = configManager.getPowerShellPath();
        const psCmd = [
          "$ErrorActionPreference = 'SilentlyContinue'",
          '$user = (Get-CimInstance Win32_ComputerSystem | Select-Object -ExpandProperty UserName)',
          'if ($user) {',
          '  $nt = New-Object System.Security.Principal.NTAccount($user)',
          '  $sid = $nt.Translate([System.Security.Principal.SecurityIdentifier]).Value',
          '  @{ UserName = $user; SID = $sid } | ConvertTo-Json -Compress',
          '}',
        ].join('; ');

        const { stdout } = await execFileAsync(psPath, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          psCmd,
        ]);

        const trimmed = (stdout || '').trim();
        if (trimmed) {
          const parsed = JSON.parse(trimmed);
          return {
            sid: parsed.SID || null,
            username: parsed.UserName || null,
          };
        }
      } catch {}
    }

    return { sid: null, username: null };
  }

  /**
   * Resolves the effective policy mode for the active or given user.
   * If the account is not mapped, or mapped with childId: null, or enabled: false,
   * it returns isManaged: false (TRANSPARENT BYPASS for parents/unmanaged users).
   */
  public async resolveUserPolicy(activeSid?: string | null, activeUsername?: string | null): Promise<ResolvedUserPolicy> {
    let sid = activeSid;
    let username = activeUsername;

    if (!sid && !username) {
      const session = await this.getActiveConsoleSession();
      sid = session.sid;
      username = session.username;
    }

    if (!sid && !username) {
      // Default fail-safe: if no user can be determined, default to unmanaged to avoid breaking console
      return {
        isManaged: false,
        childId: null,
        childName: null,
        accountName: 'Unknown',
        sid: '',
      };
    }

    let mapping: WindowsProfileMapping | null = null;
    if (sid) {
      mapping = await this.getMappingForSid(sid);
    }
    if (!mapping && username) {
      mapping = await this.getMappingForUsername(username);
    }

    const resolvedName = username || mapping?.windowsUsername || 'WindowsUser';
    const resolvedSid = sid || mapping?.windowsSid || '';

    if (!mapping || !mapping.enabled || !mapping.childId) {
      // UNMANAGED / PARENT ACCOUNT
      return {
        isManaged: false,
        childId: null,
        childName: null,
        accountName: resolvedName,
        sid: resolvedSid,
      };
    }

    // MANAGED CHILD ACCOUNT
    return {
      isManaged: true,
      childId: mapping.childId,
      childName: mapping.childName || mapping.windowsUsername,
      accountName: resolvedName,
      sid: resolvedSid,
    };
  }

  private mockProcessSids: Map<number, { sid: string; username: string }> = new Map();

  public setMockProcessSidsForTesting(pids: Map<number, { sid: string; username: string }>): void {
    this.mockProcessSids = pids;
  }

  /**
   * Identifies the exact Windows user SID that owns a specific process PID.
   * On Windows, queries process token via Win32 / PowerShell.
   *
   * ARCHITECTURAL LIMITATION NOTE:
   * While process tokens unambiguously attribute application processes (e.g. chrome.exe, roblox.exe)
   * to their respective Windows user SIDs, standard Windows DNS queries sent to loopback 127.0.0.1:53
   * originate from svchost.exe (Dnscache / Network Service) across all user sessions.
   * Therefore, machine-wide loopback DNS alone cannot attribute individual DNS packets
   * during simultaneous concurrent sessions without a Windows Filtering Platform (WFP)
   * ALE Kernel Callout Driver.
   */
  public async resolveProcessSid(pid: number): Promise<{ sid: string | null; username: string | null }> {
    if (this.mockProcessSids.has(pid)) {
      return this.mockProcessSids.get(pid)!;
    }

    if (process.platform === 'win32') {
      try {
        const psPath = configManager.getPowerShellPath();
        const psCmd = [
          "$ErrorActionPreference = 'SilentlyContinue'",
          `$p = Get-Process -Id ${pid} -IncludeUserName -ErrorAction SilentlyContinue`,
          'if ($p -and $p.UserName) {',
          '  $nt = New-Object System.Security.Principal.NTAccount($p.UserName)',
          '  $sid = $nt.Translate([System.Security.Principal.SecurityIdentifier]).Value',
          '  @{ UserName = $p.UserName; SID = $sid } | ConvertTo-Json -Compress',
          '}',
        ].join('; ');

        const { stdout } = await execFileAsync(psPath, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          psCmd,
        ]);

        const trimmed = (stdout || '').trim();
        if (trimmed) {
          const parsed = JSON.parse(trimmed);
          return {
            sid: parsed.SID || null,
            username: parsed.UserName || null,
          };
        }
      } catch {}
    }

    return { sid: null, username: null };
  }

  /**
   * Resolves the effective SafeBrowse policy for a specific process PID by inspecting its token SID.
   */
  public async evaluateProcessPolicy(pid: number): Promise<ResolvedUserPolicy> {
    const processUser = await this.resolveProcessSid(pid);
    if (!processUser.sid) {
      // Default to unmanaged if process SID cannot be determined
      return {
        isManaged: false,
        childId: null,
        childName: null,
        accountName: processUser.username || `PID-${pid}`,
        sid: '',
      };
    }

    return this.resolveUserPolicy(processUser.sid, processUser.username);
  }

  /**
   * Evaluates if multiple interactive Windows user sessions are concurrently logged in (Fast User Switching).
   * Because userspace loopback DNS cannot isolate packets between concurrent sessions,
   * multiple simultaneously active desktop sessions require an explicit warning and attention state.
   */
  public async detectMultipleInteractiveSessions(): Promise<MultiSessionCheckResult> {
    if (this.mockInteractiveSessions !== null) {
      const users = this.mockInteractiveSessions;
      const hasMultiple = users.length > 1;
      return {
        hasMultipleSessions: hasMultiple,
        sessionCount: users.length,
        activeUsers: users,
        warning: hasMultiple
          ? 'Multiple Windows users are currently signed in. For reliable SafeBrowse protection on this Pilot version, sign out other Windows users before switching accounts.'
          : null,
      };
    }

    if (process.platform !== 'win32') {
      return {
        hasMultipleSessions: false,
        sessionCount: 1,
        activeUsers: ['CurrentConsoleUser'],
        warning: null,
      };
    }

    try {
      const psPath = configManager.getPowerShellPath();
      const psCmd = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        '$procs = Get-Process -Name explorer -IncludeUserName -ErrorAction SilentlyContinue',
        'if ($procs) {',
        '  $users = @($procs | Select-Object -ExpandProperty UserName -Unique | Where-Object { $_ -and $_ -ne "" })',
        '  $users | ConvertTo-Json -Compress',
        '} else {',
        '  "[]"',
        '}',
      ].join('; ');

      const { stdout } = await execFileAsync(psPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psCmd,
      ]);

      const trimmed = (stdout || '').trim();
      let users: string[] = [];
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          users = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          if (trimmed && !trimmed.startsWith('[')) {
            users = [trimmed];
          }
        }
      }

      const cleanUsers = users.map((u) => (u.includes('\\') ? u.split('\\').pop()! : u)).filter(Boolean);
      const uniqueUsers = Array.from(new Set(cleanUsers));
      const hasMultiple = uniqueUsers.length > 1;

      return {
        hasMultipleSessions: hasMultiple,
        sessionCount: uniqueUsers.length,
        activeUsers: uniqueUsers,
        warning: hasMultiple
          ? 'Multiple Windows users are currently signed in. For reliable SafeBrowse protection on this Pilot version, sign out other Windows users before switching accounts.'
          : null,
      };
    } catch {
      return {
        hasMultipleSessions: false,
        sessionCount: 1,
        activeUsers: [],
        warning: null,
      };
    }
  }
}

export const accountManager = new WindowsAccountManager();
