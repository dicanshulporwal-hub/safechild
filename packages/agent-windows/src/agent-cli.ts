import { PolicySyncClient } from './sync-client';
import { BlockPageServer } from './block-server';
import { DnsFilterProxy } from './dns-proxy';
import { WindowsProcessLimiter } from './process-limiter';
import { configManager, DeviceConfig, ConfigManager } from './config-manager';
import { networkManager, logServiceMessage, CurrentEnforcementInspection } from './network-manager';
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

  // Manage PID file for single-instance / process tracking
  const pidFile = path.join(configManager.getBaseDir(), 'agent.pid');
  try {
    if (fs.existsSync(pidFile)) {
      const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(oldPid) && oldPid !== process.pid) {
        let isRunning = false;
        try {
          process.kill(oldPid, 0);
          isRunning = true;
        } catch {
          isRunning = false;
        }
        if (isRunning) {
          logServiceMessage('WARN', `[SafeBrowse Service] Existing agent instance found with PID ${oldPid}.`);
        }
      }
    }
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  } catch (err: any) {
    logServiceMessage('WARN', `[SafeBrowse Service] Could not write agent.pid: ${err.message}`);
  }

  // Parent ServiceHost Supervision Watchdog:
  // If spawned by SafeBrowseServiceHost, monitor parent PID.
  // If parent dies unexpectedly, self-terminate immediately with emergency DNS restoration.
  let parentWatchdogTimer: NodeJS.Timeout | null = null;
  const parentPidStr = process.env.SAFEBROWSE_PARENT_PID;
  if (parentPidStr) {
    const parentPid = parseInt(parentPidStr, 10);
    if (!isNaN(parentPid) && parentPid > 0) {
      logServiceMessage('INFO', `[SafeBrowse Service] Supervised by parent ServiceHost PID ${parentPid}. Initializing parent liveness watchdog.`);
      parentWatchdogTimer = setInterval(async () => {
        let parentAlive = false;
        try {
          process.kill(parentPid, 0);
          parentAlive = true;
        } catch (e: any) {
          parentAlive = e.code === 'EPERM';
        }

        if (!parentAlive) {
          logServiceMessage(
            'WARN',
            `[SafeBrowse Service] [CRITICAL] Parent ServiceHost PID ${parentPid} has terminated. Initiating fail-safe emergency DNS restore and self-terminating...`
          );
          if (parentWatchdogTimer) clearInterval(parentWatchdogTimer);
          try {
            await networkManager.restoreOriginalDns();
          } catch (e: any) {
            logServiceMessage('ERROR', `[SafeBrowse Service] Error during emergency DNS restore: ${e.message}`);
          }
          process.exit(1);
        }
      }, 1500);
      parentWatchdogTimer.unref();
    }
  }

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (parentWatchdogTimer) clearInterval(parentWatchdogTimer);
    try {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    } catch {}
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
  const physicalUpstreams = await networkManager.getCurrentPhysicalDnsServers();
  const initialUpstreams = physicalUpstreams.length > 0 ? physicalUpstreams : ['1.1.1.1'];
  networkManager.setConfiguredUpstreams(initialUpstreams);
  dnsProxy = new DnsFilterProxy(() => syncClient!.getActivePolicy(), initialUpstreams[0] || '1.1.1.1', 53);
  dnsProxy.setUpstreams(initialUpstreams);
  networkManager.setActiveUpstreamProvider(() => dnsProxy?.getUpstreamServers() ?? []);
  networkManager.setUpstreamSyncHandler((upstreams) => {
    if (dnsProxy && upstreams && upstreams.length > 0) {
      dnsProxy.setUpstreams(upstreams);
      networkManager.setConfiguredUpstreams(upstreams);
    }
  });
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
    // Dynamically update upstream DNS servers ONLY if physical network DNS is visible
    try {
      const physical = await networkManager.getCurrentPhysicalDnsServers();
      if (physical.length > 0) {
        if (dnsProxy) {
          dnsProxy.setUpstreams(physical);
        }
      } else if (dnsProxy) {
        // Adapter is probably already enforced.
        // RETAIN existing known-good proxy upstreams. Never substitute stale backup!
        dnsProxy.retainUpstreams();
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

export interface ServiceQueryResult {
  installed: boolean;
  state: string;
  isSupervised: boolean;
  rawOutput: string;
}

export async function queryWindowsServiceStatus(): Promise<ServiceQueryResult> {
  if (process.platform !== 'win32') {
    return {
      installed: true,
      state: 'RUNNING',
      isSupervised: true,
      rawOutput: 'Non-Windows test environment: simulated service RUNNING',
    };
  }

  try {
    const { stdout } = await execAsync('sc.exe query SafeBrowseChildService');
    const out = stdout || '';
    let state = 'UNKNOWN';
    let isSupervised = false;

    if (out.includes('STATE') && out.includes('RUNNING')) {
      state = 'RUNNING';
      isSupervised = true;
    } else if (out.includes('STATE') && out.includes('STOPPED')) {
      state = 'STOPPED';
      isSupervised = false;
    } else if (out.includes('STATE') && out.includes('START_PENDING')) {
      state = 'START_PENDING';
      isSupervised = false;
    } else if (out.includes('STATE') && out.includes('STOP_PENDING')) {
      state = 'STOP_PENDING';
      isSupervised = false;
    } else if (out.includes('STATE') && out.includes('PAUSED')) {
      state = 'PAUSED';
      isSupervised = false;
    } else {
      state = 'UNKNOWN';
      isSupervised = false;
    }

    return {
      installed: true,
      state,
      isSupervised,
      rawOutput: out.trim(),
    };
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('1060') || msg.toLowerCase().includes('does not exist')) {
      return {
        installed: false,
        state: 'NOT_INSTALLED',
        isSupervised: false,
        rawOutput: 'Service not currently installed.',
      };
    }
    return {
      installed: false,
      state: 'ERROR',
      isSupervised: false,
      rawOutput: `Service query failed: ${msg}`,
    };
  }
}

export interface StatusEvaluation {
  parentStatus: string;
  isProtected: boolean;
  serviceState: string;
  isSupervised: boolean;
  dnsEnforced: boolean;
  resolverHealthy: boolean;
  isPaired: boolean;
  hasUsablePolicy: boolean;
  activeAdapters: Array<{
    interfaceIndex: number;
    interfaceAlias: string;
    dnsServers: string[];
    isEnforced: boolean;
    queryStatus?: 'OK' | 'QUERY_FAILED';
  }>;
  summary: string;
}

export async function evaluateSystemStatus(options?: {
  serviceChecker?: () => Promise<ServiceQueryResult>;
  resolverChecker?: () => Promise<boolean>;
  enforcementInspector?: () => Promise<CurrentEnforcementInspection>;
  configLoader?: () => Promise<DeviceConfig | null>;
}): Promise<StatusEvaluation> {
  const svcChecker = options?.serviceChecker || queryWindowsServiceStatus;
  const svcResult = await svcChecker();

  const cfgLoader = options?.configLoader || (() => configManager.loadDeviceConfig());
  const config = await cfgLoader();
  const isPaired = !!config;

  let hasUsablePolicy = false;
  if (config) {
    const cacheFile = path.join(configManager.getCacheDir(), `policy-${config.deviceId}.json`);
    if (fs.existsSync(cacheFile)) {
      try {
        const raw = fs.readFileSync(cacheFile, 'utf8');
        const p = JSON.parse(raw);
        if (p && typeof p.version === 'number') {
          hasUsablePolicy = true;
        }
      } catch {}
    }
  }

  const inspector = options?.enforcementInspector || (() => networkManager.inspectCurrentEnforcement());
  let inspection: CurrentEnforcementInspection;
  try {
    inspection = await inspector();
  } catch {
    inspection = { isProtected: false, activeAdapters: [], summary: 'Status query failed' };
  }

  const resChecker =
    options?.resolverChecker ||
    (() => networkManager.verifyEndToEndResolverHealth(53, { timeoutMs: 1500 }));
  let resolverHealthy = false;
  try {
    resolverHealthy = await resChecker();
  } catch {
    resolverHealthy = false;
  }

  let parentStatus: string;
  let isProtected = false;

  if (!isPaired) {
    parentStatus = 'Temporarily limited (Device Not Paired)';
  } else if (inspection.activeAdapters.length === 0) {
    parentStatus = 'Temporarily limited (No Active Network)';
  } else if (!svcResult.isSupervised) {
    if (!svcResult.installed) {
      parentStatus = 'Degraded (Service Not Installed)';
    } else {
      parentStatus = `Degraded (Service ${svcResult.state} / Unsupervised)`;
    }
  } else if (!resolverHealthy) {
    parentStatus = 'Degraded (Resolver Inactive / Unhealthy)';
  } else if (!inspection.isProtected) {
    parentStatus = 'Temporarily limited (DNS Not Redirected)';
  } else if (!hasUsablePolicy) {
    parentStatus = 'Degraded (Policy Unavailable)';
  } else {
    parentStatus = 'Protected';
    isProtected = true;
  }

  return {
    parentStatus,
    isProtected,
    serviceState: svcResult.state,
    isSupervised: svcResult.isSupervised,
    dnsEnforced: inspection.isProtected,
    resolverHealthy,
    isPaired,
    hasUsablePolicy,
    activeAdapters: inspection.activeAdapters,
    summary: inspection.summary,
  };
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

  const statusEval = await evaluateSystemStatus();

  console.log(`\n[Network Protection State]`);
  console.log(`  DNS Backup:    ${backupStatus}`);

  if (statusEval.dnsEnforced) {
    const enforcedAliases = statusEval.activeAdapters.map((a) => a.interfaceAlias).join(', ');
    console.log(`  DNS Redirect:  ENFORCED (127.0.0.1 on: ${enforcedAliases})`);
  } else {
    if (statusEval.activeAdapters.length === 0) {
      console.log(`  DNS Redirect:  NOT ACTIVE (No active default route)`);
    } else {
      const unenforced = statusEval.activeAdapters
        .filter((a) => !a.isEnforced)
        .map((a) => {
          if (a.queryStatus === 'QUERY_FAILED') {
            return `${a.interfaceAlias} [DNS_QUERY_FAILED]`;
          }
          return `${a.interfaceAlias} [${a.dnsServers.join(', ') || 'NONE'}]`;
        })
        .join('; ');
      console.log(`  DNS Redirect:  NOT ACTIVE (Active adapter(s) not redirected: ${unenforced})`);
    }
  }

  console.log(`  Resolver:      ${statusEval.resolverHealthy ? 'HEALTHY (UDP 127.0.0.1:53)' : 'INACTIVE / UNHEALTHY'}`);
  console.log(`  Service State: ${statusEval.serviceState} (SafeBrowseChildService)`);
  console.log(`  Parent Status: ${statusEval.parentStatus}`);

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
