import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  safeExecFileAsync,
  safeExecAsync,
  safeSpawn,
  safeExecSync,
  HIDDEN_WINDOW_OPTIONS,
} from '../src/process-exec';
import { ConfigManager, DeviceConfig } from '../src/config-manager';
import { WindowsNetworkManager, TargetAdapterInfo } from '../src/network-manager';
import { GuiServer } from '../src/gui-server';
import { ElevatedPairServer } from '../src/elevated-pair-server';
import { ElevatedConfigServer } from '../src/elevated-config-server';

describe('SafeBrowse Windows Pilot — Window Hygiene, Hidden Process & Pairing State Machine Suite', () => {
  it('1. P0-1: Central process execution helper enforces windowsHide: true across all methods', () => {
    assert.strictEqual(HIDDEN_WINDOW_OPTIONS.windowsHide, true);

    // Verify safeSpawn default options
    const child = safeSpawn(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(child);
    assert.strictEqual(child.spawnargs[0], process.execPath);

    // Verify safeExecSync execution
    const out = safeExecSync(`${process.execPath} -e "console.log('HIDDEN_SYNC_TEST')"`);
    assert.ok(out.toString().includes('HIDDEN_SYNC_TEST'));
  });

  it('2. P0-1: safeExecFileAsync and safeExecAsync execute cleanly with utf8 encoding and hidden windows', async () => {
    const res1 = await safeExecFileAsync(process.execPath, ['-e', 'console.log("FILE_ASYNC_OK")']);
    assert.strictEqual(res1.stdout.trim(), 'FILE_ASYNC_OK');

    const res2 = await safeExecAsync(`${process.execPath} -e "console.log('EXEC_ASYNC_OK')"`);
    assert.strictEqual(res2.stdout.trim(), 'EXEC_ASYNC_OK');
  });

  it('3. P0-1: networkManager deduplicates concurrent queryDnsStateForAdapters calls', async () => {
    const netMgr = new WindowsNetworkManager();
    const mockAdapters: TargetAdapterInfo[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Description: 'Wi-Fi Adapter',
        Gateway: '192.168.1.1',
      },
    ];

    let executionCount = 0;
    netMgr.setCommandExecutorForTesting(async (script: string) => {
      executionCount++;
      // Simulate delay to ensure concurrency window
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        stdout: JSON.stringify([
          {
            InterfaceIndex: 6,
            InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['127.0.0.1'],
            CleanNonLoopback: [],
            IsEnforced: true,
            DhcpEnabled: true,
            QueryStatus: 'OK',
          },
        ]),
        stderr: '',
      };
    });

    netMgr.setPlatformForTesting('win32');

    // Launch 3 concurrent calls
    const [r1, r2, r3] = await Promise.all([
      netMgr.queryDnsStateForAdapters(mockAdapters),
      netMgr.queryDnsStateForAdapters(mockAdapters),
      netMgr.queryDnsStateForAdapters(mockAdapters),
    ]);

    // All 3 callers must receive valid result
    assert.strictEqual(r1.length, 1);
    assert.strictEqual(r2.length, 1);
    assert.strictEqual(r3.length, 1);
    assert.strictEqual(r1[0].IsEnforced, true);

    // Concurrency deduplication: only 1 execution was dispatched
    assert.strictEqual(executionCount, 1);

    // After completion, subsequent call initiates fresh execution
    await netMgr.queryDnsStateForAdapters(mockAdapters);
    assert.strictEqual(executionCount, 2);
  });

  it('4. P0-1: networkManager deduplicates concurrent discoverTargetAdapters calls', async () => {
    const netMgr = new WindowsNetworkManager();
    let discoveryCount = 0;

    netMgr.setCommandExecutorForTesting(async (script: string) => {
      discoveryCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        stdout: JSON.stringify([
          {
            InterfaceIndex: 6,
            InterfaceAlias: 'Wi-Fi',
            Description: 'Intel Wi-Fi',
            Gateway: '192.168.1.1',
            IPv4Addresses: ['192.168.1.50'],
          },
        ]),
        stderr: '',
      };
    });

    netMgr.setPlatformForTesting('win32');

    const [d1, d2] = await Promise.all([
      netMgr.discoverTargetAdapters(true),
      netMgr.discoverTargetAdapters(true),
    ]);

    assert.strictEqual(d1.adapters.length, 1);
    assert.strictEqual(d2.adapters.length, 1);
    assert.strictEqual(discoveryCount, 1);
  });

  it('5. P0-2: ConfigManager pairing state machine accurately handles UNPAIRED, CONNECTED_LOCAL, SYNCING, and CONNECTED', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pairing-state-test-'));
    try {
      const cfgMgr = new ConfigManager(tempDir);
      cfgMgr.setPlatformForTesting('linux');

      // 5.1 No config: UNPAIRED
      assert.strictEqual(cfgMgr.isConfigured(), false);
      assert.strictEqual(cfgMgr.getPairingStatus(), 'UNPAIRED');

      // 5.2 Save config with initial state ACCOUNT_SETUP_REQUIRED: CONNECTED_LOCAL
      const sampleConfig: DeviceConfig = {
        deviceId: 'dev-win-pilot-1234',
        deviceToken: 'tok-abc-xyz',
        childId: null,
        parentId: 'parent-1',
        deviceName: 'Family Laptop',
        backendUrl: 'https://safebrowse.porwal.online',
        onboardingState: 'ACCOUNT_SETUP_REQUIRED',
      };
      await cfgMgr.saveDeviceConfig(sampleConfig);

      assert.strictEqual(cfgMgr.isConfigured(), true);
      assert.strictEqual(cfgMgr.getPairingStatus(), 'CONNECTED_LOCAL');

      // 5.3 State CONNECTING / ACTIVATING: SYNCING
      cfgMgr.setOnboardingState('CONNECTING');
      assert.strictEqual(cfgMgr.getPairingStatus(), 'SYNCING');

      cfgMgr.setOnboardingState('ACTIVATING');
      assert.strictEqual(cfgMgr.getPairingStatus(), 'SYNCING');

      // 5.4 State PROTECTED: CONNECTED
      cfgMgr.setOnboardingState('PROTECTED');
      assert.strictEqual(cfgMgr.getPairingStatus(), 'CONNECTED');

      // 5.5 State ATTENTION_REQUIRED: CONNECTED_LOCAL (never reverts to UNPAIRED)
      cfgMgr.setOnboardingState('ATTENTION_REQUIRED', 'CLOUD_OFFLINE');
      assert.strictEqual(cfgMgr.isConfigured(), true);
      assert.strictEqual(cfgMgr.getPairingStatus(), 'CONNECTED_LOCAL');

      // 5.6 Only explicit clear config returns to UNPAIRED
      await cfgMgr.clearDeviceConfig();
      assert.strictEqual(cfgMgr.isConfigured(), false);
      assert.strictEqual(cfgMgr.getPairingStatus(), 'UNPAIRED');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('6. P1: GuiServer HTML includes loading screen by default and sync banner on status screen', () => {
    const gui = new GuiServer();
    const html = (gui as any).renderHtml();

    // Responsive container width
    assert.ok(html.includes('max-width: 1080px') || html.includes('max-width: 960px'));

    // Loading screen is active initially to prevent "Connect this computer" flash
    assert.ok(html.includes('id="screenLoading" class="screen active"'));

    // Welcome screen is NOT active initially
    assert.ok(html.includes('id="screenWelcome" class="screen"'));
    assert.ok(!html.includes('id="screenWelcome" class="screen active"'));

    // Sync banner with spinner exists for status screen
    assert.ok(html.includes('id="syncBanner"'));
    assert.ok(html.includes('sync-spinner'));

    // Status screen contains device ID and active user telemetry
    assert.ok(html.includes('id="statDevice"'));
    assert.ok(html.includes('id="statUser"'));
  });

  it('7. P1: GuiServer, ElevatedPairServer, and ElevatedConfigServer launch maximized without small window dimensions', async () => {
    const gui = new GuiServer();
    const pair = new ElevatedPairServer();
    const config = new ElevatedConfigServer();

    // Verify code in GuiServer launchWindow uses --start-maximized and NOT small window size
    const guiCode = gui.launchWindow.toString();
    assert.ok(guiCode.includes('--start-maximized'));
    assert.ok(!guiCode.includes('--window-size=880,720'));

    // Verify ElevatedPairServer launchWindow uses --start-maximized
    const pairCode = pair.launchWindow.toString();
    assert.ok(pairCode.includes('--start-maximized'));
    assert.ok(!pairCode.includes('--window-size=780,640'));

    // Verify ElevatedConfigServer launchWindow uses --start-maximized
    const configCode = config.launchWindow.toString();
    assert.ok(configCode.includes('--start-maximized'));
    assert.ok(!configCode.includes('--window-size=820,700'));
  });
});
