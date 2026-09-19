import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface FirewallEngineOptions {
  enableDoTBlocking?: boolean;
  enableDoHBlocking?: boolean;
  blockKnownDoHResolvers?: boolean;
}

/**
 * SafeBrowse Windows Firewall Enforcement Engine
 * 
 * Accurately implements Layer 3/4 Windows Advanced Firewall rules (netsh advfirewall):
 * 1. Blocks outbound Port 853 (DNS-over-TLS) system-wide.
 * 2. Blocks direct IP connections to known DoH bootstrap endpoints on Port 443 to force
 *    browsers (Chrome, Edge, Firefox) to fall back to the local system DNS resolver on 127.0.0.1.
 * 3. Restores all Windows network rules cleanly on shutdown/uninstall.
 */
export class WindowsFirewallEngine {
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

  constructor(private options: FirewallEngineOptions = { enableDoTBlocking: true, enableDoHBlocking: true }) {}

  /**
   * Deterministic SafeBrowse-owned rule names.
   * SafeBrowse teardown strictly touches ONLY these rules.
   */
  public static readonly SAFEBROWSE_RULE_NAMES = [
    'SafeBrowse_Block_DoT_853_TCP',
    'SafeBrowse_Block_DoT_853_UDP',
    'SafeBrowse_Block_DoH_Bootstrap',
  ];

  /**
   * Initialize and install Windows Firewall rules
   */
  public async initialize(): Promise<{ success: boolean; ruleCount: number; warning?: string }> {
    if (process.platform !== 'win32') {
      return { success: true, ruleCount: 0, warning: 'Non-Windows platform detected; Firewall simulation active.' };
    }

    // Pre-clean any existing stale SafeBrowse rules before adding
    await this.teardown();

    try {
      // 1. Install Rule: Block Outbound TCP/UDP Port 853 (DoT - DNS over TLS)
      if (this.options.enableDoTBlocking !== false) {
        const dotRuleName = 'SafeBrowse_Block_DoT_853_TCP';
        const dotUdpRuleName = 'SafeBrowse_Block_DoT_853_UDP';
        await execAsync(`netsh advfirewall firewall add rule name="${dotRuleName}" dir=out action=block protocol=TCP remoteport=853`);
        await execAsync(`netsh advfirewall firewall add rule name="${dotUdpRuleName}" dir=out action=block protocol=UDP remoteport=853`);
        this.activeRules.push(dotRuleName, dotUdpRuleName);
      }

      // 2. Install Rule: Block direct HTTPS to known DoH Resolvers to force standard DNS fallback
      if (this.options.enableDoHBlocking !== false) {
        const dohRuleName = 'SafeBrowse_Block_DoH_Bootstrap';
        const remoteIpList = this.KNOWN_DOH_IPS.join(',');
        await execAsync(`netsh advfirewall firewall add rule name="${dohRuleName}" dir=out action=block protocol=TCP remoteip="${remoteIpList}" remoteport=443`);
        this.activeRules.push(dohRuleName);
      }

      this.isRunning = true;
      console.log(`[Firewall Engine] [OK] Successfully installed ${this.activeRules.length} Windows Firewall rules.`);
      return { success: true, ruleCount: this.activeRules.length };
    } catch (e: any) {
      console.warn(`[Firewall Engine] [WARN] Elevated rule installation requires Administrator privileges (${e.message}). Proceeding with Local DNS filtering.`);
      return { success: false, ruleCount: 0, warning: e.message };
    }
  }

  /**
   * Cleanly teardown and remove all installed firewall rules.
   * Strictly deletes ONLY SafeBrowse-owned deterministic rule names.
   * Safe to call repeatedly and from separate CLI processes (such as --emergency-restore).
   */
  public async teardown(): Promise<void> {
    if (process.platform !== 'win32') return;

    const rulesToDelete = Array.from(new Set([
      ...this.activeRules,
      ...WindowsFirewallEngine.SAFEBROWSE_RULE_NAMES,
    ]));

    for (const rule of rulesToDelete) {
      try {
        await execAsync(`netsh advfirewall firewall delete rule name="${rule}"`);
      } catch (e) {
        // Silently ignore if rule does not exist - ensures full idempotency
      }
    }
    this.activeRules = [];
    this.isRunning = false;
    console.log('[Firewall Engine] [OK] Windows Firewall rules cleanly removed.');
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      activeRuleCount: this.activeRules.length,
      rules: this.activeRules,
    };
  }
}

export const firewallEngine = new WindowsFirewallEngine();
export const wfpEngine = firewallEngine; // Backward compatibility alias
