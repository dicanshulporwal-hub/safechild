import * as fs from 'fs';
import * as path from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
  private customLegacyPath: string | null = null;
  private platformOverride: string | null = null;
  private aclExecutor: ((cmd: string) => void) | null = null;

  constructor(customBaseDir?: string, customLegacyPath?: string) {
    if (customBaseDir) {
      this.customBaseDir = customBaseDir;
    }
    if (customLegacyPath) {
      this.customLegacyPath = customLegacyPath;
    }
  }

  /**
   * For testing Windows-specific fail-closed code paths in cross-platform environments.
   */
  public setPlatformForTesting(platform: string | null): void {
    this.platformOverride = platform;
  }

  public setAclExecutorForTesting(executor: ((cmd: string) => void) | null): void {
    this.aclExecutor = executor;
  }

  public getPlatform(): string {
    return this.platformOverride || process.platform;
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
    if (this.getPlatform() === 'win32') {
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
   * Builds the Windows icacls command to secure base storage.
   * - Strips inherited permissive permissions from ProgramData (/inheritance:r)
   * - Grants SYSTEM Full Control with Object & Container inheritance ((OI)(CI)F)
   * - Grants BUILTIN\Administrators Full Control with Object & Container inheritance ((OI)(CI)F)
   * - Explicitly removes any granted permissions for standard Users (/remove:g Users)
   * - Restricts device-config.json, network-backup.json, cache, and logs from child/standard user accounts
   */
  public getWindowsAclCommand(targetDir: string): string {
    return `icacls "${targetDir}" /inheritance:r /grant:r "SYSTEM":(OI)(CI)F /grant:r "BUILTIN\\Administrators":(OI)(CI)F /remove:g "Users" /q`;
  }

  /**
   * Applies secure Windows ACLs to target directory.
   * Fails closed on Windows if permissions cannot be secured.
   */
  public applyWindowsAcls(targetDir: string): void {
    const cmd = this.getWindowsAclCommand(targetDir);
    if (this.aclExecutor) {
      this.aclExecutor(cmd);
      return;
    }
    if (this.getPlatform() === 'win32' && process.platform === 'win32') {
      try {
        execSync(cmd, { stdio: 'pipe' });
      } catch (err: any) {
        const stderr = err.stderr ? err.stderr.toString() : '';
        const msg = stderr.trim() || err.message;
        throw new Error(`Failed to secure Windows directory permissions for ${targetDir}: ${msg}`);
      }
    }
  }

  /**
   * Ensures base directories exist with appropriate permissions.
   * On Windows, enforces restrictive ACLs (SYSTEM and Administrators Full Control only).
   */
  public ensureDirectories(): void {
    const dirs = [this.getBaseDir(), this.getLogsDir(), this.getCacheDir()];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.applyWindowsAcls(this.getBaseDir());
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
   * Resolves powershell.exe path, preferring full system binary when on Windows.
   */
  public getPowerShellPath(): string {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const standardPs = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (fs.existsSync(standardPs)) {
        return standardPs;
      }
    }
    return 'powershell.exe';
  }

  /**
   * Builds the PowerShell command for machine-scope DPAPI encryption using base64 byte encoding.
   * Avoids passing raw unquoted secrets or strings subject to command-line stripping.
   */
  public getDpapiEncryptScript(plainText: string): string {
    const b64Payload = Buffer.from(plainText, 'utf8').toString('base64');
    return [
      '$ErrorActionPreference = \'Stop\'',
      'Add-Type -AssemblyName System.Security',
      `$bytes = [System.Convert]::FromBase64String('${b64Payload}')`,
      '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)',
      '[System.Convert]::ToBase64String($enc)',
    ].join('; ');
  }

  /**
   * Builds the PowerShell command for machine-scope DPAPI decryption.
   * Outputs base64 of the decrypted byte array to avoid console character encoding issues.
   */
  public getDpapiDecryptScript(cipherTextBase64: string): string {
    const cleanCipher = cipherTextBase64.replace(/[\r\n\s]+/g, '');
    return [
      '$ErrorActionPreference = \'Stop\'',
      'Add-Type -AssemblyName System.Security',
      `$enc = [System.Convert]::FromBase64String('${cleanCipher}')`,
      '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)',
      '[System.Convert]::ToBase64String($bytes)',
    ].join('; ');
  }

  /**
   * Encrypt sensitive string with Windows DPAPI machine scope (LocalMachine).
   * Allows administrator-installed pairing to be decrypted by LocalSystem service.
   * Avoids cmd.exe stripping by using execFile with powershell.exe and base64 payloads.
   */
  public async encryptWithDpapi(plainText: string): Promise<string> {
    if (plainText === undefined || plainText === null) {
      throw new Error('DPAPI encryption requires a defined string.');
    }

    if (process.platform !== 'win32' || this.getPlatform() !== 'win32') {
      // Cross-platform simulation prefix
      return 'sim-dpapi:' + Buffer.from(plainText, 'utf8').toString('base64');
    }

    const script = this.getDpapiEncryptScript(plainText);
    const psPath = this.getPowerShellPath();

    const { stdout } = await execFileAsync(psPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);

    const cleanOutput = stdout.replace(/[\r\n\s]+/g, '');
    if (!cleanOutput || !/^[A-Za-z0-9+/=]+$/.test(cleanOutput)) {
      throw new Error('DPAPI encryption returned invalid or empty ciphertext output.');
    }
    return cleanOutput;
  }

  /**
   * Decrypt DPAPI machine-scope ciphertext.
   * Decodes base64 byte array output to guarantee UTF-8 fidelity across console code pages.
   */
  public async decryptWithDpapi(cipherTextBase64: string): Promise<string> {
    if (!cipherTextBase64 || typeof cipherTextBase64 !== 'string') {
      throw new Error('DPAPI decryption requires a non-empty ciphertext string.');
    }

    if (cipherTextBase64.startsWith('sim-dpapi:')) {
      const b64 = cipherTextBase64.substring('sim-dpapi:'.length);
      return Buffer.from(b64, 'base64').toString('utf8');
    }

    if (process.platform !== 'win32' || this.getPlatform() !== 'win32') {
      return Buffer.from(cipherTextBase64, 'base64').toString('utf8');
    }

    const cleanCipher = cipherTextBase64.replace(/[\r\n\s]+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(cleanCipher)) {
      throw new Error('Invalid DPAPI ciphertext format: base64 characters expected.');
    }

    const script = this.getDpapiDecryptScript(cleanCipher);
    const psPath = this.getPowerShellPath();

    const { stdout } = await execFileAsync(psPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);

    const cleanOutput = stdout.replace(/[\r\n\s]+/g, '');
    if (!cleanOutput) {
      throw new Error('DPAPI decryption returned empty output.');
    }
    return Buffer.from(cleanOutput, 'base64').toString('utf8');
  }

  /**
   * Checks legacy paths for existing pilot configuration and migrates if found.
   * Encrypts plaintext tokens to DPAPI LocalMachine, removes plaintext token,
   * writes the secured configuration, and only deletes legacy file after target exists.
   */
  public async migrateLegacyConfigIfPresent(explicitLegacyPath?: string): Promise<boolean> {
    const targetPath = this.getConfigFilePath();
    if (fs.existsSync(targetPath)) {
      return false; // Target already exists, no migration needed
    }

    // Check candidate legacy locations
    const legacyCandidates = [
      ...(explicitLegacyPath ? [explicitLegacyPath] : []),
      ...(this.customLegacyPath ? [this.customLegacyPath] : []),
      path.join(process.cwd(), 'device-config.json'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SafeBrowse', 'device-config.json'),
    ];

    for (const legacyPath of legacyCandidates) {
      if (path.resolve(legacyPath) === path.resolve(targetPath)) {
        continue;
      }
      if (fs.existsSync(legacyPath)) {
        try {
          const raw = fs.readFileSync(legacyPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.deviceId && (parsed.deviceToken || parsed.deviceTokenEncrypted)) {
            this.ensureDirectories();

            // Encrypt legacy plaintext token with DPAPI LocalMachine
            if (!parsed.deviceTokenEncrypted && parsed.deviceToken) {
              parsed.deviceTokenEncrypted = await this.encryptWithDpapi(parsed.deviceToken);
            }

            // Strictly remove plaintext token from secured config
            delete parsed.deviceToken;
            parsed.migratedAt = new Date().toISOString();

            // Write secured target configuration first
            const tempTargetPath = `${targetPath}.tmp.${Date.now()}`;
            fs.writeFileSync(tempTargetPath, JSON.stringify(parsed, null, 2), 'utf8');
            fs.renameSync(tempTargetPath, targetPath);

            // Legacy file is not deleted until secured target file is confirmed to exist
            if (fs.existsSync(targetPath)) {
              try {
                fs.unlinkSync(legacyPath);
                console.log(`[ConfigManager] Removed legacy configuration at: ${legacyPath}`);
              } catch (unlinkErr: any) {
                console.warn(`[ConfigManager] Could not remove legacy config file at ${legacyPath}: ${unlinkErr.message}`);
              }
            }

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
   * Enforces DPAPI machine-scope decryption on Windows without falling back to plaintext.
   */
  public async loadDeviceConfig(): Promise<DeviceConfig | null> {
    await this.migrateLegacyConfigIfPresent();
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

      let deviceToken: string | undefined;

      if (this.getPlatform() === 'win32') {
        // Fail-closed enforcement on Windows: DPAPI encrypted token is required
        if (!data.deviceTokenEncrypted) {
          console.error('[ConfigManager] Insecure configuration rejected on Windows: missing deviceTokenEncrypted.');
          return null;
        }

        try {
          deviceToken = await this.decryptWithDpapi(data.deviceTokenEncrypted);
        } catch (e: any) {
          console.error(`[ConfigManager] DPAPI decryption failed on Windows: ${e.message}`);
          return null; // Strict fail-closed: NEVER fall back to plaintext token on Windows
        }
      } else {
        // Non-Windows simulation / development
        if (data.deviceTokenEncrypted) {
          try {
            deviceToken = await this.decryptWithDpapi(data.deviceTokenEncrypted);
          } catch (e: any) {
            console.warn(`[ConfigManager] DPAPI simulated decrypt failed: ${e.message}`);
          }
        }
        if (!deviceToken && data.deviceToken) {
          deviceToken = data.deviceToken;
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
   * Persists device configuration into ProgramData.
   * On Windows:
   *  - Encrypts deviceToken with DPAPI LocalMachine
   *  - Fails closed if encryption fails (throws, never writes plaintext)
   *  - Persisted JSON only contains deviceTokenEncrypted (deviceToken is omitted)
   */
  public async saveDeviceConfig(config: DeviceConfig): Promise<void> {
    this.ensureDirectories();
    const configPath = this.getConfigFilePath();

    const validatedUrl = this.validateBackendUrl(config.backendUrl || ConfigManager.DEFAULT_PILOT_URL);

    // Fail-closed on Windows: DPAPI machine-scope encryption is mandatory.
    // If encryption throws or fails, abort immediately without persisting plaintext.
    const encryptedToken = await this.encryptWithDpapi(config.deviceToken);
    if (!encryptedToken) {
      throw new Error('DPAPI machine-scope encryption failed to produce ciphertext.');
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

    if (config.migratedAt) {
      recordToSave.migratedAt = config.migratedAt;
    }

    // Strictly ensure plaintext deviceToken is NEVER written to disk
    delete recordToSave.deviceToken;

    const tempConfigPath = `${configPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempConfigPath, JSON.stringify(recordToSave, null, 2), 'utf8');
    fs.renameSync(tempConfigPath, configPath);
    console.log(`[ConfigManager] Device configuration persisted securely at: ${configPath}`);
  }

  public hasDeviceConfig(): boolean {
    return fs.existsSync(this.getConfigFilePath());
  }
}

export const configManager = new ConfigManager();
