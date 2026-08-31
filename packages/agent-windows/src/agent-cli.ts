import { PolicySyncClient, DeviceConfig } from './sync-client';
import { BlockPageServer } from './block-server';
import { DnsFilterProxy } from './dns-proxy';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const args = process.argv.slice(2);
  const backendUrl = process.env.SAFEBROWSE_URL || 'http://localhost:1002';
  const configPath = path.join(process.cwd(), 'device-config.json');

  console.log('==================================================');
  console.log('🛡️  SafeBrowse Windows Enforcement Agent');
  console.log('==================================================');

  let config: DeviceConfig | null = null;

  // Check if --pair flag was provided
  const pairIdx = args.indexOf('--pair');
  if (pairIdx !== -1 && args[pairIdx + 1]) {
    const code = args[pairIdx + 1];
    const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : "Rahul's Windows Laptop";

    console.log(`[Setup] Pairing device with code: ${code}...`);
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
      const err = await res.json();
      console.error(`[Setup Error] Failed to pair device: ${err.error || 'Unknown error'}`);
      process.exit(1);
    }

    const data: any = await res.json();
    config = {
      deviceId: data.device.id,
      deviceToken: data.device.deviceToken,
      childId: data.device.childId,
      parentId: data.device.parentId,
      deviceName: data.device.name,
      backendUrl,
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[Setup] Successfully paired device! Config saved to device-config.json`);
  } else if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    console.error('[Error] No device configuration found. Please pair this device using a pairing code from the SafeBrowse parent portal:');
    console.error('  Usage: safebrowse-agent --pairing-code SB-XXXX-XXXX');
    process.exit(1);
  }

  if (!config) {
    console.error('Failed to initialize device configuration.');
    process.exit(1);
  }

  // 1. Initialize Sync Client
  const syncClient = new PolicySyncClient(config);
  syncClient.start();

  // 2. Initialize Block Page Server
  const blockServer = new BlockPageServer(config.backendUrl, config.childId, config.deviceId);
  await blockServer.start(8880);

  // 3. Initialize DNS Filter Proxy
  const dnsProxy = new DnsFilterProxy(() => syncClient.getActivePolicy(), '1.1.1.1', 53);
  await dnsProxy.start(5353);

  console.log('[SafeBrowse] Local Device Protection is ACTIVE.');
  console.log(`[SafeBrowse] Protecting: ${config.deviceName}`);
}

if (require.main === module) {
  main().catch(console.error);
}

export { main };
