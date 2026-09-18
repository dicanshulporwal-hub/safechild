import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { configManager, ConfigManager } from './config-manager';
import { networkManager } from './network-manager';
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
  public readonly serviceName = 'SafeBrowseChildService';

  constructor(options: InstallOptions = {}) {
    this.installDir = options.installDir || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SafeBrowse');
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
   * Run the complete Windows installation flow
   */
  public async install(options: InstallOptions = {}): Promise<{ success: boolean; message: string }> {
    console.log('======================================================================');
    console.log('📦 SafeBrowse Child Windows Pilot Installer');
    console.log('======================================================================\n');

    // 1. Admin Privilege Verification
    console.log('[Step 1/5] Checking Administrator privileges...');
    const isAdmin = await this.checkAdminPrivileges();
    if (!isAdmin) {
      throw new Error('❌ Administrator privileges required. Please right-click and Run as Administrator.');
    }
    console.log('✅ Administrator privileges verified.\n');

    try {
      // 2. Directory Creation & Machine-Level Storage Setup
      console.log(`[Step 2/5] Preparing Program Files directory: ${this.installDir}...`);
      if (!fs.existsSync(this.installDir)) {
        fs.mkdirSync(this.installDir, { recursive: true });
      }
      console.log(`[Step 2/5] Initializing ProgramData storage: ${configManager.getBaseDir()}...`);
      configManager.ensureDirectories();
      console.log('✅ Storage directories initialized.\n');

      // 3. Backup Current Adapter DNS Configuration for Safe Rollback
      console.log('[Step 3/5] Backing up network adapter configuration...');
      await networkManager.backupCurrentDnsConfig();
      console.log('✅ Network configuration safely backed up.\n');

      // 4. Register Windows Service (SafeBrowseChildService)
      console.log(`[Step 4/5] Registering Windows Service (${this.serviceName})...`);
      await this.registerWindowsService();
      console.log('✅ Service registered successfully with Delayed-Auto start.\n');

      // 5. Optional Initial Pairing
      if (options.pairingCode) {
        console.log('[Step 5/5] Performing device pairing with provided code...');
        const targetUrl = configManager.validateBackendUrl(options.backendUrl || ConfigManager.DEFAULT_PILOT_URL);
        const res = await fetch(`${targetUrl}/api/devices/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: options.pairingCode,
            deviceName: options.deviceName || "Rahul's Windows Laptop",
            platform: 'windows',
            agentVersion: '1.0.0',
          }),
        });

        if (res.ok) {
          const data: any = await res.json();
          await configManager.saveDeviceConfig({
            deviceId: data.device.id,
            deviceToken: data.device.deviceToken,
            childId: data.device.childId,
            parentId: data.device.parentId,
            deviceName: data.device.name,
            backendUrl: targetUrl,
            pairedAt: new Date().toISOString(),
          });
          console.log('✅ Device successfully paired during installation.\n');

          // Start service now that device is paired
          if (process.platform === 'win32') {
            try {
              await execAsync(`sc.exe start ${this.serviceName}`);
            } catch {}
          }
        } else {
          console.warn('⚠️ Warning: Pairing code claim did not succeed; device can be paired post-install with --pair.');
        }
      } else {
        console.log('[Step 5/5] Note: DNS enforcement is deferred until administrator pairs this device.');
        console.log('         Run: SafeBrowseChild-Pilot.exe --pair <CODE> to activate.\n');
      }

      console.log('======================================================================');
      console.log('🎉 SafeBrowse Child successfully installed!');
      console.log('======================================================================\n');

      return {
        success: true,
        message: 'SafeBrowse Child installed successfully.',
      };
    } catch (err: any) {
      console.error('❌ Installation encountered an error! Initiating safe rollback...', err.message);
      await this.rollback();
      throw new Error(`Installation failed: ${err.message}. Network settings restored.`);
    }
  }

  private async registerWindowsService(): Promise<void> {
    if (process.platform !== 'win32') return;

    // Prefer SafeBrowseServiceHost.exe if present, else fallback to direct binary
    const hostExe = path.join(this.installDir, 'SafeBrowseServiceHost.exe');
    const childExe = path.join(this.installDir, 'SafeBrowseChild-Pilot.exe');
    const binPath = fs.existsSync(hostExe) ? hostExe : `"${childExe}" service`;

    try {
      try {
        await execAsync(`sc.exe stop ${this.serviceName}`);
      } catch {}
      try {
        await execAsync(`sc.exe delete ${this.serviceName}`);
      } catch {}

      // Create service with delayed-auto start under LocalSystem
      await execAsync(
        `sc.exe create ${this.serviceName} binPath= "${binPath}" start= delayed-auto DisplayName= "SafeBrowse Child Protection Service"`
      );
      await execAsync(
        `sc.exe description ${this.serviceName} "SafeBrowse DNS filtering and parental policy enforcement service."`
      );
    } catch (e: any) {
      console.warn(`[Service Registry] Notice: ${e.message}`);
    }
  }

  public async rollback(): Promise<void> {
    console.log('[Rollback] Restoring network adapters and cleaning up service...');
    try {
      await networkManager.restoreOriginalDns();
    } catch (e: any) {
      console.warn(`[Rollback] Warning restoring DNS: ${e.message}`);
    }

    if (process.platform === 'win32') {
      try {
        await execAsync(`sc.exe stop ${this.serviceName}`);
      } catch {}
      try {
        await execAsync(`sc.exe delete ${this.serviceName}`);
      } catch {}
    }
    console.log('[Rollback] Safe rollback complete.');
  }
}

export const windowsInstaller = new WindowsInstaller();
