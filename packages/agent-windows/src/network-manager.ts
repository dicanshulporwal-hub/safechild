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
 * Strips non-ASCII characters to prevent Windows PowerShell 5.1 mojibake.
 */
export function logServiceMessage(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const timestamp = new Date().toISOString();
  const cleanMessage = message.replace(/[^\x00-\x7F]/g, '');
  const formatted = `[${timestamp}] [${level}] ${cleanMessage}\n`;
  if (level === 'ERROR') {
    console.error(cleanMessage);
  } else if (level === 'WARN') {
    console.warn(cleanMessage);
  } else {
    console.log(cleanMessage);
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
  Gateway?: string;
  IpAddresses?: string[];
}

export type ActivationReasonCode =
  | 'ELIGIBLE_ADAPTER_FOUND'
  | 'NO_NETWORK_ROUTE'
  | 'DISCOVERY_COMMAND_FAILED'
  | 'DNS_PROXY_HEALTH_CHECK_FAILED'
  | 'DNS_ASSIGNMENT_FAILED'
  | 'READBACK_MISMATCH'
  | 'CRITICAL_ROLLBACK_FAILED';

export interface FailSafeDnsResult {
  success: boolean;
  message: string;
  interfaceIndexes?: number[];
  details?: string;
  reason?: ActivationReasonCode;
  discoveryMethod?: 'route-table' | 'net-ip-config' | 'mock';
}

export interface CandidateEvaluation {
  interfaceIndex: number;
  interfaceAlias: string;
  nextHop?: string;
  status?: string;
  ipAddresses?: string[];
  eligible: boolean;
  rejectionReason?: string;
}

export interface AdapterDiscoveryResult {
  method: 'route-table' | 'net-ip-config' | 'mock';
  reason: 'ELIGIBLE_ADAPTER_FOUND' | 'NO_NETWORK_ROUTE' | 'DISCOVERY_COMMAND_FAILED';
  adapters: TargetAdapterInfo[];
  defaultRouteCount: number;
  evaluations: CandidateEvaluation[];
  errorMessage?: string;
}

export interface ActivationRetryOptions {
  dnsPort?: number;
  retryDelaysMs?: number[];
  isCancelled?: () => boolean;
  initialResult?: FailSafeDnsResult;
  onStatusChange?: (status: 'ACTIVE' | 'DEGRADED', reason?: string) => void;
  onTransition?: (from: 'DEGRADED', to: 'ACTIVE', result: FailSafeDnsResult) => void;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
}

export interface ReconcileResult {
  status: 'IN_SYNC' | 'RE_ENFORCED' | 'NO_NETWORK_ROUTE' | 'ERROR';
  enforcedIndexes: number[];
  unenforcedIndexes: number[];
  message: string;
}

export interface CurrentEnforcementInspection {
  isProtected: boolean;
  activeAdapters: Array<{
    interfaceIndex: number;
    interfaceAlias: string;
    gateway?: string;
    dnsServers: string[];
    isEnforced: boolean;
    queryStatus?: 'OK' | 'QUERY_FAILED';
  }>;
  summary: string;
}

export interface MockAdapterState {
  InterfaceIndex: number;
  InterfaceAlias: string;
  Description?: string;
  Gateway?: string;
  IpAddresses?: string[];
  ServerAddresses: string[];
  DhcpEnabled: boolean;
  Status?: string;
}

export type NetworkCommandExecutor = (script: string) => Promise<{ stdout: string; stderr: string }>;

/**
 * Result of a per-adapter DNS state query.
 * queryStatus distinguishes between a successful read of an empty list vs a query failure.
 */
export interface AdapterDnsQueryResult {
  InterfaceIndex: number;
  InterfaceAlias: string;
  ServerAddresses: string[];
  CleanNonLoopback: string[];
  IsEnforced: boolean;
  DhcpEnabled: boolean;
  /** 'OK' = query succeeded (possibly returning empty addresses).
   *  'QUERY_FAILED' = PowerShell/CIM returned no row for this specific index. */
  queryStatus: 'OK' | 'QUERY_FAILED';
}


export class WindowsNetworkManager {
  private backupFile: string;
  private platformOverride: string | null = null;
  private commandExecutor: NetworkCommandExecutor | null = null;
  private isReconciling = false;
  private isShuttingDown = false;
  private isRestoring = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private mockAdapters: MockAdapterState[] | null = null;

  constructor(customBackupFile?: string) {
    this.backupFile = customBackupFile || configManager.getNetworkBackupFilePath();
  }

  public setPlatformForTesting(platform: string | null): void {
    this.platformOverride = platform;
  }

  public setCommandExecutorForTesting(executor: NetworkCommandExecutor | null): void {
    this.commandExecutor = executor;
  }

  public setMockAdaptersForTesting(adapters: MockAdapterState[] | null): void {
    this.mockAdapters = adapters;
  }

  public setShuttingDown(shuttingDown: boolean): void {
    this.isShuttingDown = shuttingDown;
    if (shuttingDown && this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  public isShuttingDownState(): boolean {
    return this.isShuttingDown;
  }

  public isReconcilingState(): boolean {
    return this.isReconciling;
  }

  public getPlatform(): string {
    return this.platformOverride || process.platform;
  }

  public getBackupFilePath(): string {
    return this.backupFile;
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
   * Discovers active IPv4 internet-facing adapters.
   * PRIMARY: Uses the IPv4 routing table (Get-NetRoute -DestinationPrefix '0.0.0.0/0')
   * FALLBACK: Get-NetIPConfiguration if primary route discovery returns no eligible adapter.
   * Distinguishes ELIGIBLE_ADAPTER_FOUND, NO_NETWORK_ROUTE, and DISCOVERY_COMMAND_FAILED.
   */
  public async discoverTargetAdapters(suppressLogs: boolean = false): Promise<AdapterDiscoveryResult> {
    if (this.getPlatform() !== 'win32') {
      if (this.mockAdapters !== null) {
        const evaluations: CandidateEvaluation[] = [];
        const eligibleAdapters: TargetAdapterInfo[] = [];

        for (const ma of this.mockAdapters) {
          const idx = ma.InterfaceIndex;
          const nextHop = ma.Gateway || '';
          const status = ma.Status || 'Up';
          const ips = ma.IpAddresses || [];
          let rejectionReason: string | undefined;

          if (!nextHop || nextHop === '0.0.0.0' || nextHop === '::') {
            rejectionReason = 'Invalid or zero NextHop';
          } else if (status !== 'Up') {
            rejectionReason = `Adapter status is '${status}', expected 'Up'`;
          } else if (
            ma.InterfaceAlias?.toLowerCase().includes('tailscale') ||
            (nextHop.startsWith('100.') && ma.InterfaceAlias?.toLowerCase().includes('tailscale'))
          ) {
            rejectionReason = 'Tailscale CGNAT or virtual interface excluded';
          } else {
            const usable = ips.filter((ip) => !ip.startsWith('169.254.') && !ip.startsWith('127.'));
            if (usable.length === 0) {
              rejectionReason = ips.length > 0 ? 'Adapter has only APIPA or loopback IPv4 addresses' : 'No IPv4 address assigned to adapter';
            }
          }

          const eligible = !rejectionReason;
          evaluations.push({
            interfaceIndex: idx,
            interfaceAlias: ma.InterfaceAlias,
            nextHop,
            status,
            ipAddresses: ips,
            eligible,
            rejectionReason,
          });

          if (eligible) {
            eligibleAdapters.push({
              InterfaceIndex: idx,
              InterfaceAlias: ma.InterfaceAlias,
              Description: ma.Description || ma.InterfaceAlias,
              Gateway: nextHop,
              IpAddresses: ips,
            });
          }
        }

        const reason = eligibleAdapters.length > 0 ? 'ELIGIBLE_ADAPTER_FOUND' : 'NO_NETWORK_ROUTE';
        return {
          method: 'mock',
          reason,
          adapters: eligibleAdapters,
          defaultRouteCount: eligibleAdapters.length,
          evaluations,
        };
      }

      // Simulation for non-Windows test environments
      const mockCandidate: CandidateEvaluation = {
        interfaceIndex: 6,
        interfaceAlias: 'Wi-Fi',
        nextHop: '192.168.1.1',
        status: 'Up',
        ipAddresses: ['192.168.1.8'],
        eligible: true,
      };
      const mockAdapter: TargetAdapterInfo = {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Description: 'Mock Wi-Fi Adapter',
        Gateway: '192.168.1.1',
        IpAddresses: ['192.168.1.8'],
      };
      return {
        method: 'mock',
        reason: 'ELIGIBLE_ADAPTER_FOUND',
        adapters: [mockAdapter],
        defaultRouteCount: 1,
        evaluations: [mockCandidate],
      };
    }

    if (!suppressLogs) {
      logServiceMessage('INFO', '[NetworkManager] Starting route-based network adapter discovery...');
    }

    // 1. PRIMARY DISCOVERY: Route Table (IPv4 0.0.0.0/0)
    let routeScriptError: string | null = null;
    let primaryEvaluations: CandidateEvaluation[] = [];
    let primaryRouteCount = 0;
    try {
      const primaryScript = [
        '$ErrorActionPreference = \'Stop\'',
        'try {',
        '    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix \'0.0.0.0/0\' -ErrorAction Stop)',
        '} catch {',
        '    if ($_.FullyQualifiedErrorId -match \'NoMatching\' -or $_.Exception.Message -match \'No matching|not found|No MSFT_NetRoute\') {',
        '        $routes = @()',
        '    } else {',
        '        throw',
        '    }',
        '}',
        '$evaluations = @()',
        '$eligible = @()',
        '$seenIndexes = @{}',
        'foreach ($r in $routes) {',
        '    $idx = [int]$r.InterfaceIndex',
        '    $nextHop = if ($r.NextHop) { [string]$r.NextHop } else { \'\' }',
        '    $alias = if ($r.InterfaceAlias) { [string]$r.InterfaceAlias } else { \'\' }',
        '    $rejectionReason = $null',
        '    $adapterStatus = \'Unknown\'',
        '    $ipsList = @()',
        '    if ([string]::IsNullOrWhiteSpace($nextHop) -or $nextHop -eq \'0.0.0.0\' -or $nextHop -eq \'::\') {',
        '        $rejectionReason = \'Invalid or zero NextHop\'',
        '    } else {',
        '        $adapter = @(Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue)[0]',
        '        if (-not $adapter) {',
        '            $rejectionReason = "NetAdapter not found for InterfaceIndex $idx"',
        '        } else {',
        '            $adapterStatus = [string]$adapter.Status',
        '            if ($adapterStatus -ne \'Up\') {',
        '                $rejectionReason = "Adapter status is \'$adapterStatus\', expected \'Up\'"',
        '            } else {',
        '                if (-not $alias) { $alias = [string]$adapter.InterfaceAlias }',
        '                $rawIps = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue)',
        '                $usableIps = @()',
        '                foreach ($ip in $rawIps) {',
        '                    if ($ip.IPAddress) {',
        '                        $addr = [string]$ip.IPAddress',
        '                        $ipsList += $addr',
        '                        if (-not ($addr.StartsWith(\'169.254.\') -or $addr.StartsWith(\'127.\')) ) {',
        '                            $usableIps += $addr',
        '                        }',
        '                    }',
        '                }',
        '                if ($usableIps.Count -eq 0) {',
        '                    if ($ipsList.Count -gt 0) {',
        '                        $rejectionReason = \'Adapter has only APIPA or loopback IPv4 addresses\'',
        '                    } else {',
        '                        $rejectionReason = \'No IPv4 address assigned to adapter\'',
        '                    }',
        '                }',
        '            }',
        '        }',
        '    }',
        '    $isEligible = ($rejectionReason -eq $null)',
        '    if ($isEligible -and -not $seenIndexes.ContainsKey($idx)) {',
        '        $seenIndexes[$idx] = $true',
        '        $desc = if ($adapter -and $adapter.InterfaceDescription) { [string]$adapter.InterfaceDescription } else { \'\' }',
        '        $eligible += [PSCustomObject]@{',
        '            InterfaceIndex = $idx',
        '            InterfaceAlias = if ($alias) { $alias } else { "Interface $idx" }',
        '            Description = $desc',
        '            Gateway = $nextHop',
        '            IPv4Addresses = $ipsList',
        '        }',
        '    }',
        '    $evaluations += [PSCustomObject]@{',
        '        InterfaceIndex = $idx',
        '        InterfaceAlias = $alias',
        '        NextHop = $nextHop',
        '        Status = $adapterStatus',
        '        IPv4Addresses = $ipsList',
        '        Eligible = $isEligible',
        '        RejectionReason = if ($rejectionReason) { $rejectionReason } else { \'\' }',
        '    }',
        '}',
        '[PSCustomObject]@{',
        '    DefaultRouteCount = $routes.Count',
        '    Eligible = $eligible',
        '    Evaluations = $evaluations',
        '} | ConvertTo-Json -Compress -Depth 4',
      ].join('\n');

      const { stdout } = await this.executePowerShell(primaryScript);
      const trimmed = stdout.trim();
      if (trimmed && trimmed !== '[]' && trimmed !== 'null') {
        const parsed = JSON.parse(trimmed);
        let defaultRouteCount = 0;
        let eligibleAdapters: TargetAdapterInfo[] = [];
        let evaluations: CandidateEvaluation[] = [];

        if (Array.isArray(parsed)) {
          defaultRouteCount = parsed.length;
          eligibleAdapters = parsed.map((item: any) => ({
            InterfaceIndex: Number(item.InterfaceIndex),
            InterfaceAlias: String(item.InterfaceAlias || `Interface ${item.InterfaceIndex}`),
            Description: item.Description ? String(item.Description) : undefined,
            Gateway: item.Gateway || item.NextHop ? String(item.Gateway || item.NextHop) : undefined,
            IpAddresses: Array.isArray(item.IPv4Addresses) ? item.IPv4Addresses.map(String) : [],
          }));
          evaluations = eligibleAdapters.map((a) => ({
            interfaceIndex: a.InterfaceIndex,
            interfaceAlias: a.InterfaceAlias,
            nextHop: a.Gateway,
            status: 'Up',
            ipAddresses: a.IpAddresses,
            eligible: true,
          }));
        } else if (parsed && typeof parsed === 'object') {
          defaultRouteCount = Number(parsed.DefaultRouteCount || 0);
          const rawEvals = Array.isArray(parsed.Evaluations)
            ? parsed.Evaluations
            : parsed.Evaluations
            ? [parsed.Evaluations]
            : [];
          const rawEligible = Array.isArray(parsed.Eligible)
            ? parsed.Eligible
            : parsed.Eligible
            ? [parsed.Eligible]
            : [];

          evaluations = rawEvals.map((e: any) => ({
            interfaceIndex: Number(e.InterfaceIndex),
            interfaceAlias: String(e.InterfaceAlias || `Interface ${e.InterfaceIndex}`),
            nextHop: e.NextHop ? String(e.NextHop) : undefined,
            status: e.Status ? String(e.Status) : undefined,
            ipAddresses: Array.isArray(e.IPv4Addresses) ? e.IPv4Addresses.map(String) : [],
            eligible: Boolean(e.Eligible),
            rejectionReason: e.RejectionReason ? String(e.RejectionReason) : undefined,
          }));

          eligibleAdapters = rawEligible.map((item: any) => ({
            InterfaceIndex: Number(item.InterfaceIndex),
            InterfaceAlias: String(item.InterfaceAlias || `Interface ${item.InterfaceIndex}`),
            Description: item.Description ? String(item.Description) : undefined,
            Gateway: item.Gateway || item.NextHop ? String(item.Gateway || item.NextHop) : undefined,
            IpAddresses: Array.isArray(item.IPv4Addresses) ? item.IPv4Addresses.map(String) : [],
          }));
        }

        primaryEvaluations = evaluations;
        primaryRouteCount = defaultRouteCount;

        if (!suppressLogs) {
          logServiceMessage('INFO', '[NetworkManager] Discovery method: route-table');
          logServiceMessage(
            'INFO',
            `[NetworkManager] Route discovery found ${defaultRouteCount} default IPv4 route(s).`
          );

          for (const ev of evaluations) {
            if (ev.eligible) {
              logServiceMessage(
                'INFO',
                `[NetworkManager] Candidate: InterfaceIndex ${ev.interfaceIndex} (${ev.interfaceAlias}), NextHop: ${ev.nextHop || 'N/A'}, Status: ${ev.status || 'Up'}, IP: ${ev.ipAddresses?.join(', ') || 'none'} - Eligible`
              );
            } else {
              logServiceMessage(
                'INFO',
                `[NetworkManager] Candidate: InterfaceIndex ${ev.interfaceIndex} (${ev.interfaceAlias}), NextHop: ${ev.nextHop || 'none'}, Status: ${ev.status || 'unknown'} - Excluded: ${ev.rejectionReason}`
              );
            }
          }

          if (eligibleAdapters.length > 0) {
            for (const a of eligibleAdapters) {
              logServiceMessage(
                'INFO',
                `[NetworkManager] [OK] Selected adapter: ${a.InterfaceAlias} (Index ${a.InterfaceIndex}), Gateway: ${a.Gateway || 'N/A'}`
              );
            }
            logServiceMessage(
              'INFO',
              `[NetworkManager] Discovery result: ELIGIBLE_ADAPTER_FOUND (${eligibleAdapters.length} adapter(s) selected)`
            );
          }
        }

        if (eligibleAdapters.length > 0) {
          return {
            method: 'route-table',
            reason: 'ELIGIBLE_ADAPTER_FOUND',
            adapters: eligibleAdapters,
            defaultRouteCount,
            evaluations,
          };
        }

        logServiceMessage(
          'INFO',
          '[NetworkManager] Route discovery found no eligible routes; attempting fallback.'
        );
      } else {
        logServiceMessage(
          'INFO',
          '[NetworkManager] Route discovery returned empty output; attempting fallback.'
        );
      }
    } catch (routeErr: any) {
      routeScriptError = routeErr.message;
      logServiceMessage(
        'WARN',
        `[NetworkManager] [WARN] Route discovery command failed: ${routeErr.message}. Attempting fallback.`
      );
    }

    // 2. FALLBACK DISCOVERY: Get-NetIPConfiguration
    logServiceMessage('INFO', '[NetworkManager] Discovery method: net-ip-config fallback');
    try {
      const fallbackScript = [
        '$ErrorActionPreference = \'Stop\'',
        '$configs = @(Get-NetIPConfiguration | Where-Object {',
        '    $_.NetAdapter.Status -eq \'Up\' -and $_.IPv4DefaultGateway -ne $null',
        '})',
        '$result = @(',
        '    foreach ($c in $configs) {',
        '        $gw = if ($c.IPv4DefaultGateway.NextHop) { [string]$c.IPv4DefaultGateway.NextHop } else { \'\' }',
        '        [PSCustomObject]@{',
        '            InterfaceIndex = [int]$c.InterfaceIndex',
        '            InterfaceAlias = [string]$c.InterfaceAlias',
        '            Description = if ($c.InterfaceDescription) { [string]$c.InterfaceDescription } else { \'\' }',
        '            Gateway = $gw',
        '        }',
        '    }',
        ')',
        'if (@($result).Count -gt 0) {',
        '    $result | ConvertTo-Json -Compress',
        '} else {',
        '    \'[]\'',
        '}',
      ].join('\n');

      const { stdout } = await this.executePowerShell(fallbackScript);
      const trimmed = stdout.trim();
      if (trimmed && trimmed !== '[]' && trimmed !== 'null') {
        const parsed = JSON.parse(trimmed);
        const rawList = Array.isArray(parsed) ? parsed : [parsed];
        const seen = new Set<number>();
        const validFallback: TargetAdapterInfo[] = [];

        for (const item of rawList) {
          if (!item || typeof item.InterfaceIndex === 'undefined') continue;
          const idx = Number(item.InterfaceIndex);
          const gw = item.Gateway ? String(item.Gateway).trim() : '';
          if (gw === '0.0.0.0' || gw === '::') continue;
          if (!seen.has(idx)) {
            seen.add(idx);
            validFallback.push({
              InterfaceIndex: idx,
              InterfaceAlias: String(item.InterfaceAlias || `Interface ${idx}`),
              Description: item.Description ? String(item.Description) : undefined,
              Gateway: gw || undefined,
            });
          }
        }

        if (validFallback.length > 0) {
          for (const a of validFallback) {
            logServiceMessage(
              'INFO',
              `[NetworkManager] [OK] Fallback selected adapter: ${a.InterfaceAlias} (Index ${a.InterfaceIndex}), Gateway: ${a.Gateway || 'N/A'}`
            );
          }
          logServiceMessage(
            'INFO',
            `[NetworkManager] Discovery result: ELIGIBLE_ADAPTER_FOUND (via net-ip-config fallback, ${validFallback.length} adapter(s))`
          );
          return {
            method: 'net-ip-config',
            reason: 'ELIGIBLE_ADAPTER_FOUND',
            adapters: validFallback,
            defaultRouteCount: validFallback.length,
            evaluations: validFallback.map((a) => ({
              interfaceIndex: a.InterfaceIndex,
              interfaceAlias: a.InterfaceAlias,
              nextHop: a.Gateway,
              status: 'Up',
              eligible: true,
            })),
          };
        }
      }

      logServiceMessage(
        'WARN',
        '[NetworkManager] Fallback discovery found no eligible adapters with default gateway.'
      );

      if (routeScriptError) {
        logServiceMessage(
          'ERROR',
          `[NetworkManager] [ERROR] Discovery failed: Primary route discovery failed (${routeScriptError}) and fallback found no routes.`
        );
        return {
          method: 'net-ip-config',
          reason: 'DISCOVERY_COMMAND_FAILED',
          adapters: [],
          defaultRouteCount: primaryRouteCount,
          evaluations: primaryEvaluations,
          errorMessage: routeScriptError,
        };
      }

      logServiceMessage(
        'WARN',
        '[NetworkManager] Discovery result: NO_NETWORK_ROUTE (no active IPv4 default routes found).'
      );
      return {
        method: 'net-ip-config',
        reason: 'NO_NETWORK_ROUTE',
        adapters: [],
        defaultRouteCount: primaryRouteCount,
        evaluations: primaryEvaluations,
      };
    } catch (fallbackErr: any) {
      logServiceMessage(
        'ERROR',
        `[NetworkManager] [ERROR] Fallback discovery command failed: ${fallbackErr.message}`
      );
      return {
        method: 'net-ip-config',
        reason: 'DISCOVERY_COMMAND_FAILED',
        adapters: [],
        defaultRouteCount: primaryRouteCount,
        evaluations: primaryEvaluations,
        errorMessage: routeScriptError
          ? `Primary: ${routeScriptError}; Fallback: ${fallbackErr.message}`
          : fallbackErr.message,
      };
    }
  }

  /**
   * Identifies active IPv4 internet-facing adapters.
   * Returns list of TargetAdapterInfo for callers.
   */
  public async getTargetAdapters(): Promise<TargetAdapterInfo[]> {
    const res = await this.discoverTargetAdapters();
    return res.adapters;
  }

  /**
   * Safely persists or refreshes an adapter's backup record in ProgramData.
   * STRICT INVARIANTS:
   * 1. NEVER writes 127.0.0.1 or ::1 to ServerAddresses.
   * 2. If the adapter is DHCP, ensures DhcpEnabled = true.
   * 3. Preserves legitimate static DNS configurations without guessing.
   */
  public persistOrRefreshAdapterBackup(backupRecord: AdapterDnsBackup): AdapterDnsBackup[] {
    configManager.ensureDirectories();
    let existingList: AdapterDnsBackup[] = [];
    if (fs.existsSync(this.backupFile)) {
      try {
        const raw = fs.readFileSync(this.backupFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existingList = parsed;
      } catch {}
    }

    const cleanAddrs = (backupRecord.ServerAddresses || []).filter(
      (ip) => ip && !ip.includes('127.0.0.1') && !ip.includes('::1')
    );

    const existingIndex = existingList.findIndex((b) => b.InterfaceIndex === backupRecord.InterfaceIndex);
    if (existingIndex === -1) {
      existingList.push({
        InterfaceIndex: backupRecord.InterfaceIndex,
        InterfaceAlias: backupRecord.InterfaceAlias || `Interface ${backupRecord.InterfaceIndex}`,
        ServerAddresses: cleanAddrs,
        DhcpEnabled: backupRecord.DhcpEnabled !== false,
      });
    } else {
      const existing = existingList[existingIndex];
      // Do not overwrite with loopback
      if (cleanAddrs.length > 0) {
        existing.ServerAddresses = cleanAddrs;
      }
      if (backupRecord.InterfaceAlias) {
        existing.InterfaceAlias = backupRecord.InterfaceAlias;
      }
      if (typeof backupRecord.DhcpEnabled === 'boolean') {
        existing.DhcpEnabled = backupRecord.DhcpEnabled;
      }
    }

    fs.writeFileSync(this.backupFile, JSON.stringify(existingList, null, 2), 'utf8');
    return existingList;
  }

  /**
   * Backs up target adapter DNS configuration into ProgramData before modification.
   * Merges newly discovered adapters into existing backup while preserving valid historical records.
   * Never records 127.0.0.1 or ::1 as original DNS.
   */
  public async backupCurrentDnsConfig(targetAdapters?: TargetAdapterInfo[]): Promise<AdapterDnsBackup[]> {
    if (this.getPlatform() !== 'win32') {
      configManager.ensureDirectories();
      let existingList: AdapterDnsBackup[] = [];
      if (fs.existsSync(this.backupFile)) {
        try {
          const raw = fs.readFileSync(this.backupFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) existingList = parsed;
        } catch {}
      }

      const existingMap = new Map<number, AdapterDnsBackup>();
      for (const b of existingList) {
        if (!b.ServerAddresses || !b.ServerAddresses.every((ip) => ip.includes('127.0.0.1'))) {
          existingMap.set(b.InterfaceIndex, b);
        }
      }

      const targets: TargetAdapterInfo[] =
        targetAdapters && targetAdapters.length > 0
          ? targetAdapters
          : existingMap.size > 0
          ? []
          : [{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', IpAddresses: ['192.168.1.8'], Gateway: '192.168.1.1' }];

      for (const t of targets) {
        let defaultAddrs = t.Gateway ? [t.Gateway] : ['192.168.1.1'];
        let defaultDhcp = false;
        if (this.mockAdapters) {
          const ma = this.mockAdapters.find((a) => a.InterfaceIndex === t.InterfaceIndex);
          if (ma) {
            defaultAddrs = (ma.ServerAddresses || []).filter(
              (ip) => !ip.includes('127.0.0.1') && !ip.includes('::1')
            );
            if (defaultAddrs.length === 0 && ma.Gateway) {
              defaultAddrs = [ma.Gateway];
            }
            defaultDhcp = ma.DhcpEnabled !== false;
          }
        }

        if (!existingMap.has(t.InterfaceIndex)) {
          existingMap.set(t.InterfaceIndex, {
            InterfaceIndex: t.InterfaceIndex,
            InterfaceAlias: t.InterfaceAlias,
            ServerAddresses: defaultAddrs,
            DhcpEnabled: defaultDhcp,
          });
        }
      }

      const merged = Array.from(existingMap.values());
      fs.writeFileSync(this.backupFile, JSON.stringify(merged, null, 2), 'utf8');
      return merged;
    }

    try {
      configManager.ensureDirectories();

      let existingList: AdapterDnsBackup[] = [];
      if (fs.existsSync(this.backupFile)) {
        try {
          const raw = fs.readFileSync(this.backupFile, 'utf8');
          const parsed: AdapterDnsBackup[] = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            existingList = parsed.filter(
              (b) =>
                !b.ServerAddresses ||
                b.ServerAddresses.length === 0 ||
                !b.ServerAddresses.every((ip) => ip.includes('127.0.0.1'))
            );
          }
        } catch {
          // If unparseable, fall through to re-create
        }
      }

      const existingMap = new Map<number, AdapterDnsBackup>();
      for (const b of existingList) {
        existingMap.set(b.InterfaceIndex, b);
      }

      // Determine target adapters to query
      const targets =
        targetAdapters && targetAdapters.length > 0 ? targetAdapters : await this.getTargetAdapters();

      if (targets.length === 0) {
        if (existingMap.size > 0) {
          return Array.from(existingMap.values());
        }
        logServiceMessage('WARN', '[NetworkManager] No target adapters found to back up.');
        return [];
      }

      // Check which target adapters are not yet in the existing backup
      const missingTargets = targets.filter((t) => !existingMap.has(t.InterfaceIndex));

      if (missingTargets.length === 0) {
        logServiceMessage(
          'INFO',
          `[NetworkManager] Preserving existing valid DNS backup at ${this.backupFile} (all ${targets.length} target adapter(s) already recorded).`
        );
        return Array.from(existingMap.values());
      }

      logServiceMessage(
        'INFO',
        `[NetworkManager] Found ${missingTargets.length} newly discovered adapter(s) needing backup: [${missingTargets
          .map((t) => `${t.InterfaceAlias} (${t.InterfaceIndex})`)
          .join(', ')}]. Merging with existing backup...`
      );

      const indexes = missingTargets.map((t) => t.InterfaceIndex);
      const script = [
        '$ErrorActionPreference = \'Stop\'',
        `$indexes = @(${indexes.join(',')})`,
        '$configs = Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop |',
        '    Where-Object { $indexes -contains $_.InterfaceIndex }',
        '$result = @(',
        '    foreach ($c in $configs) {',
        '        $idx = $c.InterfaceIndex',
        '        $isDhcp = $true',
        '        try {',
        '            $adapter = Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue',
        '            if ($adapter -and $adapter.InterfaceGuid) {',
        '                $regKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)"',
        '                if (Test-Path $regKey) {',
        '                    $ns = (Get-ItemProperty -Path $regKey -Name "NameServer" -ErrorAction SilentlyContinue).NameServer',
        '                    if (-not [string]::IsNullOrWhiteSpace($ns)) {',
        '                        $isDhcp = $false',
        '                    }',
        '                }',
        '            }',
        '        } catch {}',
        '        [PSCustomObject]@{',
        '            InterfaceIndex = $c.InterfaceIndex',
        '            InterfaceAlias = $c.InterfaceAlias',
        '            ServerAddresses = @($c.ServerAddresses)',
        '            DhcpEnabled = $isDhcp',
        '        }',
        '    }',
        ')',
        'if (@($result).Count -gt 0) {',
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
        for (const item of rawList) {
          const addrs: string[] = Array.isArray(item.ServerAddresses)
            ? item.ServerAddresses
            : item.ServerAddresses
            ? [item.ServerAddresses]
            : [];
          // Never backup 127.0.0.1 or ::1 as original DNS
          const cleanAddrs = addrs.filter((ip) => ip && !ip.includes('127.0.0.1') && !ip.includes('::1'));
          const idx = Number(item.InterfaceIndex);
          const isDhcp = typeof item.DhcpEnabled === 'boolean' ? item.DhcpEnabled : cleanAddrs.length === 0;
          if (!existingMap.has(idx)) {
            existingMap.set(idx, {
              InterfaceIndex: idx,
              InterfaceAlias: item.InterfaceAlias || `Interface ${idx}`,
              ServerAddresses: cleanAddrs,
              DhcpEnabled: isDhcp,
            });
          }
        }
      } else {
        // Fallback for missing adapters that had no static DNS returned: mark as DHCP or use gateway
        for (const mt of missingTargets) {
          if (!existingMap.has(mt.InterfaceIndex)) {
            existingMap.set(mt.InterfaceIndex, {
              InterfaceIndex: mt.InterfaceIndex,
              InterfaceAlias: mt.InterfaceAlias || `Interface ${mt.InterfaceIndex}`,
              ServerAddresses: mt.Gateway ? [mt.Gateway] : [],
              DhcpEnabled: true,
            });
          }
        }
      }

      const mergedList = Array.from(existingMap.values());
      fs.writeFileSync(this.backupFile, JSON.stringify(mergedList, null, 2), 'utf8');
      logServiceMessage(
        'INFO',
        `[NetworkManager] Network adapter DNS backup saved to ${this.backupFile} (${mergedList.length} total adapter(s)): ${JSON.stringify(mergedList)}`
      );
      return mergedList;
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
  public async activateFailSafeDns(dnsPort: number = 53, attempt: number = 1): Promise<FailSafeDnsResult> {
    if (this.isShuttingDown || this.isRestoring) {
      return {
        success: false,
        message: 'Activation aborted: service shutdown/restoration in progress.',
        interfaceIndexes: [],
        reason: 'NO_NETWORK_ROUTE',
      };
    }

    logServiceMessage('INFO', `[NetworkManager] Initiating fail-safe network activation (attempt ${attempt})...`);

    // 1. Identify target internet-facing adapters having an IPv4 default gateway
    const discovery = await this.discoverTargetAdapters();
    const targetAdapters = discovery.adapters;
    if (targetAdapters.length === 0) {
      const reason = discovery.reason;
      const msg =
        reason === 'DISCOVERY_COMMAND_FAILED'
          ? `Adapter discovery command failed: ${discovery.errorMessage || 'PowerShell execution error'}. Network DNS untouched.`
          : 'No active IPv4 internet-facing adapters with default gateway found. Network DNS untouched.';
      logServiceMessage('WARN', `[NetworkManager] [WARN] ${msg}`);
      return {
        success: false,
        message: msg,
        interfaceIndexes: [],
        reason: reason,
        details: discovery.errorMessage,
        discoveryMethod: discovery.method,
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
      logServiceMessage('ERROR', `[NetworkManager] [ERROR] Fail-safe abort: 127.0.0.1:${dnsPort} is NOT answering DNS queries.`);
      logServiceMessage('ERROR', '[NetworkManager] Preserving original network adapter DNS to prevent connectivity loss.');
      return {
        success: false,
        message: errReason,
        interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
        reason: 'DNS_PROXY_HEALTH_CHECK_FAILED',
        discoveryMethod: discovery.method,
      };
    }
    logServiceMessage('INFO', `[NetworkManager] [OK] Verified: 127.0.0.1:${dnsPort} responded to DNS probe.`);

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
          logServiceMessage('INFO', `[NetworkManager] [OK] Adapter ${adapter.InterfaceIndex} verified configured to 127.0.0.1.`);
        }

        // 5. Post-assignment resolver check
        logServiceMessage('INFO', `[NetworkManager] Verifying 127.0.0.1:${dnsPort} resolver still healthy post-assignment...`);
        const postCheck = await this.verifyDnsProxyResponding(dnsPort);
        if (!postCheck) {
          throw new Error(`DNS proxy on 127.0.0.1:${dnsPort} stopped responding after adapter configuration.`);
        }
        logServiceMessage('INFO', '[NetworkManager] [OK] Post-assignment resolver check passed.');

        // 6. Clear DNS cache
        const flushScript = '$ErrorActionPreference = \'SilentlyContinue\'; Clear-DnsClientCache';
        await this.executePowerShell(flushScript);
        logServiceMessage('INFO', '[NetworkManager] Windows DNS client cache flushed.');
      } catch (applyErr: any) {
        logServiceMessage(
          'ERROR',
          `[NetworkManager] [ERROR] DNS configuration or verification failed: ${applyErr.message}. Initiating immediate rollback.`
        );
        try {
          await this.restoreOriginalDns();
          logServiceMessage('INFO', '[NetworkManager] Original DNS restored after activation failure.');
          const reasonCode: ActivationReasonCode = applyErr.message.includes('Read-back verification failed')
            ? 'READBACK_MISMATCH'
            : 'DNS_ASSIGNMENT_FAILED';
          return {
            success: false,
            message: `Activation failed: ${applyErr.message}. Original DNS restored.`,
            interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
            details: applyErr.message,
            reason: reasonCode,
            discoveryMethod: discovery.method,
          };
        } catch (rollbackErr: any) {
          const criticalMsg = `CRITICAL: DNS activation failed (${applyErr.message}) AND rollback failed (${rollbackErr.message}). Network configuration may be in an inconsistent state.`;
          logServiceMessage('ERROR', `[NetworkManager] [ERROR] ${criticalMsg}`);
          return {
            success: false,
            message: criticalMsg,
            interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
            details: `Activation Error: ${applyErr.message}; Rollback Error: ${rollbackErr.message}`,
            reason: 'CRITICAL_ROLLBACK_FAILED',
            discoveryMethod: discovery.method,
          };
        }
      }
    }

    // 7. Install DoT / DoH blocking firewall rules
    await firewallEngine.initialize();
    logServiceMessage('INFO', '[NetworkManager] [OK] Fail-safe DNS and firewall enforcement successfully activated and verified.');

    return {
      success: true,
      message: 'Fail-safe DNS successfully activated and verified.',
      interfaceIndexes: targetAdapters.map((a) => a.InterfaceIndex),
      reason: 'ELIGIBLE_ADAPTER_FOUND',
      discoveryMethod: discovery.method,
    };
  }

  /**
   * Controlled retry of DNS activation when starting before an eligible network route exists.
   * Only retries if reason is NO_NETWORK_ROUTE.
   * Does NOT retry critical failures (DNS assignment permission failure, readback mismatch, rollback failure).
   * Backoff delays default to: [5000, 10000, 15000, 30000, 30000].
   * Responsive to shutdown cancellation.
   */
  public async activateFailSafeDnsWithRetry(options: ActivationRetryOptions = {}): Promise<FailSafeDnsResult> {
    const dnsPort = options.dnsPort || 53;
    const delays = options.retryDelaysMs || [5000, 10000, 15000, 30000, 30000];
    const isCancelled = options.isCancelled || (() => false);

    let result: FailSafeDnsResult;
    if (options.initialResult) {
      result = options.initialResult;
    } else {
      if (options.onAttempt) options.onAttempt(1, delays.length + 1);
      result = await this.activateFailSafeDns(dnsPort, 1);
    }

    if (result.success) {
      if (options.onStatusChange) options.onStatusChange('ACTIVE');
      return result;
    }

    if (options.onStatusChange) options.onStatusChange('DEGRADED', result.message);

    // Only retry if the failure reason is NO_NETWORK_ROUTE
    if (result.reason !== 'NO_NETWORK_ROUTE') {
      logServiceMessage(
        'WARN',
        `[NetworkManager] [WARN] Non-network activation failure (${result.reason || 'UNKNOWN'}). Bounded retry will not run.`
      );
      return result;
    }

    logServiceMessage(
      'INFO',
      `[NetworkManager] Starting network-arrival retry sequence (up to ${delays.length} retry attempts)...`
    );

    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      const nextAttempt = i + 2;

      // Sleep with cancellation checks
      const start = Date.now();
      while (Date.now() - start < delay) {
        if (isCancelled()) {
          logServiceMessage('INFO', '[NetworkManager] Activation retry cancelled by shutdown signal.');
          return result;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      if (isCancelled()) {
        logServiceMessage('INFO', '[NetworkManager] Activation retry cancelled by shutdown signal.');
        return result;
      }

      logServiceMessage(
        'INFO',
        `[NetworkManager] Activation retry attempt ${i + 1} of ${delays.length} (total attempt ${nextAttempt})...`
      );
      if (options.onAttempt) options.onAttempt(nextAttempt, delays.length + 1);

      result = await this.activateFailSafeDns(dnsPort, nextAttempt);

      if (result.success) {
        logServiceMessage('INFO', '[NetworkManager] [OK] Network activation succeeded on retry!');
        if (options.onTransition) {
          options.onTransition('DEGRADED', 'ACTIVE', result);
        }
        if (options.onStatusChange) {
          options.onStatusChange('ACTIVE');
        }
        return result;
      }

      // If failure reason changed to a non-network failure (e.g. DNS apply error), abort retry
      if (result.reason !== 'NO_NETWORK_ROUTE') {
        logServiceMessage(
          'ERROR',
          `[NetworkManager] [ERROR] Retry aborted due to critical non-network error: ${result.reason} - ${result.message}`
        );
        return result;
      }
    }

    logServiceMessage(
      'WARN',
      `[NetworkManager] [WARN] Network activation retry limit reached (${delays.length} retries exhausted). Remaining in DEGRADED state.`
    );
    return result;
  }


  /**
   * Queries current DNS server addresses for a list of known active adapters.
   *
   * PROVEN ROOT CAUSE:
   * On Windows PowerShell 5.1 the DNS filter correctly returned one adapter.
   * However, assigning a single PSCustomObject from foreach to $result produced
   * a scalar object whose .Count property was empty. The subsequent
   * if ($result.Count -gt 0) branch therefore evaluated false and serialized []
   * despite a valid DNS record being present.
   * Physical testing on Windows 10/11 confirmed that @($result).Count == 1,
   * and that ServerAddresses serialized as a scalar string for a single DNS address.
   *
   * Fix:
   * 1. Query each known adapter directly by InterfaceIndex.
   * 2. Wrap collection assignment as $results = @(foreach (...) { ... }) and check
   *    @($results).Count -gt 0 to guarantee scalar PSCustomObject results never collapse .Count.
   * 3. Normalize single-string ServerAddresses ("127.0.0.1") to string array (["127.0.0.1"]).
   *
   * For mock/non-Windows paths the caller supplies adapter state directly.
   *
   * @param targetAdapters  Eligible adapters from discoverTargetAdapters()
   * @returns Per-adapter DNS state with queryStatus distinguishing empty-result from query-failure
   */
  public async queryDnsStateForAdapters(
    targetAdapters: TargetAdapterInfo[]
  ): Promise<AdapterDnsQueryResult[]> {
    if (this.getPlatform() !== 'win32') {
      // Non-Windows / test simulation: derive state from mockAdapters
      return targetAdapters.map((target) => {
        const ma = this.mockAdapters
          ? this.mockAdapters.find((a) => a.InterfaceIndex === target.InterfaceIndex)
          : null;
        const addrs: string[] = ma ? ma.ServerAddresses : ['127.0.0.1'];
        const isEnforced = addrs.includes('127.0.0.1');
        const cleanNonLoopback = addrs.filter((ip) => !ip.startsWith('127.') && ip !== '::1');
        const isDhcp = ma ? ma.DhcpEnabled !== false : true;
        return {
          InterfaceIndex: target.InterfaceIndex,
          InterfaceAlias: target.InterfaceAlias,
          ServerAddresses: addrs,
          CleanNonLoopback: cleanNonLoopback,
          IsEnforced: isEnforced,
          DhcpEnabled: isDhcp,
          queryStatus: 'OK',
        };
      });
    }

    // Windows path: query each adapter individually with an explicit [int] cast on the index.
    // Wrap foreach in @(...) and check @($results).Count to ensure scalar results never collapse .Count.
    const script = [
      '$ErrorActionPreference = \'SilentlyContinue\'',
      '$results = @(',
      '    foreach ($rawIdx in @(' + targetAdapters.map((a) => `[int]${a.InterfaceIndex}`).join(',') + ')) {',
      '        $idx = [int]$rawIdx',
      '        $rows = @(Get-DnsClientServerAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue)',
      '        if ($rows.Count -gt 0) {',
      '            $d = $rows[0]',
      '            $addrs = if ($d.ServerAddresses) { @($d.ServerAddresses | ForEach-Object { [string]$_ }) } else { @() }',
      '            $has127 = ($addrs -contains \'127.0.0.1\')',
      '            $cleanAddrs = @($addrs | Where-Object { $_ -and $_ -notmatch \'^127\\.\' -and $_ -ne \'::1\' })',
      '            $alias = if ($d.InterfaceAlias) { [string]$d.InterfaceAlias } else { "Interface $idx" }',
      '            # Detect static vs DHCP via registry (NameServer key set = static override)',
      '            $isDhcp = $true',
      '            try {',
      '                $adapter = @(Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue)[0]',
      '                if ($adapter -and $adapter.InterfaceGuid) {',
      '                    $regKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)"',
      '                    if (Test-Path $regKey) {',
      '                        $props = Get-ItemProperty -Path $regKey -ErrorAction SilentlyContinue',
      '                        $ns = if ($props.NameServer) { [string]$props.NameServer } else { \'\' }',
      '                        if (-not [string]::IsNullOrWhiteSpace($ns) -and $ns -notmatch \'127\\.0\\.0\\.1\') {',
      '                            $isDhcp = $false',
      '                        }',
      '                    }',
      '                }',
      '            } catch {}',
      '            [PSCustomObject]@{',
      '                InterfaceIndex   = $idx',
      '                InterfaceAlias   = $alias',
      '                ServerAddresses  = $addrs',
      '                CleanNonLoopback = $cleanAddrs',
      '                IsEnforced       = $has127',
      '                DhcpEnabled      = $isDhcp',
      '                QueryStatus      = \'OK\'',
      '            }',
      '        } else {',
      '            # No row returned for this specific index: record explicit QUERY_FAILED',
      '            [PSCustomObject]@{',
      '                InterfaceIndex   = $idx',
      '                InterfaceAlias   = "Interface $idx"',
      '                ServerAddresses  = @()',
      '                CleanNonLoopback = @()',
      '                IsEnforced       = $false',
      '                DhcpEnabled      = $true',
      '                QueryStatus      = \'QUERY_FAILED\'',
      '            }',
      '        }',
      '    }',
      ')',
      'if (@($results).Count -gt 0) { $results | ConvertTo-Json -Compress } else { \'[]\' }',
    ].join('\n');

    const { stdout } = await this.executePowerShell(script);
    const trimmed = stdout.trim();

    const results: AdapterDnsQueryResult[] = [];

    if (trimmed && trimmed !== '[]' && trimmed !== 'null') {
      const parsed = JSON.parse(trimmed);
      const rawList: any[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of rawList) {
        const rawAddrs = item.ServerAddresses;
        const addrs: string[] = Array.isArray(rawAddrs)
          ? rawAddrs.map(String)
          : rawAddrs
          ? [String(rawAddrs)]
          : [];
        const rawClean = item.CleanNonLoopback;
        const clean: string[] = Array.isArray(rawClean)
          ? rawClean.map(String)
          : rawClean
          ? [String(rawClean)]
          : [];
        results.push({
          InterfaceIndex: Number(item.InterfaceIndex),
          InterfaceAlias: String(item.InterfaceAlias || `Interface ${item.InterfaceIndex}`),
          ServerAddresses: addrs,
          CleanNonLoopback: clean,
          IsEnforced: Boolean(item.IsEnforced),
          DhcpEnabled: item.DhcpEnabled !== false,
          queryStatus: item.QueryStatus === 'QUERY_FAILED' ? 'QUERY_FAILED' : 'OK',
        });
      }
    }

    // Fill in QUERY_FAILED for any adapter not present in the JSON output at all
    for (const target of targetAdapters) {
      if (!results.some((r) => r.InterfaceIndex === target.InterfaceIndex)) {
        results.push({
          InterfaceIndex: target.InterfaceIndex,
          InterfaceAlias: target.InterfaceAlias,
          ServerAddresses: [],
          CleanNonLoopback: target.Gateway ? [target.Gateway] : [],
          IsEnforced: false,
          DhcpEnabled: true,
          queryStatus: 'QUERY_FAILED',
        });
      }
    }

    return results;
  }

  /**
   * Reconciles current network adapter DNS enforcement against the active routing topology.
   * Discovers eligible default-route adapters, safely refreshes original DNS metadata upon roaming,
   * re-enforces 127.0.0.1 on any adapter whose DNS has changed away, and ensures firewall rules exist.
   * Single-flight, non-overlapping, and cancellation-aware.
   */
  public async reconcileAdapters(dnsPort: number = 53): Promise<ReconcileResult> {
    if (this.isShuttingDown || this.isRestoring) {
      return {
        status: 'NO_NETWORK_ROUTE',
        enforcedIndexes: [],
        unenforcedIndexes: [],
        message: 'Reconciliation aborted: service shutdown/restoration in progress',
      };
    }

    if (this.isReconciling) {
      return {
        status: 'IN_SYNC',
        enforcedIndexes: [],
        unenforcedIndexes: [],
        message: 'Reconciliation tick skipped: previous cycle still active',
      };
    }

    this.isReconciling = true;
    try {
      if (this.isShuttingDown || this.isRestoring) {
        return {
          status: 'NO_NETWORK_ROUTE',
          enforcedIndexes: [],
          unenforcedIndexes: [],
          message: 'Service is stopping/restoring',
        };
      }

      // 1. Discover current eligible internet-facing adapters (suppress routine logs on periodic ticks)
      const discovery = await this.discoverTargetAdapters(true);
      const targetAdapters = discovery.adapters;

      if (targetAdapters.length === 0) {
        return {
          status: 'NO_NETWORK_ROUTE',
          enforcedIndexes: [],
          unenforcedIndexes: [],
          message:
            discovery.reason === 'DISCOVERY_COMMAND_FAILED'
              ? `Adapter discovery failed: ${discovery.errorMessage || 'command error'}`
              : 'No active IPv4 internet-facing adapters with default gateway found.',
        };
      }

      // 2. Query current DNS configuration on all target adapters using the shared helper.
      // The helper queries each adapter directly by InterfaceIndex, eliminating the fragile
      // global enumeration + Where-Object filter that returned no matching records in Windows/PS 5.1.
      const dnsStates = await this.queryDnsStateForAdapters(targetAdapters);

      // Partition results into enforced, unenforced, and query-failed categories.
      // QUERY_FAILED adapters must NOT be treated as unenforced to avoid blind DNS rewrites.
      const enforced = dnsStates.filter((s) => s.IsEnforced && s.queryStatus === 'OK');
      const unenforced = dnsStates.filter((s) => !s.IsEnforced && s.queryStatus === 'OK');
      const queryFailed = dnsStates.filter((s) => s.queryStatus === 'QUERY_FAILED');

      if (queryFailed.length > 0) {
        logServiceMessage(
          'WARN',
          `[NetworkManager] [WARN] DNS state query returned no data for ${queryFailed.length} adapter(s): [${queryFailed
            .map((q) => `${q.InterfaceAlias} (${q.InterfaceIndex})`)
            .join(', ')}]. Preserving current state; will retry on next tick.`
        );
      }

      // If any active adapter failed DNS inspection and no other adapters require re-enforcement,
      // we CANNOT report IN_SYNC because overall protection cannot be verified. Return ERROR.
      if (queryFailed.length > 0 && unenforced.length === 0) {
        return {
          status: 'ERROR',
          enforcedIndexes: enforced.map((e) => e.InterfaceIndex),
          unenforcedIndexes: queryFailed.map((q) => q.InterfaceIndex),
          message: `DNS state query failed for active adapter(s): [${queryFailed
            .map((q) => `${q.InterfaceAlias} (${q.InterfaceIndex})`)
            .join(', ')}]. Overall enforcement cannot be verified.`,
        };
      }

      // If all active eligible adapters already have 127.0.0.1 enforced and NONE failed query:
      if (unenforced.length === 0 && queryFailed.length === 0) {
        return {
          status: 'IN_SYNC',
          enforcedIndexes: enforced.map((e) => e.InterfaceIndex),
          unenforcedIndexes: [],
          message: `All ${enforced.length} active adapter(s) currently enforced with 127.0.0.1.`,
        };
      }

      if (this.isShuttingDown || this.isRestoring) {
        return {
          status: 'NO_NETWORK_ROUTE',
          enforcedIndexes: [],
          unenforcedIndexes: unenforced.map((u) => u.InterfaceIndex),
          message: 'Shutdown initiated before re-enforcement',
        };
      }

      logServiceMessage(
        'INFO',
        `[NetworkManager] Network change detected: ${unenforced.length} active adapter(s) require DNS enforcement: [${unenforced
          .map((u) => `${u.InterfaceAlias} (${u.InterfaceIndex})`)
          .join(', ')}]`
      );

      // 3. Step A: Safely refresh/persist backup with genuine non-loopback DNS before applying 127.0.0.1
      for (const u of unenforced) {
        this.persistOrRefreshAdapterBackup({
          InterfaceIndex: u.InterfaceIndex,
          InterfaceAlias: u.InterfaceAlias,
          ServerAddresses: u.CleanNonLoopback,
          DhcpEnabled: u.DhcpEnabled,
        });
      }

      // 4. Step B: Verify local DNS proxy is responding before re-enforcing
      const proxyResponding = await this.verifyDnsProxyResponding(dnsPort);
      if (!proxyResponding) {
        logServiceMessage(
          'ERROR',
          `[NetworkManager] [ERROR] Cannot re-enforce DNS during roaming: DNS proxy on 127.0.0.1:${dnsPort} failed health probe.`
        );
        return {
          status: 'ERROR',
          enforcedIndexes: enforced.map((e) => e.InterfaceIndex),
          unenforcedIndexes: unenforced.map((u) => u.InterfaceIndex),
          message: 'Local DNS proxy health check failed during reconciliation',
        };
      }

      if (this.isShuttingDown || this.isRestoring) {
        return {
          status: 'NO_NETWORK_ROUTE',
          enforcedIndexes: [],
          unenforcedIndexes: unenforced.map((u) => u.InterfaceIndex),
          message: 'Shutdown initiated before DNS assignment',
        };
      }

      // 5. Step C: Apply 127.0.0.1 to unenforced adapters
      if (this.getPlatform() === 'win32') {
        for (const u of unenforced) {
          logServiceMessage(
            'INFO',
            `[NetworkManager] Re-assigning 127.0.0.1 DNS to adapter ${u.InterfaceAlias} (Index ${u.InterfaceIndex})...`
          );
          const setScript = [
            '$ErrorActionPreference = \'Stop\'',
            `Set-DnsClientServerAddress -InterfaceIndex ${u.InterfaceIndex} -ServerAddresses ('127.0.0.1') -ErrorAction Stop`,
          ].join('\n');
          await this.executePowerShell(setScript);

          // Read-back verify
          const readBackScript = [
            '$ErrorActionPreference = \'Stop\'',
            `$addr = Get-DnsClientServerAddress -InterfaceIndex ${u.InterfaceIndex} -AddressFamily IPv4 -ErrorAction Stop`,
            '$addr | Select-Object InterfaceIndex, ServerAddresses | ConvertTo-Json -Compress',
          ].join('\n');
          const { stdout } = await this.executePowerShell(readBackScript);
          const trimmed = stdout.trim();
          if (trimmed) {
            const parsed = JSON.parse(trimmed);
            const rawAddrs = parsed.ServerAddresses;
            const servers: string[] = Array.isArray(rawAddrs) ? rawAddrs : rawAddrs ? [rawAddrs] : [];
            if (!servers.includes('127.0.0.1')) {
              throw new Error(
                `Reconciliation read-back failed for adapter ${u.InterfaceIndex}: expected [127.0.0.1], got [${servers.join(', ')}]`
              );
            }
          }
        }

        // Flush DNS client cache
        const flushScript = '$ErrorActionPreference = \'SilentlyContinue\'; Clear-DnsClientCache';
        await this.executePowerShell(flushScript);
      } else {
        // Non-Windows simulation: update mock adapter state
        if (this.mockAdapters) {
          for (const u of unenforced) {
            const ma = this.mockAdapters.find((a) => a.InterfaceIndex === u.InterfaceIndex);
            if (ma) {
              ma.ServerAddresses = ['127.0.0.1'];
            }
          }
        }
      }

      // 6. Ensure firewall rules are intact (idempotent: avoid expensive netsh recreation if already running)
      if (!firewallEngine.getStatus().isRunning) {
        await firewallEngine.initialize();
      }

      const allEnforcedIndexes = [
        ...enforced.map((e) => e.InterfaceIndex),
        ...unenforced.map((u) => u.InterfaceIndex),
      ];
      logServiceMessage(
        'INFO',
        `[NetworkManager] [OK] Reconciled and enforced ${unenforced.length} adapter(s) [${unenforced
          .map((u) => u.InterfaceIndex)
          .join(', ')}] with 127.0.0.1.`
      );

      // If any active adapter failed DNS query, overall protection cannot be verified
      // even if known unenforced adapters were re-enforced. Return ERROR so the system remains unverified.
      if (queryFailed.length > 0) {
        return {
          status: 'ERROR',
          enforcedIndexes: allEnforcedIndexes,
          unenforcedIndexes: queryFailed.map((q) => q.InterfaceIndex),
          message: `Re-enforced ${unenforced.length} adapter(s), but DNS state query failed for adapter(s): [${queryFailed
            .map((q) => `${q.InterfaceAlias} (${q.InterfaceIndex})`)
            .join(', ')}]. Overall enforcement cannot be verified.`,
        };
      }

      return {
        status: 'RE_ENFORCED',
        enforcedIndexes: allEnforcedIndexes,
        unenforcedIndexes: [],
        message: 'Successfully re-enforced DNS on active network change',
      };
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Starts periodic reconciliation loop to detect network roaming, adapter arrival, or DNS tampering.
   */
  public startReconciliationLoop(
    dnsPort: number = 53,
    intervalMs: number = 3000,
    onStateChange?: (success: boolean, reason?: string) => void
  ): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    this.reconcileTimer = setInterval(async () => {
      if (this.isShuttingDown || this.isRestoring) return;
      try {
        const result = await this.reconcileAdapters(dnsPort);
        if (this.isShuttingDown || this.isRestoring) return;

        if (result.status === 'IN_SYNC' || result.status === 'RE_ENFORCED') {
          if (onStateChange) onStateChange(true, undefined);
        } else if (result.status === 'NO_NETWORK_ROUTE') {
          if (onStateChange) onStateChange(false, 'NO_NETWORK_ROUTE');
        } else {
          if (onStateChange) onStateChange(false, 'DNS_NOT_ENFORCED');
        }
      } catch (err: any) {
        if (!this.isShuttingDown && !this.isRestoring) {
          logServiceMessage('WARN', `[NetworkManager] Reconciliation loop error: ${err.message}`);
        }
      }
    }, intervalMs);

    if (this.reconcileTimer && typeof (this.reconcileTimer as any).unref === 'function') {
      (this.reconcileTimer as any).unref();
    }
  }

  /**
   * Stops the active reconciliation loop cleanly.
   */
  public stopReconciliationLoop(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * Returns current reconciliation timer for testing.
   */
  public getReconcileTimerForTesting(): NodeJS.Timeout | null {
    return this.reconcileTimer;
  }

  /**
   * Inspects current network enforcement status against active default-route adapters.
   * Accurately distinguishes between genuinely protected systems vs systems with disconnected
   * adapters or un-enforced active default routes.
   */
  public async inspectCurrentEnforcement(): Promise<CurrentEnforcementInspection> {
    const discovery = await this.discoverTargetAdapters(true);
    const targetAdapters = discovery.adapters;

    if (targetAdapters.length === 0) {
      return {
        isProtected: false,
        activeAdapters: [],
        summary: 'No active internet-facing network adapter found',
      };
    }

    const activeAdapters: Array<{
      interfaceIndex: number;
      interfaceAlias: string;
      gateway?: string;
      dnsServers: string[];
      isEnforced: boolean;
      queryStatus?: 'OK' | 'QUERY_FAILED';
    }> = [];

    // Query current DNS state for all eligible adapters using the shared helper.
    // The helper queries each adapter directly by InterfaceIndex.
    const dnsStates = await this.queryDnsStateForAdapters(targetAdapters);

    for (const state of dnsStates) {
      const target = targetAdapters.find((t) => t.InterfaceIndex === state.InterfaceIndex);
      // For QUERY_FAILED adapters: keep dnsServers as [] (real addresses only).
      // queryStatus cleanly conveys the query state without putting diagnostic text into dnsServers.
      activeAdapters.push({
        interfaceIndex: state.InterfaceIndex,
        interfaceAlias: state.InterfaceAlias,
        gateway: target?.Gateway,
        dnsServers: state.queryStatus === 'QUERY_FAILED' ? [] : state.ServerAddresses,
        isEnforced: state.IsEnforced && state.queryStatus === 'OK',
        queryStatus: state.queryStatus,
      });
    }

    const isProtected = activeAdapters.length > 0 && activeAdapters.every((a) => a.isEnforced);
    const summary = isProtected
      ? 'Protected'
      : activeAdapters.length === 0
      ? 'No active network'
      : 'DNS not redirected';

    return {
      isProtected,
      activeAdapters,
      summary,
    };
  }

  /**
   * Cleanly restores original adapter DNS configuration from backup.
   * Restores static IP addresses or resets to DHCP based on original state.
   * Throws on failure to ensure uninstallers and CLI tools detect restoration errors.
   */
  public async restoreOriginalDns(): Promise<void> {
    logServiceMessage('INFO', '[NetworkManager] Restoring network adapters to original DNS settings...');
    this.isRestoring = true;
    this.stopReconciliationLoop();

    if (this.getPlatform() !== 'win32') {
      logServiceMessage('INFO', '[NetworkManager] Non-Windows platform: simulation complete.');
      this.isRestoring = false;
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
          // Never restore 127.0.0.1 or ::1 as original DNS
          const cleanAddrs = (item.ServerAddresses || []).filter(
            (ip) => ip && !ip.includes('127.0.0.1') && !ip.includes('::1')
          );
          if (item.DhcpEnabled) {
            // Original adapter was configured for DHCP (automatic DNS) -> reset to DHCP
            const script = [
              '$ErrorActionPreference = \'Stop\'',
              `Set-DnsClientServerAddress -InterfaceIndex ${item.InterfaceIndex} -ResetServerAddresses -ErrorAction Stop`,
            ].join('\n');
            await this.executePowerShell(script);
            logServiceMessage('INFO', `[NetworkManager] Reset adapter ${item.InterfaceIndex} to DHCP.`);
          } else if (cleanAddrs.length > 0) {
            // Restore original static DNS addresses
            const formattedAddresses = cleanAddrs.map((ip) => `'${ip}'`).join(',');
            const script = [
              '$ErrorActionPreference = \'Stop\'',
              `Set-DnsClientServerAddress -InterfaceIndex ${item.InterfaceIndex} -ServerAddresses @(${formattedAddresses}) -ErrorAction Stop`,
            ].join('\n');
            await this.executePowerShell(script);
            logServiceMessage(
              'INFO',
              `[NetworkManager] Restored static DNS for adapter ${item.InterfaceIndex} to [${cleanAddrs.join(', ')}].`
            );
          } else {
            // Fallback to DHCP if no static addresses are available
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
        // reset ONLY adapters that are currently set to 127.0.0.1 AND have an active default gateway to DHCP
        // Never touch Tailscale or tunnels!
        logServiceMessage(
          'INFO',
          '[NetworkManager] No backup records found; falling back to resetting internet-facing adapters currently configured to 127.0.0.1 to DHCP...'
        );
        const script = [
          '$ErrorActionPreference = \'SilentlyContinue\'',
          '$trapped = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses -contains \'127.0.0.1\' })',
          '$routes = @(Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne \'0.0.0.0\' })',
          'if ($routes.Count -gt 0) {',
          '    $routeIndexes = @($routes | ForEach-Object { $_.InterfaceIndex })',
          '    foreach ($t in $trapped) {',
          '        if ($routeIndexes -contains $t.InterfaceIndex) {',
          '            Set-DnsClientServerAddress -InterfaceIndex $t.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue',
          '        }',
          '    }',
          '} else {',
          '    $configs = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq \'Up\' -and $_.IPv4DefaultGateway -ne $null })',
          '    $configIndexes = @($configs | ForEach-Object { [int]$_.InterfaceIndex })',
          '    foreach ($t in $trapped) {',
          '        if ($configIndexes -contains $t.InterfaceIndex) {',
          '            Set-DnsClientServerAddress -InterfaceIndex $t.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue',
          '        }',
          '    }',
          '}',
        ].join('\n');
        await this.executePowerShell(script);
        logServiceMessage('INFO', '[NetworkManager] Trapped internet-facing adapters reset to DHCP.');
      }

      // Flush DNS client cache
      const flushScript = '$ErrorActionPreference = \'SilentlyContinue\'; Clear-DnsClientCache';
      await this.executePowerShell(flushScript);

      logServiceMessage('INFO', '[NetworkManager] [OK] Original DNS configuration cleanly restored and DNS cache flushed.');
    } catch (e: any) {
      logServiceMessage('ERROR', `[NetworkManager] Error during DNS restoration: ${e.message}`);
      throw e;
    } finally {
      this.isRestoring = false;
    }
  }
}

export const networkManager = new WindowsNetworkManager();
