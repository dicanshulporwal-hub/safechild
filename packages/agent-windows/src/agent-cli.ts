import { PolicySyncClient } from './sync-client';
import { BlockPageServer } from './block-server';
import { DnsFilterProxy } from './dns-proxy';
import { WindowsProcessLimiter } from './process-limiter';
import { configManager, DeviceConfig, ConfigManager } from './config-manager';
import { networkManager, logServiceMessage } from './network-manager';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function pairDevice(args: string[]): Promise<void> {
  const pairIdx = args.indexOf('--pair') !== -1 ? args.indexOf('--pair') : args.indexOf('--pairing-code');
  const code = args[pairIdx + 1];
  if (!code || code.startsWith('-')) {
    console.error('[SafeBrowse] FAILURE: Pairing code must be provided. E.g.: --pair SB-123456');
    process.exit(1);
  }

  const nameIdx = args.indexOf('--name');
  const name = nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1] : "Rahul's Windows Laptop";

  const urlIdx = args.indexOf('--backend-url');
  const rawUrl = urlIdx !== -1 && args[urlIdx + 1]
    ? args[urlIdx + 1]
    : process.env.SAFEBROWSE_URL || ConfigManager.DEFAULT_PILOT_URL;

  let backendUrl: string;
  try {
    backendUrl = configManager.validateBackendUrl(rawUrl);
  } catch (err: any) {
    console.error(`[SafeBrowse] FAILURE: Invalid backend URL: ${err.message}`);
    process.exit(1);
  }

  console.log('==================================================');
  console.log('[Pairing] SafeBrowse Windows Device Pairing');
  console.log('==================================================');
  console.log(`[Pairing] Claiming device with code: ${code}`);
  console.log(`[Pairing] Target Backend: ${backendUrl}`);
  console.log(`[Pairing] Device Name: ${name}`);

  try {
    const res = await fetch(`${backendUrl}/api/devices/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceName: name,
        platform: 'windows',
        agentVersion: '1.0.0',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status} ${res.statusText}` }));
      console.error(`[SafeBrowse] FAILURE: Pairing failed: ${err.error || 'Server rejected pairing code'}`);
      process.exit(1);
    }

    const data: any = await res.json();
    if (!data.device || !data.device.id || !data.device.deviceToken) {
      console.error('[SafeBrowse] FAILURE: Incomplete device credentials received from server.');
      process.exit(1);
    }

    const config: DeviceConfig = {
      deviceId: data.device.id,
      deviceToken: data.device.deviceToken,
      childId: data.device.childId,
      parentId: data.device.parentId,
      deviceName: data.device.name || name,
      backendUrl,
      pairedAt: new Date().toISOString(),
    };

    await configManager.saveDeviceConfig(config);

    console.log('--------------------------------------------------');
    console.log('[SafeBrowse] SUCCESS: Device successfully paired!');
    console.log(`  Device ID:    ${config.deviceId}`);
    console.log(`  Child ID:     ${config.childId}`);
    console.log(`  Backend URL:  ${config.backendUrl}`);
    console.log(`  Config File:  ${configManager.getConfigFilePath()}`);
    console.log('--------------------------------------------------');

    // If installed as a Windows service, attempt to start/restart service
    if (process.platform === 'win32') {
      try {
        console.log('[SafeBrowse] Signaling SafeBrowseChildService to start...');
        await execAsync('sc.exe start SafeBrowseChildService');
        console.log('[SafeBrowse] Service start command dispatched successfully.');
      } catch (e: any) {
        console.log(`[SafeBrowse] Note: Service start command notification: ${e.message}`);
      }
    }

    process.exit(0);
  } catch (err: any) {
    console.error(`[SafeBrowse] FAILURE: Network error during pairing: ${err.message}`);
    process.exit(1);
  }
}

export type EngineOperationalStatus =
  | 'BOOT_RECOVERY'
  | 'WAITING_FOR_NETWORK'
  | 'DNS_PROXY_STARTING'
  | 'DNS_PROXY_HEALTHY'
  | 'ENFORCING'
  | 'ACTIVE'
  | 'DEGRADED_NO_NETWORK'
  | 'DEGRADED_POLICY_UNAVAILABLE'
  | 'DEGRADED_DNS_NOT_ENFORCED'
  | 'DEGRADED_RESOLVER_UNHEALTHY'
  | 'OFFLINE_BACKEND_CACHED_POLICY'
  | 'STOPPING'
  | 'RESTORING_NETWORK';

