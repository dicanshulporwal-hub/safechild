import * as fs from 'fs';
import * as path from 'path';
import * as dgram from 'dgram';
import { exec } from 'child_process';
import { promisify } from 'util';
import { configManager } from './config-manager';
import { firewallEngine } from './wfp-engine';

const execAsync = promisify(exec);

export interface AdapterDnsBackup {
  InterfaceIndex: number;
  ServerAddresses: string[];
}

export class WindowsNetworkManager {
  private backupFile: string;

  constructor(customBackupFile?: string) {
    this.backupFile = customBackupFile || configManager.getNetworkBackupFilePath();
  }

  /**
   * Backs up current adapter DNS configuration into ProgramData.
   */
  public async backupCurrentDnsConfig(): Promise<AdapterDnsBackup[]> {
    if (process.platform !== 'win32') {
      const mockBackup: AdapterDnsBackup[] = [{ InterfaceIndex: 1, ServerAddresses: ['1.1.1.1', '8.8.8.8'] }];
      configManager.ensureDirectories();
      fs.writeFileSync(this.backupFile, JSON.stringify(mockBackup, null, 2), 'utf8');
      return mockBackup;
    }

    try {
      configManager.ensureDirectories();
      const script = `
        Get-DnsClientServerAddress -AddressFamily IPv4 |
        Where-Object { $_.ServerAddresses.Count -gt 0 } |
        Select-Object InterfaceIndex, ServerAddresses |
        ConvertTo-Json
      `;
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`);
      if (stdout.trim()) {
        const parsed = JSON.parse(stdout.trim());
        const list: AdapterDnsBackup[] = Array.isArray(parsed) ? parsed : [parsed];
        fs.writeFileSync(this.backupFile, JSON.stringify(list, null, 2), 'utf8');
        console.log(`[NetworkManager] Network adapter DNS backup saved to ${this.backupFile}`);
        return list;
      }
    } catch (e: any) {
      console.warn(`[NetworkManager] Warning backing up network config: ${e.message}`);
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
          try { socket.close(); } catch {}
          resolve(false);
        }
      }, timeoutMs);

      socket.on('message', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { socket.close(); } catch {}
          resolve(true);
        }
      });

      socket.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { socket.close(); } catch {}
          resolve(false);
        }
      });

      // Construct a standard DNS query packet for 'health.safebrowse.local' (Type A)
      const query = Buffer.from([
        0x12, 0x34, // Transaction ID
        0x01, 0x00, // Standard query, recursion desired
        0x00, 0x01, // QDCOUNT = 1
        0x00, 0x00, // ANCOUNT = 0
        0x00, 0x00, // NSCOUNT = 0
        0x00, 0x00, // ARCOUNT = 0
        // Query name: health.safebrowse.local
        0x06, 0x68, 0x65, 0x61, 0x6c, 0x74, 0x68, // 6 health
        0x0a, 0x73, 0x61, 0x66, 0x65, 0x62, 0x72, 0x6f, 0x77, 0x73, 0x65, // 10 safebrowse
        0x05, 0x6c, 0x6f, 0x63, 0x61, 0x6c, // 5 local
        0x00, // null terminator
        0x00, 0x01, // QTYPE = A (1)
        0x00, 0x01  // QCLASS = IN (1)
      ]);

      socket.send(query, port, '127.0.0.1', (err) => {
        if (err && !resolved) {
          resolved = true;
          clearTimeout(timer);
          try { socket.close(); } catch {}
          resolve(false);
        }
      });
    });
  }

  /**
   * Activates local DNS proxy strictly AFTER verifying that 127.0.0.1:53 is operational.
   */
  public async activateFailSafeDns(dnsPort: number = 53): Promise<{ success: boolean; message: string }> {
    console.log('[NetworkManager] Initiating fail-safe network activation...');

    // 1. Ensure backup exists
    if (!fs.existsSync(this.backupFile)) {
      await this.backupCurrentDnsConfig();
    }

    // 2. Verify local DNS listener
    console.log(`[NetworkManager] Testing 127.0.0.1:${dnsPort} local resolver response...`);
    const isResponding = await this.verifyDnsProxyResponding(dnsPort);
    if (!isResponding) {
      console.error(`[NetworkManager] ❌ Fail-safe abort: 127.0.0.1:${dnsPort} is NOT answering DNS queries.`);
      console.error('[NetworkManager] Preserving original network adapter DNS to prevent connectivity loss.');
      return {
        success: false,
        message: `Local DNS proxy on port ${dnsPort} failed health probe. Original network DNS untouched.`
      };
    }

    console.log(`[NetworkManager] ✅ Verified: 127.0.0.1:${dnsPort} responded to DNS probe.`);

    // 3. Configure network adapters
    if (process.platform === 'win32') {
      try {
        const script = `
          $adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
          foreach ($a in $adapters) {
            Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ServerAddresses ('127.0.0.1') -ErrorAction SilentlyContinue
          }
          Clear-DnsClientCache
        `;
        await execAsync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`);
        console.log('[NetworkManager] Active network adapters configured to 127.0.0.1. DNS cache cleared.');
      } catch (err: any) {
        console.error(`[NetworkManager] Error configuring adapter DNS: ${err.message}. Initiating rollback.`);
        await this.restoreOriginalDns();
        return { success: false, message: `Failed configuring adapters: ${err.message}` };
      }
    }

    // 4. Install DoT / DoH blocking firewall rules
    await firewallEngine.initialize();

    return {
      success: true,
      message: 'Fail-safe DNS successfully activated and verified.'
    };
  }

  /**
   * Cleanly restores original adapter DNS configuration from backup.
   */
  public async restoreOriginalDns(): Promise<void> {
    console.log('[NetworkManager] Restoring network adapters to original DNS settings...');

    if (process.platform !== 'win32') {
      console.log('[NetworkManager] Non-Windows platform: simulation complete.');
      return;
    }

    // 1. Remove SafeBrowse firewall rules
    await firewallEngine.teardown();

    // 2. Restore DNS
    try {
      let restoredSpecific = false;
      if (fs.existsSync(this.backupFile)) {
        try {
          const raw = fs.readFileSync(this.backupFile, 'utf8');
          const backupList: AdapterDnsBackup[] = JSON.parse(raw);
          for (const item of backupList) {
            if (item.ServerAddresses && item.ServerAddresses.length > 0) {
              const formattedAddresses = item.ServerAddresses.map((ip) => `'${ip}'`).join(',');
              await execAsync(
                `powershell -NoProfile -Command "Set-DnsClientServerAddress -InterfaceIndex ${item.InterfaceIndex} -ServerAddresses @(${formattedAddresses}) -ErrorAction SilentlyContinue"`
              );
              restoredSpecific = true;
            }
          }
        } catch (e: any) {
          console.warn(`[NetworkManager] Could not parse backup file; falling back to DHCP reset: ${e.message}`);
        }
      }

      // If no specific static addresses were restored or as a safe fallback, reset all adapters to DHCP
      if (!restoredSpecific) {
        await execAsync(
          `powershell -NoProfile -Command "Get-NetAdapter | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }; Clear-DnsClientCache"`
        );
      } else {
        await execAsync('powershell -NoProfile -Command "Clear-DnsClientCache"');
      }

      console.log('[NetworkManager] ✅ Original DNS configuration cleanly restored and DNS cache flushed.');
    } catch (e: any) {
      console.error(`[NetworkManager] Error during DNS restoration: ${e.message}`);
    }
  }
}

export const networkManager = new WindowsNetworkManager();
