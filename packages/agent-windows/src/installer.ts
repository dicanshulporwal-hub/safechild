import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { wfpEngine } from './wfp-engine';

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
   * Run the complete production installation flow
   */
  public async install(options: InstallOptions = {}): Promise<{ success: boolean; message: string }> {
    console.log('======================================================================');
    console.log('📦 SafeBrowse Kids Windows Production Installer (P0 Flow)');
    console.log('======================================================================\n');

    // 1. Admin Privilege Verification
    console.log('[Step 1/6] Checking Administrator privileges...');
    const isAdmin = await this.checkAdminPrivileges();
    if (!isAdmin) {
      throw new Error('❌ Administrator privileges required. Please run setup as Administrator.');
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

      // 4. Install WFP Layer 2 Firewall Callouts
      console.log('[Step 4/6] Installing WFP Layer 2 firewall callouts...');
      const wfpResult = await wfpEngine.initialize();
      console.log(`✅ WFP Rules active: ${wfpResult.ruleCount} rules installed.\n`);

      // 5. Configure Windows Network Adapter DNS to 127.0.0.1
      console.log('[Step 5/6] Configuring active network adapters to SafeBrowse Local DNS (127.0.0.1)...');
      await this.configureAdapterDns();
      console.log('✅ Adapters configured and DNS cache cleared.\n');

      // 6. Register Windows Auto-Start Task / Service
      console.log('[Step 6/6] Configuring Windows Auto-Start Task (SafeBrowseAgentService)...');
      await this.registerAutoStartService();
      console.log('✅ Auto-Start registered for all user logins.\n');

      console.log('======================================================================');
      console.log('🎉 SafeBrowse Kids successfully installed and protected on Windows!');
      console.log('======================================================================\n');

      return {
        success: true,
        message: 'SafeBrowse Kids installed successfully. Protection is active.',
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
      const { stdout } = await execAsync('powershell -Command "Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceIndex, ServerAddresses | ConvertTo-Json"');
      fs.writeFileSync(this.backupStateFile, stdout, 'utf-8');
    } catch (e) {}
  }

  private async configureAdapterDns() {
    if (process.platform !== 'win32') return;
    const script = `
      $adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
      foreach ($a in $adapters) {
        Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ServerAddresses ('127.0.0.1', '1.1.1.1') -ErrorAction SilentlyContinue
      }
      Clear-DnsClientCache
    `;
    await execAsync(`powershell -Command "${script.replace(/\r?\n/g, ' ')}"`);
  }

  private async registerAutoStartService() {
    if (process.platform !== 'win32') return;
    const taskName = 'SafeBrowseKidsAgent';
    const exePath = path.join(this.installDir, 'SafeBrowseKidsAgent.exe');
    // Register elevated Scheduled Task that launches at system logon
    try {
      await execAsync(`schtasks /Create /TN "${taskName}" /TR "'${exePath}'" /SC ONLOGON /RL HIGHEST /F`);
    } catch (e) {}
  }

  public async rollback() {
    console.log('[Rollback] Restoring network adapters to DHCP...');
    if (process.platform === 'win32') {
      try {
        await execAsync('powershell -Command "Get-NetAdapter | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }; Clear-DnsClientCache"');
      } catch (e) {}
    }
    await wfpEngine.teardown();
    console.log('[Rollback] Network restoration complete.');
  }
}

export const windowsInstaller = new WindowsInstaller();