export function computeEngineStatus(
  netSuccess: boolean,
  netReason: string | undefined,
  policyStatus: 'POLICY_LIVE' | 'POLICY_CACHED' | 'POLICY_UNAVAILABLE'
): EngineOperationalStatus {
  if (!netSuccess) {
    if (netReason === 'NO_NETWORK_ROUTE') {
      return 'DEGRADED_NO_NETWORK';
    }
    if (netReason === 'DNS_PROXY_HEALTH_CHECK_FAILED' || netReason === 'RESOLVER_UNHEALTHY') {
      return 'DEGRADED_RESOLVER_UNHEALTHY';
    }
    return 'DEGRADED_DNS_NOT_ENFORCED';
  }
  if (policyStatus === 'POLICY_UNAVAILABLE') {
    return 'DEGRADED_POLICY_UNAVAILABLE';
  }
  if (policyStatus === 'POLICY_CACHED') {
    return 'OFFLINE_BACKEND_CACHED_POLICY';
  }
  return 'ACTIVE';
}

export function isEnforcementActive(
  engineStatus: EngineOperationalStatus,
  hasUsablePolicy: boolean
): boolean {
  if (
    engineStatus === 'STOPPING' ||
    engineStatus === 'RESTORING_NETWORK' ||
    engineStatus === 'BOOT_RECOVERY' ||
    engineStatus === 'WAITING_FOR_NETWORK' ||
    engineStatus === 'DNS_PROXY_STARTING' ||
    engineStatus === 'DNS_PROXY_HEALTHY' ||
    engineStatus === 'ENFORCING' ||
    engineStatus === 'DEGRADED_NO_NETWORK' ||
    engineStatus === 'DEGRADED_DNS_NOT_ENFORCED' ||
    engineStatus === 'DEGRADED_RESOLVER_UNHEALTHY' ||
    engineStatus === 'DEGRADED_POLICY_UNAVAILABLE'
  ) {
    return false;
  }
  if (!hasUsablePolicy) {
    return false;
  }
  return engineStatus === 'ACTIVE' || engineStatus === 'OFFLINE_BACKEND_CACHED_POLICY';
}

