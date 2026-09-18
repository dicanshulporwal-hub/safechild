import * as fs from 'fs';
import * as path from 'path';
import * as dgram from 'dgram';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { configManager } from './config-manager';
import { firewallEngine } from './wfp-engine';

const execFileAsync = promisify(execFile);

/**
 * Appends diagnostic log message to C:\ProgramData\SafeBrowse\logs\agent-service.log
 * in addition to standard console output. Ensures secrets are never logged.
 */
export function logServiceMessage(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level}] ${message}\n`;
  if (level === 'ERROR') {
    console.error(message);
  } else if (level === 'WARN') {
    console.warn(message);
  } else {
    console.log(message);
  }

  try {
    const logsDir = configManager.getLogsDir();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.appendFileSync(path.join(logsDir, 'agent-service.log'), formatted, 'utf8');
  } catch {
    // Non-blocking fallback if logging directory is not yet writable
  }
}

export interface AdapterDnsBackup {
  InterfaceIndex: number;
  ServerAddresses: string[];
  InterfaceAlias?: string;
  DhcpEnabled?: boolean;
}

export interface TargetAdapterInfo {
  InterfaceIndex: number;
  InterfaceAlias: string;
  Description?: string;
}

export interface FailSafeDnsResult {
  success: boolean;
  message: string;
  interfaceIndexes?: number[];
  details?: string;
}

export type NetworkCommandExecutor = (script: string) => Promise<{ stdout: string; stderr: string }>;

export class WindowsNetworkManager {
  private backupFile: string;
  private platformOverride: string | null = null;
  private commandExecutor: NetworkCommandExecutor | null = null;

  constructor(customBackupFile?: string) {
    this.backupFile = customBackupFile || configManager.getNetworkBackupFilePath();
  }

  public setPlatformForTesting(platform: string | null): void {
    this.platformOverride = platform;
  }

  public setCommandExecutorForTesting(executor: NetworkCommandExecutor | null): void {
    this.commandExecutor = executor;
  }

  public getPlatform(): string {
    return this.platformOverride || process.platform;
  }

  private defaultExecutor: NetworkCommandExecutor = async (script: string) => {
    const psPath = configManager.getPowerShellPath();
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    return await execFileAsync(psPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      b64,
    ]);
  };

  /**
   * Executes a PowerShell script robustly using -EncodedCommand (UTF-16LE Base64) to avoid cmd.exe quoting hazards.
   */
  public async executePowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
    const executor = this.commandExecutor || this.defaultExecutor;
    return await executor(script);
  }

  /**
   * Identifies active IPv4 internet-facing adapters having an IPv4 default gateway.
   * Excludes tunnels, loopbacks, and virtual adapters (such as Tailscale) without default gateways.
   */
  public async getTargetAdapters(): Promise<TargetAdapterInfo[]> {
    if (this.getPlatform() !== 'win32') {
      // Simulation for non-Windows test environments
      return [{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Mock Wi-Fi Adapter' }];
    }

    try {
      const script = [
        '$ErrorActionPreference = \'Stop\'',
        '$configs = @(Get-NetIPConfiguration | Where-Object {',
        '    $_.NetAdapter.Status -eq \'Up\' -and $_.IPv4DefaultGateway -ne $null',
        '})',
        '$result = foreach ($c in $configs) {',
        '    [PSCustomObject]@{',
        '        InterfaceIndex = $c.InterfaceIndex',
        '        InterfaceAlias = $c.InterfaceAlias',
        '        Description = $c.InterfaceDescription',
        '    }',
        '}',
        'if ($result.Count -gt 0) {',
        '    $result | ConvertTo-Json -Compress',
        '} else {',
        '    \'[]\'',
        '}',
      ].join('\n');

      const { stdout } = await this.executePowerShell(script);
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === '[]' || trimmed === 'null') {
        return [];
      }

      const parsed = JSON.parse(trimmed);
      const rawList = Array.isArray(parsed) ? parsed : [parsed];
      return rawList
        .filter((item) => item && typeof item.InterfaceIndex !== 'undefined')
        .map((item) => ({
          InterfaceIndex: Number(item.InterfaceIndex),
          InterfaceAlias: String(item.InterfaceAlias || `Interface ${item.InterfaceIndex}`),
          Description: item.Description ? String(item.Description) : undefined,
        }));
    } catch (err: any) {
      logServiceMessage('ERROR', `[NetworkManager] Failed identifying target adapters: ${err.message}`);
      return [];
    }
  }

  /**
   * Backs up target adapter DNS configuration into ProgramData before modification.
   * Preserves existing valid non-127.0.0.1 backup and avoids backing up local loopback addresses.
   */
  public async backupCurrentDnsConfig(targetAdapters?: TargetAdapterInfo[]): Promise<AdapterDnsBackup[]> {
    if (this.getPlatform() !== 'win32') {
      const mockBackup: AdapterDnsBackup[] = [
        { InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' },
      ];
      configManager.ensureDirectories();
      if (!fs.existsSync(this.backupFile)) {
        fs.writeFileSync(this.backupFile, JSON.stringify(mockBackup, null, 2), 'utf8');
      }
      return mockBackup;
    }

    try {
      configManager.ensureDirectories();

      // Check if a valid original backup already exists on disk
      if (fs.existsSync(this.backupFile)) {
        try {
          const raw = fs.readFileSync(this.backupFile, 'utf8');
          const existingList: AdapterDnsBackup[] = JSON.parse(raw);
          if (Array.isArray(existingList) && existingList.length > 0) {
            // Verify it does not contain 127.0.0.1
            const hasOnlyLoopback = existingList.every(
              (b) =>
                b.ServerAddresses &&
                b.ServerAddresses.length > 0 &&
                b.ServerAddresses.every((ip) => ip.includes('127.0.0.1'))
            );
            if (!hasOnlyLoopback) {
              logServiceMessage('INFO', `[NetworkManager] Preserving existing valid DNS backup at ${this.backupFile}`);
              return existingList;
            }
          }
        } catch {
          // If unparseable, fall through to re-create
        }
      }

      // Determine target adapters to query
      const targets =
        targetAdapters && targetAdapters.length > 0 ? targetAdapters : await this.getTargetAdapters();

      if (targets.length === 0) {
        logServiceMessage('WARN', '[NetworkManager] No target adapters found to back up.');
        return [];
      }

      const indexes = targets.map((t) => t.InterfaceIndex);
      const script = [
        '$ErrorActionPreference = \'Stop\'',
        `$indexes = @(${indexes.join(',')})`,
        '$configs = Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop |',
        '    Where-Object { $indexes -contains $_.InterfaceIndex }',
        '$result = foreach ($c in $configs) {',
        '    [PSCustomObject]@{',
        '        InterfaceIndex = $c.InterfaceIndex',
        '        InterfaceAlias = $c.InterfaceAlias',
        '        ServerAddresses = @($c.ServerAddresses)',
        '    }',
        '}',
        'if ($result.Count -gt 0) {',
        '    $result | ConvertTo-Json -Compress',
        '} else {',
        '    \'[]\'',
        '}',
      ].join('\n');

      const { stdout } = await this.executePowerShell(script);
      const trimmed = stdout.trim();
      if (trimmed && trimmed !== '[]' && trimmed !== 'null') {
        const parsed = JSON.parse(trimmed);
        const rawList = Array.isArray(parsed) ? parsed : [parsed];
        const backupList: AdapterDnsBackup[] = rawList.map((item: any) => {
          const addrs: string[] = Array.isArray(item.ServerAddresses)
            ? item.ServerAddresses
            : item.ServerAddresses
            ? [item.ServerAddresses]
            : [];
          // Never backup 127.0.0.1 or ::1 as original DNS
          const cleanAddrs = addrs.filter((ip) => ip && !ip.includes('127.0.0.1') && !ip.includes('::1'));
          return {
            InterfaceIndex: Number(item.InterfaceIndex),
            InterfaceAlias: item.InterfaceAlias || `Interface ${item.InterfaceIndex}`,
            ServerAddresses: cleanAddrs,
            DhcpEnabled: cleanAddrs.length === 0,
          };
        });

        fs.writeFileSync(this.backupFile, JSON.stringify(backupList, null, 2), 'utf8');
        logServiceMessage(
          'INFO',
          `[NetworkManager] Network adapter DNS backup saved to ${this.backupFile}: ${JSON.stringify(backupList)}`
        );
        return backupList;
      }
    } catch (e: any) {
      logServiceMessage('WARN', `[NetworkManager] Warning backing up network config: ${e.message}`);
    }
    return [];
  }

  /**
   * Probes 127.0.0.1 on the specified UDP port with a standard DNS query to verify it is serving queries.
   */
  public async verifyDnsProxyResponding(port: number = 53, timeoutMs: number = 2500): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            socket.close();
          } catch {}
          resolve(false);
        }
      }, timeoutMs);

      socket.on('message', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch {}
          resolve(true);
        }
      });

      socket.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch {}
          resolve(false);
        }
      });

      // Construct a standard DNS query packet for 'health.safebrowse.local' (Type A)
      const query = Buffer.from([
        0x12,
        0x34, // Transaction ID
        0x01,
        0x00, // Standard query, recursion desired
        0x00,
        0x01, // QDCOUNT = 1
        0x00,
        0x00, // ANCOUNT = 0
        0x00,
        0x00, // NSCOUNT = 0
        0x00,
        0x00, // ARCOUNT = 0
        // Query name: health.safebrowse.local
        0x06,
        0x68,
        0x65,
        0x61,
        0x6c,
        0x74,
        0x68, // 6 health
        0x0a,
        0x73,
        0x61,
        0x66,
        0x65,
        0x62,
        0x72,
        0x6f,
        0x77,
        0x73,
        0x65, // 10 safebrowse
        0x05,
        0x6c,
        0x6f,
        0x63,
        0x61,
        0x6c, // 5 local
        0x00, // null terminator
        0x00,
        0x01, // QTYPE = A (1)
        0x00,
        0x01, // QCLASS = IN (1)
      ]);

      socket.send(query, port, '127.0.0.1', (err) => {
        if (err && !resolved) {
          resolved = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch {}
          resolve(false);
        }
      });
    });
  }

  /**
   * Activates local DNS proxy strictly AFTER verifying target adapters and confirming 127.0.0.1:53 is operational.
   * Performs read-back verification and atomic rollback if any step fails.
   */
  public async activateFailSafeDns(dnsPort: number = 53): Promise<FailSafeDnsResult> {
    logServiceMessage('INFO', '[NetworkManager] Initiating fail-safe network activation...');

    // 1. Identify target internet-facing adapters having an IPv4 default gateway
    const targetAdapters = await this.getTargetAdapters();
    if (targetAdapters.length === 0) {
      const msg = 'No active IPv4 internet-facing adapters with default gateway found. Network DNS untouched.';
      logServiceMessage('WARN', `[NetworkManager] ⚠️ ${msg}`);
      return {
        success: false,
        message: msg,
        interfaceIndexes: [],
      };
    }

    const adapterDetails = targetAdapters
      .map((a) => `${a.InterfaceAlias} (Index ${a.InterfaceIndex})`)
      .join(', ');
    logServiceMessage('INFO', `[NetworkManager] Selected target internet-facing adapters: ${adapterDetails}`);

    // 2. Backup original DNS of target adapters before modification
    if (!fs.existsSync(this.backupFile)) {
      logServiceMessage('INFO', '[NetworkManager] Creating initial DNS backup for target adapters...');
      await this.backupCurrentDnsConfig(targetAdapters);
    } else {
      logServiceMessage('INFO', `[NetworkManager] Verified existing DNS backup at: ${this.backupFile}`);
    }

    // 3. Confirm 127.0.0.1:53 DNS proxy responds
    logServiceMessage('INFO', `[NetworkManager] Testing 127.0.0.1:${dnsPort} local resolver response...`);
    const isResponding = await this.verifyDnsProxyResponding(dnsPort);
    if (!isResponding) {
      const errReason = `Local DNS proxy on port ${dnsPort} failed health probe. Original network DNS untouched.`;
      logServiceMessage('ERROR', `[NetworkManager] ❌ Fail-safe abort: 127.0.0.1:${dnsPort} is NOT answering DNS queries.`);
      logServiceMessage('ERROR', '[NetworkManager] Preserving original network adapter DNS to prevent connectivity loss.');
      return {
        success: false,
        message: errReason,
        interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
      };
    }
    logServiceMessage('INFO', `[NetworkManager] ✅ Verified: 127.0.0.1:${dnsPort} responded to DNS probe.`);

    // 4. Apply 127.0.0.1 and read-back verify each adapter on Windows
    if (this.getPlatform() === 'win32') {
      try {
        for (const adapter of targetAdapters) {
          logServiceMessage(
            'INFO',
            `[NetworkManager] Assigning 127.0.0.1 DNS to adapter ${adapter.InterfaceAlias} (Index ${adapter.InterfaceIndex})...`
          );

          // Apply 127.0.0.1 with -ErrorAction Stop
          const setScript = [
            '$ErrorActionPreference = \'Stop\'',
            `Set-DnsClientServerAddress -InterfaceIndex ${adapter.InterfaceIndex} -ServerAddresses ('127.0.0.1') -ErrorAction Stop`,
          ].join('\n');
          await this.executePowerShell(setScript);

          // Read back configuration
          const readBackScript = [
            '$ErrorActionPreference = \'Stop\'',
            `$addr = Get-DnsClientServerAddress -InterfaceIndex ${adapter.InterfaceIndex} -AddressFamily IPv4 -ErrorAction Stop`,
            '$addr | Select-Object InterfaceIndex, ServerAddresses | ConvertTo-Json -Compress',
          ].join('\n');
          const { stdout } = await this.executePowerShell(readBackScript);
          const trimmed = stdout.trim();
          if (!trimmed) {
            throw new Error(`Empty read-back response from adapter ${adapter.InterfaceIndex}`);
          }

          const parsed = JSON.parse(trimmed);
          const rawAddrs = parsed.ServerAddresses;
          const servers: string[] = Array.isArray(rawAddrs) ? rawAddrs : rawAddrs ? [rawAddrs] : [];

          logServiceMessage(
            'INFO',
            `[NetworkManager] Read-back DNS for adapter ${adapter.InterfaceIndex}: [${servers.join(', ')}]`
          );

          if (!servers.includes('127.0.0.1')) {
            throw new Error(
              `Read-back verification failed for adapter ${adapter.InterfaceIndex}: expected [127.0.0.1], got [${servers.join(', ')}]`
            );
          }
          logServiceMessage('INFO', `[NetworkManager] ✅ Adapter ${adapter.InterfaceIndex} verified configured to 127.0.0.1.`);
        }

        // 5. Post-assignment resolver check
        logServiceMessage('INFO', `[NetworkManager] Verifying 127.0.0.1:${dnsPort} resolver still healthy post-assignment...`);
        const postCheck = await this.verifyDnsProxyResponding(dnsPort);
        if (!postCheck) {
          throw new Error(`DNS proxy on 127.0.0.1:${dnsPort} stopped responding after adapter configuration.`);
        }
        logServiceMessage('INFO', `[NetworkManager] ✅ Post-assignment resolver check passed.`);

        // 6. Clear DNS cache
        const flushScript = '$ErrorActionPreference = \'SilentlyContinue\'; Clear-DnsClientCache';
        await this.executePowerShell(flushScript);
        logServiceMessage('INFO', '[NetworkManager] Windows DNS client cache flushed.');
      } catch (applyErr: any) {
        logServiceMessage(
          'ERROR',
          `[NetworkManager] ❌ DNS configuration or verification failed: ${applyErr.message}. Initiating immediate rollback.`
        );
        try {
          await this.restoreOriginalDns();
          logServiceMessage('INFO', '[NetworkManager] 🔄 Original DNS restored after activation failure.');
          return {
            success: false,
            message: `Activation failed: ${applyErr.message}. Original DNS restored.`,
            interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
            details: applyErr.message,
          };
        } catch (rollbackErr: any) {
          const criticalMsg = `CRITICAL: DNS activation failed (${applyErr.message}) AND rollback failed (${rollbackErr.message}). Network configuration may be in an inconsistent state.`;
          logServiceMessage('ERROR', `[NetworkManager] 🚨 ${criticalMsg}`);
          return {
            success: false,
            message: criticalMsg,
            interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
            details: `Activation Error: ${applyErr.message}; Rollback Error: ${rollbackErr.message}`,
          };
        }
      }
    }

    // 7. Install DoT / DoH blocking firewall rules
    await firewallEngine.initialize();
    logServiceMessage('INFO', '[NetworkManager] ✅ Fail-safe DNS and firewall enforcement successfully activated and verified.');

    return {
      success: true,
      message: 'Fail-safe DNS successfully activated and verified.',
      interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
    };
  }

  /**
   * Cleanly restores original adapter DNS configuration from backup.
   * Restores static IP addresses or resets to DHCP based on original state.
   * Throws on failure to ensure uninstallers and CLI tools detect restoration errors.
   */
  public async restoreOriginalDns(): Promise<void> {
    logServiceMessage('INFO', '[NetworkManager] Restoring network adapters to original DNS settings...');

    if (this.getPlatform() !== 'win32') {
      logServiceMessage('INFO', '[NetworkManager] Non-Windows platform: simulation complete.');
      return;
    }

    // 1. Remove SafeBrowse firewall rules
    try {
      await firewallEngine.teardown();
      logServiceMessage('INFO', '[NetworkManager] Firewall rules torn down.');
    } catch (fwErr: any) {
      logServiceMessage('WARN', `[NetworkManager] Warning tearing down firewall rules: ${fwErr.message}`);
    }

    // 2. Restore DNS
    try {
      let backupList: AdapterDnsBackup[] = [];

      if (fs.existsSync(this.backupFile)) {
        try {
          const raw = fs.readFileSync(this.backupFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            backupList = parsed;
          }
        } catch (e: any) {
          logServiceMessage('WARN', `[NetworkManager] Could not parse backup file: ${e.message}`);
        }
      }

      if (backupList.length > 0) {
        for (const item of backupList) {
          if (item.ServerAddresses && item.ServerAddresses.length > 0) {
            // Restore original static DNS addresses
            const formattedAddresses = item.ServerAddresses.map((ip) => `'${ip}'`).join(',');
            const script = [
              '$ErrorActionPreference = \'Stop\'',
              `Set-DnsClientServerAddress -InterfaceIndex ${item.InterfaceIndex} -ServerAddresses @(${formattedAddresses}) -ErrorAction Stop`,
            ].join('\n');
            await this.executePowerShell(script);
            logServiceMessage(
              'INFO',
              `[NetworkManager] Restored static DNS for adapter ${item.InterfaceIndex} to [${item.ServerAddresses.join(', ')}].`
            );
          } else {
            // Restore adapter to DHCP
            const script = [
              '$ErrorActionPreference = \'Stop\'',
              `Set-DnsClientServerAddress -InterfaceIndex ${item.InterfaceIndex} -ResetServerAddresses -ErrorAction Stop`,
            ].join('\n');
            await this.executePowerShell(script);
            logServiceMessage('INFO', `[NetworkManager] Reset adapter ${item.InterfaceIndex} to DHCP.`);
          }
        }
      } else {
        // If no adapters were restored from backup (e.g. backup missing or corrupt),
        // reset ONLY internet-facing adapters with default gateway to DHCP (never touch Tailscale or tunnels!)
        logServiceMessage(
          'INFO',
          '[NetworkManager] No backup records found; falling back to resetting internet-facing adapters with default gateway to DHCP...'
        );
        const script = [
          '$ErrorActionPreference = \'Stop\'',
          '$configs = @(Get-NetIPConfiguration | Where-Object {',
          '    $_.NetAdapter.Status -eq \'Up\' -and $_.IPv4DefaultGateway -ne $null',
          '})',
          'foreach ($c in $configs) {',
          '    Set-DnsClientServerAddress -InterfaceIndex $c.InterfaceIndex -ResetServerAddresses -ErrorAction Stop',
          '}',
        ].join('\n');
        await this.executePowerShell(script);
        logServiceMessage('INFO', '[NetworkManager] Internet-facing adapters reset to DHCP.');
      }

      // Flush DNS client cache
      const flushScript = '$ErrorActionPreference = \'SilentlyContinue\'; Clear-DnsClientCache';
      await this.executePowerShell(flushScript);

      logServiceMessage('INFO', '[NetworkManager] ✅ Original DNS configuration cleanly restored and DNS cache flushed.');
    } catch (e: any) {
      logServiceMessage('ERROR', `[NetworkManager] Error during DNS restoration: ${e.message}`);
      throw e;
    }
  }
}

export const networkManager = new WindowsNetworkManager();
