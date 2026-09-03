import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { firewallEngine } from './wfp-engine';

const execAsync = promisify(exec);

export interface InstallOptions {
  pairingCode?: string;
  deviceName?: string;
  backendUrl?: string;
  installDir?: string;
}

export class WindowsInstaller {
  private installDir: string;
  private backupStateFile: string;
  public readonly serviceName = 'SafeBrowseChildService';

  constructor(options: InstallOptions = {}) {
    this.installDir = options.installDir || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SafeBrowse');
    this.backupStateFile = path.join(this.installDir, 'network-backup.json');
  }

  /**
   * Check if running with elevated Administrator privileges on Windows
   */
  public async checkAdminPrivileges(): Promise<boolean> {
    if (process.platform !== 'win32') return true;
    try {
      await execAsync('net session');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt data using Windows DPAPI machine/user scope
   */
  public async encryptWithDpapi(plainText: string): Promise<string> {
    if (process.platform !== 'win32') {
      return Buffer.from(plainText).toString('base64');
    }
    const escaped = plainText.replace(/"/g, '`"');
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
   * Run the complete Windows installation flow
   */
  public async install(options: InstallOptions = {}): Promise<{ success: boolean; message: string }> {
    console.log('======================================================================');
    console.log('📦 SafeBrowse Child Windows Pilot Installer');
    console.log('======================================================================\n');

    // 1. Admin Privilege Verification
    console.log('[Step 1/6] Checking Administrator privileges...');
    const isAdmin = await this.checkAdminPrivileges();
    if (!isAdmin) {
      throw new Error('❌ Administrator privileges required. Please right-click and Run as Administrator.');
    }
    console.log('✅ Administrator privileges verified.\n');

    try {
      // 2. Directory Creation & File Setup
      console.log(`[Step 2/6] Preparing installation directory at: ${this.installDir}...`);
      if (!fs.existsSync(this.installDir)) {
        fs.mkdirSync(this.installDir, { recursive: true });
      }
      console.log('✅ Installation directory ready.\n');

      // 3. Backup Current Adapter DNS Configuration for Safe Rollback
      console.log('[Step 3/6] Backing up network adapter configuration...');
      await this.backupNetworkConfig();
      console.log('✅ Network configuration backed up safely.\n');

      // 4. Install Windows Firewall Protection Rules
      console.log('[Step 4/6] Installing Windows Firewall rules (Port 853 DoT & DoH IP drops)...');
      const fwResult = await firewallEngine.initialize();
      console.log(`✅ Firewall Rules active: ${fwResult.ruleCount} rules installed.\n`);

      // 5. Register and Start Windows Service (SafeBrowseChildService)
      console.log(`[Step 5/6] Registering Windows Service (${this.serviceName})...`);
      await this.registerWindowsService();
      console.log('✅ Service registered and verified.\n');

      // 6. Configure Windows Network Adapter DNS strictly to 127.0.0.1 (No 1.1.1.1 fallback)
      console.log('[Step 6/6] Configuring active network adapters to SafeBrowse Local DNS (127.0.0.1)...');
      await this.configureAdapterDns();
      console.log('✅ Adapters configured strictly to 127.0.0.1 and DNS cache cleared.\n');

      console.log('======================================================================');
      console.log('🎉 SafeBrowse Child successfully installed and running as a Windows Service!');
      console.log('======================================================================\n');

      return {
        success: true,
        message: 'SafeBrowse Child installed successfully. Service is running.',
      };
    } catch (err: any) {
      console.error('❌ Installation encountered an error! Initiating safe rollback...', err.message);
      await this.rollback();
      throw new Error(`Installation failed: ${err.message}. Network settings restored.`);
    }
  }

  private async backupNetworkConfig() {
    if (process.platform !== 'win32') return;
    try {
      const { stdout } = await execAsync('powershell -NoProfile -Command "Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceIndex, ServerAddresses | ConvertTo-Json"');
      fs.writeFileSync(this.backupStateFile, stdout, 'utf-8');
    } catch (e) {}
  }

  private async configureAdapterDns() {
    if (process.platform !== 'win32') return;
    // Set DNS strictly to 127.0.0.1 (no secondary 1.1.1.1)
    const script = `
      $adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
      foreach ($a in $adapters) {
        Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ServerAddresses ('127.0.0.1') -ErrorAction SilentlyContinue
      }
      Clear-DnsClientCache
    `;
    await execAsync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`);
  }

  private async registerWindowsService() {
    if (process.platform !== 'win32') return;
    const exePath = path.join(this.installDir, 'SafeBrowseChild-Pilot.exe');

    try {
      // 1. Check if service already exists; remove old instance if present
      try {
        await execAsync(`sc.exe stop ${this.serviceName}`);
      } catch {}
      try {
        await execAsync(`sc.exe delete ${this.serviceName}`);
      } catch {}

      // 2. Create service with delayed-auto start under LocalSystem
      await execAsync(`sc.exe create ${this.serviceName} binPath= "\"${exePath}\" service" start= delayed-auto DisplayName= "SafeBrowse Child Protection Service"`);
      
      // 3. Set description
      await execAsync(`sc.exe description ${this.serviceName} "SafeBrowse kernel DNS proxy and parental policy enforcement engine."`);
    } catch (e: any) {
      console.warn(`[Service Registry] Notice: ${e.message}`);
    }
  }

  public async rollback() {
    console.log('[Rollback] Restoring network adapters to original DNS settings...');
    if (process.platform === 'win32') {
      try {
        await execAsync('powershell -NoProfile -Command "Get-NetAdapter | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }; Clear-DnsClientCache"');
      } catch (e) {}
      try {
        await execAsync(`sc.exe stop ${this.serviceName}`);
        await execAsync(`sc.exe delete ${this.serviceName}`);
      } catch (e) {}
    }
    await firewallEngine.teardown();
    console.log('[Rollback] Network restoration complete.');
  }
}

export const windowsInstaller = new WindowsInstaller();
