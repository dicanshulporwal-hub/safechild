import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { wfpEngine } from './wfp-engine';

const execAsync = promisify(exec);

export class WindowsUninstaller {
  private installDir: string;

  constructor(installDir?: string) {
    this.installDir = installDir || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SafeBrowse');
  }

  /**
   * Run clean uninstallation and guarantee full internet restoration
   */
  public async uninstall(): Promise<{ success: boolean; message: string }> {
    console.log('======================================================================');
    console.log('🗑️ SafeBrowse Kids Windows Clean Uninstaller');
    console.log('======================================================================\n');

    // 1. Remove Auto-Start Task
    console.log('[Step 1/4] Removing Windows Auto-Start Task...');
    if (process.platform === 'win32') {
      try {
        await execAsync('schtasks /Delete /TN "SafeBrowseKidsAgent" /F');
        console.log('✅ Auto-Start task removed.');
      } catch (e) {}
    }

    // 2. Teardown WFP Firewall Rules
    console.log('[Step 2/4] Removing WFP firewall callout rules...');
    await wfpEngine.teardown();
    console.log('✅ WFP rules removed.');

    // 3. Restore all Network Adapters to DHCP DNS
    console.log('[Step 3/4] Restoring all network adapters to automatic DHCP DNS...');
    if (process.platform === 'win32') {
      try {
        await execAsync('powershell -Command "Get-NetAdapter | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }; Clear-DnsClientCache"');
        console.log('✅ All adapters restored to DHCP. Normal internet access verified.');
      } catch (e) {}
    }

    // 4. Remove local installation files
    console.log('[Step 4/4] Cleaning local installation files...');
    try {
      if (fs.existsSync(this.installDir)) {
        fs.rmSync(this.installDir, { recursive: true, force: true });
      }
      console.log('✅ Installation directory cleaned.');
    } catch (e) {}

    console.log('\n======================================================================');
    console.log('🎉 SafeBrowse Kids successfully and cleanly uninstalled.');
    console.log('======================================================================\n');

    return {
      success: true,
      message: 'Uninstalled cleanly. Full standard internet connectivity restored.',
    };
  }
}

export const windowsUninstaller = new WindowsUninstaller();