async function runServiceMode(): Promise<void> {
  logServiceMessage('INFO', '==================================================');
  logServiceMessage('INFO', '[SafeBrowse Service] SafeBrowse Windows Enforcement Service');
  logServiceMessage('INFO', '==================================================');

  // Graceful shutdown handling
  let isShuttingDown = false;
  let currentEngineStatus: EngineOperationalStatus = 'DEGRADED_DNS_NOT_ENFORCED';
  let lastNetSuccess = false;
  let lastNetReason: string | undefined = 'DNS_NOT_ENFORCED';
  let syncClient: PolicySyncClient | null = null;
  let blockServer: BlockPageServer | null = null;
  let dnsProxy: DnsFilterProxy | null = null;
  let processLimiter: WindowsProcessLimiter | null = null;

  const recomputeAndApplyEngineStatus = (reason: string): EngineOperationalStatus => {
    if (isShuttingDown) return currentEngineStatus;
    const currentPolStatus = syncClient ? syncClient.getPolicyStatus() : 'POLICY_UNAVAILABLE';
    const newStatus = computeEngineStatus(lastNetSuccess, lastNetReason, currentPolStatus);

    if (newStatus !== currentEngineStatus) {
      const oldStatus = currentEngineStatus;
      currentEngineStatus = newStatus;
      logServiceMessage('INFO', '--------------------------------------------------');
      logServiceMessage(
        'INFO',
        `[SafeBrowse Service] [OK] Transition: ${oldStatus} -> ${newStatus} (${reason})`
      );
      logServiceMessage('INFO', `[SafeBrowse Service] [OK] SafeBrowse Protection Engine is ${newStatus}`);
      logServiceMessage('INFO', '--------------------------------------------------');
    }
    return currentEngineStatus;
  };

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    networkManager.setShuttingDown(true);
    networkManager.stopReconciliationLoop();
    currentEngineStatus = 'STOPPING';
    logServiceMessage('INFO', `\n[SafeBrowse Service] Received ${signal}. Initiating graceful service shutdown...`);

    currentEngineStatus = 'RESTORING_NETWORK';
    try {
      await networkManager.restoreOriginalDns();
    } catch (e: any) {
      logServiceMessage('WARN', `[SafeBrowse Service] Warning during DNS restore: ${e.message}`);
    }

    try {
      if (processLimiter) processLimiter.stop();
      if (dnsProxy) dnsProxy.stop();
      if (blockServer) blockServer.stop();
      if (syncClient) syncClient.stop();
    } catch (e: any) {
      logServiceMessage('WARN', `[SafeBrowse Service] Warning during component teardown: ${e.message}`);
    }

    logServiceMessage('INFO', '[SafeBrowse Service] Service stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  if (process.platform === 'win32') {
    process.on('message', (msg) => {
      if (msg === 'shutdown') gracefulShutdown('shutdown');
    });
  }

  // 0. Perform boot safety recovery for any stale 127.0.0.1 DNS before normal enforcement
  currentEngineStatus = 'BOOT_RECOVERY';
  const bootRecovery = await networkManager.recoverStaleDnsAtBoot(53);
  if (bootRecovery.recovered) {
    logServiceMessage('INFO', `[SafeBrowse Service] [OK] Boot safety recovery: ${bootRecovery.message}`);
  }

  // Await valid pairing credentials if not yet paired
  let config = await configManager.loadDeviceConfig();
  while (!config) {
    if (isShuttingDown) return;
    logServiceMessage(
      'INFO',
      '[SafeBrowse Service] Awaiting device pairing. Please run: SafeBrowseChild-Pilot.exe --pair <CODE>'
    );
    await new Promise((r) => setTimeout(r, 5000));
    config = await configManager.loadDeviceConfig();
  }

  logServiceMessage(
    'INFO',
    `[SafeBrowse Service] Active configuration loaded for device: ${config.deviceName} (${config.deviceId})`
  );
  logServiceMessage('INFO', `[SafeBrowse Service] Backend: ${config.backendUrl}`);

  // 1. Initialize Sync Client
  syncClient = new PolicySyncClient(
    config,
    configManager.getCacheDir(),
    () => isEnforcementActive(currentEngineStatus, syncClient?.getActivePolicy() !== null)
  );

  syncClient.setOnPolicyStatusChange((newStatus, prevStatus) => {
    recomputeAndApplyEngineStatus(`Policy status changed: ${prevStatus} -> ${newStatus}`);
  });

  // Await bounded initial policy synchronization (max 5s) before computing initial engine status
  await syncClient.start(5000);

  // 2. Initialize Block Page Server
  blockServer = new BlockPageServer(config.backendUrl, config.childId, config.deviceId);
  await blockServer.start(8880);

  // 3. Initialize DNS Filter Proxy on port 53 with physical network's upstream DNS
  currentEngineStatus = 'DNS_PROXY_STARTING';
  const initialUpstreams = await networkManager.getUpstreamDnsServers();
  dnsProxy = new DnsFilterProxy(() => syncClient!.getActivePolicy(), initialUpstreams[0] || '1.1.1.1', 53);
  dnsProxy.setUpstreams(initialUpstreams);
  let activeDnsPort = 53;
  try {
    activeDnsPort = await dnsProxy.start(53);
    logServiceMessage('INFO', `[SafeBrowse Service] DNS Proxy listening on UDP 127.0.0.1:${activeDnsPort} (Upstreams: ${initialUpstreams.join(', ')})`);
  } catch (err: any) {
    logServiceMessage('WARN', `[SafeBrowse Service] Port 53 bind notice (${err.message}). Starting on fallback port 5353.`);
    activeDnsPort = await dnsProxy.start(5353);
  }

  currentEngineStatus = 'DNS_PROXY_HEALTHY';

  // 4. Fail-Safe Network DNS Activation (Initial Attempt)
  currentEngineStatus = 'ENFORCING';
  const netActivation = await networkManager.activateFailSafeDns(activeDnsPort, 1);
  lastNetSuccess = netActivation.success;
  lastNetReason = netActivation.reason;
  currentEngineStatus = computeEngineStatus(lastNetSuccess, lastNetReason, syncClient.getPolicyStatus());

  if (netActivation.success) {
    const ifaceStr =
      netActivation.interfaceIndexes && netActivation.interfaceIndexes.length > 0
        ? ` (Adapters: ${netActivation.interfaceIndexes.join(', ')})`
        : '';
    logServiceMessage(
      'INFO',
      `[SafeBrowse Service] [OK] Network adapter DNS successfully bound to SafeBrowse local resolver${ifaceStr}.`
    );
  } else {
    logServiceMessage(
      'WARN',
      `[SafeBrowse Service] [${currentEngineStatus}] Warning: Fail-safe DNS activation deferred: ${netActivation.message}`
    );
  }

  // 5. Initialize Windows Application Process Limiter
  processLimiter = new WindowsProcessLimiter(config, () => syncClient!.getActivePolicy());
  processLimiter.start();

  logServiceMessage('INFO', '--------------------------------------------------');
  if (currentEngineStatus === 'ACTIVE') {
    logServiceMessage('INFO', '[SafeBrowse Service] [OK] SafeBrowse Protection Engine is ACTIVE');
  } else if (currentEngineStatus === 'OFFLINE_BACKEND_CACHED_POLICY') {
    logServiceMessage(
      'INFO',
      `[SafeBrowse Service] [OK] SafeBrowse Protection Engine is OFFLINE_BACKEND_CACHED_POLICY (Backend unreachable; enforcing cached policy v${syncClient.getActivePolicy()?.version})`
    );
  } else if (currentEngineStatus === 'DEGRADED_POLICY_UNAVAILABLE') {
    logServiceMessage(
      'WARN',
      '[SafeBrowse Service] [DEGRADED_POLICY_UNAVAILABLE] SafeBrowse Protection Engine is DEGRADED_POLICY_UNAVAILABLE (Awaiting initial policy from cloud; standard upstream browsing permitted)'
    );
  } else {
    logServiceMessage(
      'WARN',
      `[SafeBrowse Service] [${currentEngineStatus}] SafeBrowse Protection Engine is ${currentEngineStatus}`
    );
    logServiceMessage('WARN', '[SafeBrowse Service] Local DNS proxy is running, but system DNS enforcement is not active.');
  }
  logServiceMessage('INFO', '--------------------------------------------------');

  // 6. Start Persistent Network Reconciliation Loop (every 3000ms)
  networkManager.startReconciliationLoop(activeDnsPort, 3000, async (success, reason) => {
    // Dynamically update upstream DNS servers if physical network DNS changed
    try {
      const currentUpstreams = await networkManager.getUpstreamDnsServers();
      if (dnsProxy) {
        dnsProxy.setUpstreams(currentUpstreams);
      }
    } catch {}

    if (lastNetSuccess !== success || lastNetReason !== reason) {
      lastNetSuccess = success;
      lastNetReason = reason;
      recomputeAndApplyEngineStatus(
        success
          ? 'Network reconciliation: active enforcement verified'
          : `Network reconciliation: ${reason || 'degraded'}`
      );
    }
  });

  // Network-Arrival Retry Loop (bounded backoff: 5s, 10s, 15s, 30s, 30s for initial route arrival)
  if (!netActivation.success && netActivation.reason === 'NO_NETWORK_ROUTE') {
    const retryDelays = [5000, 10000, 15000, 30000, 30000];
    networkManager
      .activateFailSafeDnsWithRetry({
        dnsPort: activeDnsPort,
        retryDelaysMs: retryDelays,
        isCancelled: () => isShuttingDown,
        initialResult: netActivation,
        onTransition: (from, to) => {
          lastNetSuccess = true;
          lastNetReason = undefined;
          recomputeAndApplyEngineStatus(`Network arrival: ${from} -> ${to}`);
        },
      })
      .catch((err) => {
        logServiceMessage(
          'ERROR',
          `[SafeBrowse Service] [ERROR] Unhandled error during activation retry: ${err.message}`
        );
      });
  }
}

