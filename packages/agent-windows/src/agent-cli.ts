import { PolicySyncClient } from './sync-client';
import { BlockPageServer } from './block-server';
import { DnsFilterProxy } from './dns-proxy';
import { WindowsProcessLimiter } from './process-limiter';
import { configManager, DeviceConfig, ConfigManager } from './config-manager';
import { networkManager } from './network-manager';
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
  console.log('🛡️  SafeBrowse Windows Device Pairing');
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

async function runServiceMode(): Promise<void> {
  console.log('==================================================');
  console.log('🛡️  SafeBrowse Windows Enforcement Service');
  console.log('==================================================');

  // Await valid pairing credentials if not yet paired
  let config = await configManager.loadDeviceConfig();
  while (!config) {
    console.log('[SafeBrowse Service] Awaiting device pairing. Please run: SafeBrowseChild-Pilot.exe --pair <CODE>');
    await new Promise((r) => setTimeout(r, 5000));
    config = await configManager.loadDeviceConfig();
  }

  console.log(`[SafeBrowse Service] Active configuration loaded for device: ${config.deviceName} (${config.deviceId})`);
  console.log(`[SafeBrowse Service] Backend: ${config.backendUrl}`);

  // 1. Initialize Sync Client
  const syncClient = new PolicySyncClient(config, configManager.getCacheDir());
  syncClient.start();

  // 2. Initialize Block Page Server
  const blockServer = new BlockPageServer(config.backendUrl, config.childId, config.deviceId);
  await blockServer.start(8880);

  // 3. Initialize DNS Filter Proxy on port 53
  const dnsProxy = new DnsFilterProxy(() => syncClient.getActivePolicy(), '1.1.1.1', 53);
  let activeDnsPort = 53;
  try {
    activeDnsPort = await dnsProxy.start(53);
    console.log(`[SafeBrowse Service] DNS Proxy listening on UDP 127.0.0.1:${activeDnsPort}`);
  } catch (err: any) {
    console.warn(`[SafeBrowse Service] Port 53 bind notice (${err.message}). Starting on fallback port 5353.`);
    activeDnsPort = await dnsProxy.start(5353);
  }

  // 4. Fail-Safe Network DNS Activation
  const netActivation = await networkManager.activateFailSafeDns(activeDnsPort);
  if (!netActivation.success) {
    console.warn(`[SafeBrowse Service] Warning: Fail-safe DNS activation deferred: ${netActivation.message}`);
  } else {
    console.log('[SafeBrowse Service] ✅ Network adapter DNS successfully bound to SafeBrowse local resolver.');
  }

  // 5. Initialize Windows Application Process Limiter
  const processLimiter = new WindowsProcessLimiter(config, () => syncClient.getActivePolicy());
  processLimiter.start();

  console.log('--------------------------------------------------');
  console.log('🟢 SafeBrowse Local Protection Engine is ACTIVE.');
  console.log('--------------------------------------------------');

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[SafeBrowse Service] Received ${signal}. Initiating graceful service shutdown...`);

    try {
      await networkManager.restoreOriginalDns();
    } catch (e: any) {
      console.warn(`[SafeBrowse Service] Warning during DNS restore: ${e.message}`);
    }

    try {
      processLimiter.stop();
      dnsProxy.stop();
      blockServer.stop();
      syncClient.stop();
    } catch (e: any) {
      console.warn(`[SafeBrowse Service] Warning during component teardown: ${e.message}`);
    }

    console.log('[SafeBrowse Service] Service stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  if (process.platform === 'win32') {
    process.on('message', (msg) => {
      if (msg === 'shutdown') gracefulShutdown('shutdown');
    });
  }
}

async function showStatus(): Promise<void> {
  console.log('==================================================');
  console.log('🛡️  SafeBrowse Windows Agent Status');
  console.log('==================================================');
  console.log(`Data Directory:  ${configManager.getBaseDir()}`);
  console.log(`Config File:     ${configManager.getConfigFilePath()}`);
  console.log(`Logs Directory:  ${configManager.getLogsDir()}`);

  const config = await configManager.loadDeviceConfig();
  if (config) {
    console.log('\n[Device Configuration]');
    console.log(`  Paired:        YES`);
    console.log(`  Device ID:     ${config.deviceId}`);
    console.log(`  Device Name:   ${config.deviceName}`);
    console.log(`  Child ID:      ${config.childId}`);
    console.log(`  Backend URL:   ${config.backendUrl}`);
    console.log(`  Paired At:     ${config.pairedAt || 'N/A'}`);
  } else {
    console.log('\n[Device Configuration]');
    console.log(`  Paired:        NO`);
    console.log('  To pair this laptop, run: SafeBrowseChild-Pilot.exe --pair <PAIRING_CODE>');
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
    console.log('[SafeBrowse] Initiating emergency DNS and firewall restoration...');
    try {
      await networkManager.restoreOriginalDns();
      console.log('[SafeBrowse] ✅ Emergency restoration complete.');
      process.exit(0);
    } catch (err: any) {
      console.error(`[SafeBrowse] ❌ Emergency restoration failed: ${err.message}`);
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
