import * as fs from 'fs';
import * as path from 'path';
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

export interface SharedLaptopConfig {
  deviceId: string;
  deviceName?: string;
  mappings: WindowsProfileMapping[];
  updatedAt: string;
}

export interface ResolvedUserPolicy {
  isManaged: boolean;
  childId: string | null;
  childName: string | null;
  accountName: string;
  sid: string;
}

export class WindowsAccountManager {
  private customBaseDir: string | null = null;
  private mockAccounts: WindowsAccount[] | null = null;
  private mockConsoleSid: string | null = null;

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

  public getMappingsFilePath(): string {
    const baseDir = this.customBaseDir || configManager.getBaseDir();
    return path.join(baseDir, 'profile-mappings.json');
  }

  public getActiveSessionFilePath(): string {
    const baseDir = this.customBaseDir || configManager.getBaseDir();
    return path.join(baseDir, 'active-session.json');
  }

  /**
   * Evaluates if a given Windows SID or Username belongs to an internal,
   * system, or service identity that should never be presented to parents.
   */
  public isSystemOrServiceAccount(name: string, sid?: string): boolean {
    const upperName = (name || '').toUpperCase();

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
    }

    const filteredNames = [
      'SYSTEM',
      'LOCAL SERVICE',
      'NETWORK SERVICE',
      'DEFAULTACCOUNT',
      'WDAGUTILITYACCOUNT',
      'TRUSTEDINSTALLER',
      'ADMINISTRATOR',
    ];

    if (filteredNames.includes(upperName)) {
      return true;
    }

    if (
      upperName.startsWith('DWM-') ||
      upperName.startsWith('UMFD-') ||
      upperName.startsWith('IUSR') ||
      upperName.startsWith('IIS_') ||
      upperName.includes('SERVICE')
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
      return this.mockAccounts;
    }

    if (process.platform !== 'win32') {
      // Non-Windows simulation: return test accounts for development / testing
      return [
        { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
        { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
        { name: 'Rahul', sid: 'S-1-5-21-1000-1000-1000-1002', disabled: false },
        { name: 'Guest', sid: 'S-1-5-21-1000-1000-1000-501', disabled: false },
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

        if (this.isSystemOrServiceAccount(name, sid)) {
          continue;
        }

        accounts.push({
          name,
          sid,
          disabled,
        });
      }

      return accounts;
    } catch (err: any) {
      console.warn(`[AccountManager] Failed to discover Windows accounts via WMI: ${err.message}`);
      return [];
    }
  }

  /**
   * Loads saved profile mappings from disk.
   */
  public async loadProfileMappings(): Promise<WindowsProfileMapping[]> {
    const filePath = this.getMappingsFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
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
   * Persists profile mappings to disk with secure Windows ACLs.
   */
  public async saveProfileMappings(
    mappings: WindowsProfileMapping[],
    deviceId?: string,
    deviceName?: string
  ): Promise<void> {
    const baseDir = this.customBaseDir || configManager.getBaseDir();
    if (!fs.existsSync(baseDir)) {
      try { fs.mkdirSync(baseDir, { recursive: true }); } catch {}
    }
    configManager.ensureDirectories();

    const filePath = this.getMappingsFilePath();
    const payload: SharedLaptopConfig = {
      deviceId: deviceId || 'dev-local',
      deviceName: deviceName || 'Family Laptop',
      mappings,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    configManager.applyWindowsAcls(filePath);
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
}

export const accountManager = new WindowsAccountManager();
