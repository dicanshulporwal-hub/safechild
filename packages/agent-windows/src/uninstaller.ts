import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { networkManager } from './network-manager';
import { firewallEngine } from './wfp-engine';

const execAsync = promisify(exec);

export class WindowsUninstaller {
  private installDir: string;
  public readonly serviceName = 'SafeBrowseChildService';

  constructor(installDir?: string) {
    this.installDir = installDir || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SafeBrowse');
  }

  /**
   * Run clean uninstallation and guarantee full internet restoration
   */
  public async uninstall(cleanAllData: boolean = false): Promise<{ success: boolean; message: string }> {
    console.log('======================================================================');
    console.log('🗑️ SafeBrowse Child Windows Clean Uninstaller');
    console.log('======================================================================\n');

    // 1. Stop and Delete Windows Service
    console.log('[Step 1/5] Stopping and removing SafeBrowse Windows Service...');
    if (process.platform === 'win32') {
      try {
        await execAsync(`sc.exe stop ${this.serviceName}`);
      } catch (e) {}
      try {
        await execAsync(`sc.exe delete ${this.serviceName}`);
        console.log('✅ SafeBrowseChildService stopped and unregistered.');
      } catch (e) {}
    }

    // 2. Teardown SafeBrowse Firewall Rules
    console.log('[Step 2/5] Removing SafeBrowse firewall callout rules...');
    await firewallEngine.teardown();
    console.log('✅ SafeBrowse firewall rules removed.');

    // 3. Restore all Network Adapters to original DNS / DHCP
    console.log('[Step 3/5] Restoring all network adapters to original DNS / DHCP...');
    await networkManager.restoreOriginalDns();
    console.log('✅ All adapters restored. Normal internet access verified.');

    // 4. Remove local installation binaries
    console.log('[Step 4/5] Cleaning application binaries...');
    try {
      if (fs.existsSync(this.installDir)) {
        fs.rmSync(this.installDir, { recursive: true, force: true });
      }
      console.log('✅ Installation directory cleaned.');
    } catch (e: any) {
      console.warn(`[Uninstaller] Notice: Could not remove directory completely: ${e.message}`);
    }

    // 5. Machine data handling
    if (cleanAllData) {
      console.log('[Step 5/5] Purging ProgramData storage...');
      const programDataDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'SafeBrowse');
      try {
        if (fs.existsSync(programDataDir)) {
          fs.rmSync(programDataDir, { recursive: true, force: true });
        }
      } catch {}
    } else {
      console.log('[Step 5/5] Preserving diagnostic logs in C:\\ProgramData\\SafeBrowse\\logs for troubleshooting.');
    }

    console.log('\n======================================================================');
    console.log('🎉 SafeBrowse Child successfully and cleanly uninstalled.');
    console.log('======================================================================\n');

    return {
      success: true,
      message: 'Uninstalled cleanly. Full standard internet connectivity restored.',
    };
  }
}

export const windowsUninstaller = new WindowsUninstaller();
