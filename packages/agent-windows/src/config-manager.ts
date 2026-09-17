import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DeviceConfig {
  deviceId: string;
  deviceToken: string;
  deviceTokenEncrypted?: string;
  childId: string;
  parentId: string;
  deviceName: string;
  backendUrl: string;
  pairedAt?: string;
  migratedAt?: string;
}

export class ConfigManager {
  public static readonly DEFAULT_PILOT_URL = 'http://100.88.17.16:11002';
  private customBaseDir: string | null = null;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      this.customBaseDir = customBaseDir;
    }
  }

  /**
   * Returns root storage directory.
   * On Windows: C:\ProgramData\SafeBrowse
   * On Linux/Dev: ~/.safebrowse or custom test dir
   */
  public getBaseDir(): string {
    if (this.customBaseDir) {
      return this.customBaseDir;
    }
    if (process.platform === 'win32') {
      const programData = process.env.ProgramData || 'C:\\ProgramData';
      return path.join(programData, 'SafeBrowse');
    }
    return path.join(process.env.HOME || process.cwd(), '.safebrowse');
  }

  public getConfigFilePath(): string {
    return path.join(this.getBaseDir(), 'device-config.json');
  }

  public getNetworkBackupFilePath(): string {
    return path.join(this.getBaseDir(), 'network-backup.json');
  }

  public getLogsDir(): string {
    return path.join(this.getBaseDir(), 'logs');
  }

  public getCacheDir(): string {
    return path.join(this.getBaseDir(), 'cache');
  }

  /**
   * Ensures base directories exist with appropriate permissions.
   */
  public ensureDirectories(): void {
    const dirs = [this.getBaseDir(), this.getLogsDir(), this.getCacheDir()];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    if (process.platform === 'win32') {
      try {
        // Restrict ProgramData\SafeBrowse ACLs: Administrators & SYSTEM full control, Users read/execute
        const baseDir = this.getBaseDir();
        exec(`icacls "${baseDir}" /inheritance:r /grant:r "SYSTEM":(OI)(CI)F /grant:r "Administrators":(OI)(CI)F /grant:r "Users":(OI)(CI)RX /q`, () => {});
      } catch {}
    }
  }

  /**
   * Validates if host belongs to Tailscale CGNAT range (100.64.0.0/10: 100.64.0.0 - 100.127.255.255)
   */
  public isTailscaleCgnatIp(host: string): boolean {
    const parts = host.split('.');
    if (parts.length !== 4) return false;
    const o1 = parseInt(parts[0], 10);
    const o2 = parseInt(parts[1], 10);
    const o3 = parseInt(parts[2], 10);
    const o4 = parseInt(parts[3], 10);
    if (isNaN(o1) || isNaN(o2) || isNaN(o3) || isNaN(o4)) return false;
    if (o1 !== 100) return false;
    if (o2 < 64 || o2 > 127) return false;
    if (o3 < 0 || o3 > 255 || o4 < 0 || o4 > 255) return false;
    return true;
  }

  public isApprovedDebugHost(host: string): boolean {
    const cleanHost = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1' || cleanHost === '10.0.2.2') {
      return true;
    }
    return this.isTailscaleCgnatIp(cleanHost);
  }

  /**
   * Validates backend URL.
   * Prohibits arbitrary cleartext HTTP. Permits HTTPS or approved debug/mesh hosts.
   */
  public validateBackendUrl(rawUrl: string | undefined | null): string {
    const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
      throw new Error('SAFEBROWSE backend URL must not be blank.');
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch (e: any) {
      throw new Error(`Invalid SAFEBROWSE backend URL format: '${rawUrl}' (${e.message})`);
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`SAFEBROWSE backend URL must use http or https scheme, got: '${parsed.protocol}'`);
    }

    const host = parsed.hostname;
    if (!host) {
      throw new Error(`SAFEBROWSE backend URL must specify a valid host, got: '${rawUrl}'`);
    }

    if (protocol === 'http:') {
      if (!this.isApprovedDebugHost(host)) {
        throw new Error(
          `Cleartext HTTP is strictly prohibited for remote endpoints. Only HTTPS or approved local/Tailscale endpoints (100.64.0.0/10, localhost, 127.0.0.1) are permitted, got: '${host}'`
        );
      }
    }

    return trimmed;
  }

  /**
   * Encrypt sensitive string with Windows DPAPI machine scope (LocalMachine).
   * Allows administrator-installed pairing to be decrypted by LocalSystem service.
   */
  public async encryptWithDpapi(plainText: string): Promise<string> {
    if (process.platform !== 'win32') {
      // Cross-platform simulation prefix
      return 'sim-dpapi:' + Buffer.from(plainText, 'utf8').toString('base64');
    }

    const escaped = plainText.replace(/"/g, '`"').replace(/\$/g, '`$');
    const script = `
      Add-Type -AssemblyName System.Security
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("${escaped}")
      $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
      [System.Convert]::ToBase64String($enc)
    `;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`);
    return stdout.trim();
  }

  /**
   * Decrypt DPAPI machine-scope ciphertext.
   */
  public async decryptWithDpapi(cipherTextBase64: string): Promise<string> {
    if (cipherTextBase64.startsWith('sim-dpapi:')) {
      const b64 = cipherTextBase64.substring('sim-dpapi:'.length);
      return Buffer.from(b64, 'base64').toString('utf8');
    }

    if (process.platform !== 'win32') {
      return Buffer.from(cipherTextBase64, 'base64').toString('utf8');
    }

    const script = `
      Add-Type -AssemblyName System.Security
      $enc = [System.Convert]::FromBase64String("${cipherTextBase64}")
      $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
      [System.Text.Encoding]::UTF8.GetString($bytes)
    `;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`);
    return stdout.trim();
  }

  /**
   * Checks legacy paths for existing pilot configuration and migrates if found.
   */
  public migrateLegacyConfigIfPresent(): boolean {
    const targetPath = this.getConfigFilePath();
    if (fs.existsSync(targetPath)) {
      return false; // Target already exists, no migration needed
    }

    const legacyCandidates = [
      path.join(process.cwd(), 'device-config.json'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SafeBrowse', 'device-config.json'),
    ];

    for (const legacyPath of legacyCandidates) {
      if (fs.existsSync(legacyPath)) {
        try {
          const raw = fs.readFileSync(legacyPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.deviceId && parsed.deviceToken) {
            this.ensureDirectories();
            parsed.migratedAt = new Date().toISOString();
            fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2), 'utf8');
            console.log(`[ConfigManager] Successfully migrated legacy configuration from ${legacyPath} to ${targetPath}`);
            return true;
          }
        } catch (e: any) {
          console.warn(`[ConfigManager] Failed migrating legacy config from ${legacyPath}: ${e.message}`);
        }
      }
    }
    return false;
  }

  /**
   * Loads persisted device configuration from ProgramData.
   */
  public async loadDeviceConfig(): Promise<DeviceConfig | null> {
    this.migrateLegacyConfigIfPresent();
    const configPath = this.getConfigFilePath();

    if (!fs.existsSync(configPath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const data = JSON.parse(raw);

      if (!data || !data.deviceId) {
        return null;
      }

      let deviceToken = data.deviceToken;
      if (data.deviceTokenEncrypted) {
        try {
          deviceToken = await this.decryptWithDpapi(data.deviceTokenEncrypted);
        } catch (e: any) {
          console.warn(`[ConfigManager] Could not decrypt token with DPAPI; falling back to plaintext token: ${e.message}`);
        }
      }

      if (!deviceToken) {
        throw new Error('Device token could not be resolved from configuration.');
      }

      const backendUrl = this.validateBackendUrl(data.backendUrl || ConfigManager.DEFAULT_PILOT_URL);

      return {
        deviceId: data.deviceId,
        deviceToken,
        deviceTokenEncrypted: data.deviceTokenEncrypted,
        childId: data.childId,
        parentId: data.parentId,
        deviceName: data.deviceName || 'Windows Laptop',
        backendUrl,
        pairedAt: data.pairedAt,
        migratedAt: data.migratedAt,
      };
    } catch (e: any) {
      console.error(`[ConfigManager] Error reading ${configPath}: ${e.message}`);
      return null;
    }
  }

  /**
   * Persists device configuration into ProgramData, encrypting token when on Windows.
   */
  public async saveDeviceConfig(config: DeviceConfig): Promise<void> {
    this.ensureDirectories();
    const configPath = this.getConfigFilePath();

    const validatedUrl = this.validateBackendUrl(config.backendUrl || ConfigManager.DEFAULT_PILOT_URL);

    let encryptedToken: string | undefined = config.deviceTokenEncrypted;
    try {
      encryptedToken = await this.encryptWithDpapi(config.deviceToken);
    } catch (e: any) {
      console.warn(`[ConfigManager] DPAPI encryption warning: ${e.message}`);
    }

    const recordToSave: any = {
      deviceId: config.deviceId,
      deviceTokenEncrypted: encryptedToken,
      childId: config.childId,
      parentId: config.parentId,
      deviceName: config.deviceName,
      backendUrl: validatedUrl,
      pairedAt: config.pairedAt || new Date().toISOString(),
    };

    // On non-Windows platforms or if encryption failed, retain plaintext token for functionality
    if (process.platform !== 'win32' || !encryptedToken) {
      recordToSave.deviceToken = config.deviceToken;
    }

    fs.writeFileSync(configPath, JSON.stringify(recordToSave, null, 2), 'utf8');
    console.log(`[ConfigManager] Device configuration persisted securely at: ${configPath}`);
  }

  public hasDeviceConfig(): boolean {
    this.migrateLegacyConfigIfPresent();
    return fs.existsSync(this.getConfigFilePath());
  }
}

export const configManager = new ConfigManager();