async function showStatus(): Promise<void> {
  console.log('==================================================');
  console.log('[SafeBrowse] SafeBrowse Windows Agent Status');
  console.log('==================================================');
  console.log(`Data Directory:  ${configManager.getBaseDir()}`);
  console.log(`Config File:     ${configManager.getConfigFilePath()}`);
  console.log(`Logs Directory:  ${configManager.getLogsDir()}`);

  const accessState = configManager.checkConfigAccess();

  if (accessState === 'ACCESS_DENIED') {
    console.log('\n[Device Configuration]');
    console.log('  Device configuration: Protected / administrator access required');
    console.log('  Note:          Configuration is secured by Windows ACLs. Run from an Administrator prompt to inspect details.');
  } else {
    const config = await configManager.loadDeviceConfig();
    if (config) {
      console.log('\n[Device Configuration]');
      console.log(`  Paired:        YES`);
      console.log(`  Device ID:     ${config.deviceId}`);
      console.log(`  Device Name:   ${config.deviceName}`);
      console.log(`  Child ID:      ${config.childId}`);
      console.log(`  Backend URL:   ${config.backendUrl}`);
      console.log(`  Paired At:     ${config.pairedAt || 'N/A'}`);

      const cacheFile = path.join(configManager.getCacheDir(), `policy-${config.deviceId}.json`);
      let cachedPolicyVer: number | null = null;
      if (fs.existsSync(cacheFile)) {
        try {
          const raw = fs.readFileSync(cacheFile, 'utf8');
          const p = JSON.parse(raw);
          if (p && typeof p.version === 'number') cachedPolicyVer = p.version;
        } catch {}
      }
      console.log(`  Policy Cache:  ${cachedPolicyVer !== null ? `v${cachedPolicyVer} (PRESENT)` : 'NONE (POLICY_UNAVAILABLE)'}`);
    } else {
      console.log('\n[Device Configuration]');
      console.log(`  Paired:        NO`);
      console.log('  To pair this laptop, run: SafeBrowseChild-Pilot.exe --pair <PAIRING_CODE>');
    }
  }

  const backupFile = networkManager.getBackupFilePath();
  let backupStatus = 'NONE';
  if (accessState === 'ACCESS_DENIED') {
    backupStatus = 'Protected / administrator access required';
  } else {
    try {
      if (fs.existsSync(backupFile)) {
        backupStatus = `ACTIVE (${backupFile})`;
      }
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        backupStatus = 'Protected / administrator access required';
      }
    }
  }
  console.log(`\n[Network Protection State]`);
  console.log(`  DNS Backup:    ${backupStatus}`);

  try {
    const inspection = await networkManager.inspectCurrentEnforcement();
    if (inspection.isProtected) {
      const enforcedAliases = inspection.activeAdapters.map((a) => a.interfaceAlias).join(', ');
      console.log(`  DNS Redirect:  ENFORCED (127.0.0.1 on: ${enforcedAliases})`);
      console.log(`  Parent Status: Protected`);
    } else {
      if (inspection.activeAdapters.length === 0) {
        console.log(`  DNS Redirect:  NOT ACTIVE (No active default route)`);
        console.log(`  Parent Status: Temporarily limited (No Active Network)`);
      } else {
        const unenforced = inspection.activeAdapters
          .filter((a) => !a.isEnforced)
          .map((a) => {
            if (a.queryStatus === 'QUERY_FAILED') {
              return `${a.interfaceAlias} [DNS_QUERY_FAILED]`;
            }
            return `${a.interfaceAlias} [${a.dnsServers.join(', ') || 'NONE'}]`;
          })
          .join('; ');
        console.log(`  DNS Redirect:  NOT ACTIVE (Active adapter(s) not redirected: ${unenforced})`);
        console.log(`  Parent Status: Temporarily limited (DNS Not Redirected)`);
      }
    }
  } catch {
    console.log(`  DNS Redirect:  Status query failed`);
    console.log(`  Parent Status: Temporarily limited (Status Query Error)`);
  }

  if (process.platform === 'win32') {

    try {
      const { stdout } = await execAsync('sc.exe query SafeBrowseChildService');
      console.log('\n[Windows Service Status]');
      console.log(stdout.trim());
    } catch (e: any) {
      console.log('\n[Windows Service Status]: Service not currently installed or not queryable.');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('SafeBrowse Windows Pilot Agent');
    console.log('Usage:');
    console.log('  SafeBrowseChild-Pilot.exe --pair <CODE> [--name <NAME>] [--backend-url <URL>]');
    console.log('  SafeBrowseChild-Pilot.exe service');
    console.log('  SafeBrowseChild-Pilot.exe --status');
    console.log('  SafeBrowseChild-Pilot.exe --emergency-restore');
    process.exit(0);
  }

  if (args.includes('--emergency-restore') || args.includes('--restore-dns')) {
    logServiceMessage('INFO', '[SafeBrowse] Initiating emergency DNS and firewall restoration...');
    try {
      await networkManager.restoreOriginalDns();
      logServiceMessage('INFO', '[SafeBrowse] [OK] Emergency restoration complete.');
      process.exit(0);
    } catch (err: any) {
      logServiceMessage('ERROR', `[SafeBrowse] [ERROR] Emergency restoration failed: ${err.message}`);
      process.exit(1);
    }
  }

  if (args.includes('--status')) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes('--pair') || args.includes('--pairing-code')) {
    await pairDevice(args);
    return;
  }

  // If invoked with "service" or executed by default
  await runServiceMode();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[SafeBrowse Fatal Error] ${err.message}`);
    process.exit(1);
  });
}

export { main };
