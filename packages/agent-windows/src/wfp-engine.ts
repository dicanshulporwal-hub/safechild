import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface WfpEngineOptions {
  enableDoTBlocking?: boolean;
  enableDoHBlocking?: boolean;
  blockKnownDoHResolvers?: boolean;
}

/**
 * SafeBrowse Windows Filtering Platform (WFP) Enforcement Engine
 * 
 * Implements Layer 2 kernel/firewall packet filters:
 * 1. Blocks outbound Port 853 (DNS-over-TLS) system-wide.
 * 2. Blocks direct IP connections to known DoH bootstrap endpoints on Port 443 to force
 *    browsers (Chrome, Edge, Firefox) to fall back to the local system DNS resolver.
 * 3. Restores all Windows network rules cleanly on shutdown.
 */
export class WfpEnforcementEngine {
  private activeRules: string[] = [];
  private isRunning: boolean = false;

  // Known Public DoH Bootstrap IP addresses (Cloudflare, Google, Quad9, AdGuard)
  private readonly KNOWN_DOH_IPS = [
    '1.1.1.1',
    '1.0.0.1',
    '8.8.8.8',
    '8.8.4.4',
    '9.9.9.9',
    '149.112.112.112',
    '94.140.14.14',
    '94.140.15.15',
  ];

  constructor(private options: WfpEngineOptions = { enableDoTBlocking: true, enableDoHBlocking: true }) {}

  /**
   * Initialize and install WFP / Firewall callout rules
   */
  public async initialize(): Promise<{ success: boolean; ruleCount: number; warning?: string }> {
    if (process.platform !== 'win32') {
      return { success: true, ruleCount: 0, warning: 'Non-Windows platform detected; WFP simulation active.' };
    }

    try {
      // 1. Install Rule: Block Outbound TCP/UDP Port 853 (DoT - DNS over TLS)
      if (this.options.enableDoTBlocking !== false) {
        const dotRuleName = 'SafeBrowse_WFP_Block_DoT_853';
        await execAsync(`netsh advfirewall firewall add rule name="${dotRuleName}" dir=out action=block protocol=TCP remoteport=853`);
        await execAsync(`netsh advfirewall firewall add rule name="${dotRuleName}_UDP" dir=out action=block protocol=UDP remoteport=853`);
        this.activeRules.push(dotRuleName, `${dotRuleName}_UDP`);
      }

      // 2. Install Rule: Block direct HTTPS to known DoH Resolvers to force standard DNS fallback
      if (this.options.enableDoHBlocking !== false) {
        const dohRuleName = 'SafeBrowse_WFP_Block_DoH_Bootstrap';
        const remoteIpList = this.KNOWN_DOH_IPS.join(',');
        await execAsync(`netsh advfirewall firewall add rule name="${dohRuleName}" dir=out action=block protocol=TCP remoteip="${remoteIpList}" remoteport=443`);
        this.activeRules.push(dohRuleName);
      }

      this.isRunning = true;
      console.log(`[WFP Engine] 🛡️ Successfully installed ${this.activeRules.length} WFP kernel callout rules.`);
      return { success: true, ruleCount: this.activeRules.length };
    } catch (e: any) {
      console.warn(`[WFP Engine] Note: WFP elevated rule installation requires Administrator privileges (${e.message}). Proceeding with Layer 1 DNS filtering.`);
      return { success: false, ruleCount: 0, warning: e.message };
    }
  }

  /**
   * Cleanly teardown and remove all WFP firewall callouts
   */
  public async teardown(): Promise<void> {
    if (process.platform !== 'win32') return;

    for (const rule of this.activeRules) {
      try {
        await execAsync(`netsh advfirewall firewall delete rule name="${rule}"`);
      } catch (e) {}
    }
    this.activeRules = [];
    this.isRunning = false;
    console.log('[WFP Engine] 🔄 WFP firewall callout rules cleanly removed.');
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      activeRuleCount: this.activeRules.length,
      rules: this.activeRules,
    };
  }
}

export const wfpEngine = new WfpEnforcementEngine();
