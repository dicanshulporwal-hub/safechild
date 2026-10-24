process.env.NODE_ENV = 'test';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { ConfigManager, DeviceConfig, OnboardingState } from '../src/config-manager';
import { WindowsAccountManager, WindowsProfileMapping } from '../src/account-manager';
import { GuiServer } from '../src/gui-server';
import { ElevatedPairServer } from '../src/elevated-pair-server';
import { WindowsNetworkManager, networkManager } from '../src/network-manager';

describe('SafeBrowse Stage C.4.2 — Windows Onboarding State Machine & Fail-Safe Protection Suite', () => {
  let tmpDir: string;
  let testConfigMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let netMgr: WindowsNetworkManager;
  let mockBackendServer: http.Server | null = null;
  let mockBackendPort: number = 0;
  let mockBackendUrl: string = '';
  let unpairCalledWithToken: string | null = null;
  let backendProtocolVersion: number = 2;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-machine-test-'));
    testConfigMgr = new ConfigManager(tmpDir);
    testConfigMgr.setMockIsAdministratorForTesting(true);

    accountMgr = new WindowsAccountManager(tmpDir);
    netMgr = new WindowsNetworkManager(path.join(tmpDir, 'network-backup.json'), testConfigMgr);
    netMgr.setUpstreamResolutionCheckerForTesting(async () => true);
    networkManager.setConfigManagerForTesting(testConfigMgr);
    networkManager.setUpstreamResolutionCheckerForTesting(async () => true);

    unpairCalledWithToken = null;
    backendProtocolVersion = 3;

    // Start mock backend cloud server
    await new Promise<void>((resolve) => {
      mockBackendServer = http.createServer((req, res) => {
        const parsed = new URL(req.url || '', `http://127.0.0.1:${mockBackendPort}`);

        if (parsed.pathname === '/api/version' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              application: 'SafeBrowse',
              windowsProtocolVersion: backendProtocolVersion,
              schemaVersion: '20261023120000',
              backendVersion: '1.0.4-validation',
            })
          );
          return;
        }

        if (parsed.pathname === '/api/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy' }));
          return;
        }

        if (parsed.pathname.endsWith('/unpair') && req.method === 'POST') {
          unpairCalledWithToken = (req.headers['x-device-token'] as string) || null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Unpaired' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });

      mockBackendServer.listen(0, '127.0.0.1', () => {
        const addr = mockBackendServer!.address() as any;
        mockBackendPort = addr.port;
        mockBackendUrl = `http://127.0.0.1:${mockBackendPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (mockBackendServer) {
      await new Promise<void>((resolve) => mockBackendServer!.close(() => resolve()));
    }
    netMgr.setUpstreamResolutionCheckerForTesting(null);
    networkManager.setUpstreamResolutionCheckerForTesting(null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. ConfigManager tracks onboarding state and persists state to sanitized config', async () => {
    // Unconfigured state defaults to NOT_CONNECTED
    assert.strictEqual(testConfigMgr.getOnboardingState(), 'NOT_CONNECTED');
    assert.strictEqual(testConfigMgr.getOnboardingReason(), undefined);

    // Save initial device config (transitions to ACCOUNT_SETUP_REQUIRED by default)
    const mockConfig: DeviceConfig = {
      deviceId: 'dev_test_windows_pc',
      deviceToken: 'dtk_test_secret_abc123',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Family-Desktop',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    };
    await testConfigMgr.saveDeviceConfig(mockConfig);

    assert.strictEqual(testConfigMgr.getOnboardingState(), 'ACCOUNT_SETUP_REQUIRED');
    let sanitized = testConfigMgr.loadSanitizedConfigSync();
    assert.ok(sanitized);
    assert.strictEqual(sanitized.onboardingState, 'ACCOUNT_SETUP_REQUIRED');
    assert.strictEqual(sanitized.isPaired, true);

    // Transition to ACTIVATING
    testConfigMgr.setOnboardingState('ACTIVATING');
    assert.strictEqual(testConfigMgr.getOnboardingState(), 'ACTIVATING');
    sanitized = testConfigMgr.loadSanitizedConfigSync();
    assert.strictEqual(sanitized?.onboardingState, 'ACTIVATING');
    assert.strictEqual(sanitized?.isPaired, true);

    // Transition to PROTECTED
    testConfigMgr.setOnboardingState('PROTECTED');
    assert.strictEqual(testConfigMgr.getOnboardingState(), 'PROTECTED');
    sanitized = testConfigMgr.loadSanitizedConfigSync();
    assert.strictEqual(sanitized?.onboardingState, 'PROTECTED');
    assert.strictEqual(sanitized?.isPaired, true);

    // Transition to ATTENTION_REQUIRED with reason
    testConfigMgr.setOnboardingState('ATTENTION_REQUIRED', 'DEVICE_REVOKED');
    assert.strictEqual(testConfigMgr.getOnboardingState(), 'ATTENTION_REQUIRED');
    assert.strictEqual(testConfigMgr.getOnboardingReason(), 'DEVICE_REVOKED');
    sanitized = testConfigMgr.loadSanitizedConfigSync();
    assert.strictEqual(sanitized?.onboardingState, 'ATTENTION_REQUIRED');
    assert.strictEqual(sanitized?.onboardingReason, 'DEVICE_REVOKED');

    // Clear config sets state to DISCONNECTED
    await testConfigMgr.clearDeviceConfig();
    assert.strictEqual(testConfigMgr.getOnboardingState(), 'DISCONNECTED');
  });

  it('2. NetworkManager strictly aborts DNS hijack when onboarding is NOT ACTIVATING or PROTECTED', async () => {
    // 2.1 State NOT_CONNECTED
    testConfigMgr.setOnboardingState('NOT_CONNECTED');
    let res = await netMgr.activateFailSafeDns(53, 1);
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('NOT_CONNECTED'));

    // 2.2 State ACCOUNT_SETUP_REQUIRED
    testConfigMgr.setOnboardingState('ACCOUNT_SETUP_REQUIRED');
    res = await netMgr.activateFailSafeDns(53, 1);
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('ACCOUNT_SETUP_REQUIRED'));

    // 2.3 State ATTENTION_REQUIRED
    testConfigMgr.setOnboardingState('ATTENTION_REQUIRED', 'DEVICE_NOT_FOUND');
    res = await netMgr.activateFailSafeDns(53, 1);
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('ATTENTION_REQUIRED'));

    // 2.4 State ACTIVATING: Allowed to execute network activation
    testConfigMgr.setOnboardingState('ACTIVATING');
    res = await netMgr.activateFailSafeDns(53, 1);
    // In test environment without win32 physical NIC, mock discovery succeeds or completes
    assert.ok(res.success || res.reason === 'NO_NETWORK_ROUTE' || (res.interfaceIndexes && res.interfaceIndexes.length > 0));
    assert.ok(!res.message.includes('Activation aborted: device onboarding state'));

    // 2.5 State PROTECTED: Allowed to execute network activation
    testConfigMgr.setOnboardingState('PROTECTED');
    res = await netMgr.activateFailSafeDns(53, 1);
    assert.ok(!res.message.includes('Activation aborted: device onboarding state'));
  });

  it('3. NetworkManager skips adapter reconciliation when onboarding is incomplete', async () => {
    testConfigMgr.setOnboardingState('NOT_CONNECTED');
    const reconcileResult = await netMgr.reconcileAdapters();
    assert.strictEqual(reconcileResult.status, 'SKIPPED');
    assert.ok(reconcileResult.message.includes('NOT_CONNECTED'));
  });

  it('4. ElevatedPairServer status endpoint exposes state machine and mappings status', async () => {
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr, netMgr);
    const port = await pairServer.start(0);

    try {
      // Initially NOT_CONNECTED
      testConfigMgr.setOnboardingState('NOT_CONNECTED');
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.onboardingState, 'NOT_CONNECTED');
      assert.strictEqual(data.hasMappings, false);
      assert.strictEqual(data.isPaired, false);
    } finally {
      pairServer.stop();
    }
  });

  it('5. ElevatedPairServer version-check enforces windowsProtocolVersion >= 3 (Test B)', async () => {
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr, netMgr);
    const port = await pairServer.start(0);

    try {
      // 5.1 Protocol version 1 is incompatible
      backendProtocolVersion = 1;
      const resIncompat1 = await fetch(`http://127.0.0.1:${port}/api/version-check?url=${encodeURIComponent(mockBackendUrl)}`);
      assert.strictEqual(resIncompat1.status, 200);
      const dataIncompat1 = await resIncompat1.json() as any;
      assert.strictEqual(dataIncompat1.compatible, false);
      assert.strictEqual(dataIncompat1.error, 'SafeBrowse service needs an update. Please try again shortly.');

      // 5.2 Protocol version 2 is incompatible
      backendProtocolVersion = 2;
      const resIncompat2 = await fetch(`http://127.0.0.1:${port}/api/version-check?url=${encodeURIComponent(mockBackendUrl)}`);
      assert.strictEqual(resIncompat2.status, 200);
      const dataIncompat2 = await resIncompat2.json() as any;
      assert.strictEqual(dataIncompat2.compatible, false);
      assert.strictEqual(dataIncompat2.error, 'SafeBrowse service needs an update. Please try again shortly.');

      // 5.3 Protocol version 3 is compatible
      backendProtocolVersion = 3;
      const resOk3 = await fetch(`http://127.0.0.1:${port}/api/version-check?url=${encodeURIComponent(mockBackendUrl)}`);
      assert.strictEqual(resOk3.status, 200);
      const dataOk3 = await resOk3.json() as any;
      assert.strictEqual(dataOk3.compatible, true);
      assert.strictEqual(dataOk3.windowsProtocolVersion, 3);

      // 5.4 Protocol version 4 is compatible (forward compatibility)
      backendProtocolVersion = 4;
      const resOk4 = await fetch(`http://127.0.0.1:${port}/api/version-check?url=${encodeURIComponent(mockBackendUrl)}`);
      assert.strictEqual(resOk4.status, 200);
      const dataOk4 = await resOk4.json() as any;
      assert.strictEqual(dataOk4.compatible, true);
      assert.strictEqual(dataOk4.windowsProtocolVersion, 4);
    } finally {
      pairServer.stop();
    }
  });

  it('5b. Incompatible backend keeps pairing blocked, DNS untouched, no Protected state (Test C)', async () => {
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr, netMgr);
    const port = await pairServer.start(0);

    try {
      backendProtocolVersion = 2; // Incompatible Stage C.4 backend

      const claimRes = await fetch(`http://127.0.0.1:${port}/api/claim-and-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'K8X9M2W7',
          deviceName: 'Test-PC',
          backendUrl: mockBackendUrl,
        }),
      });

      assert.strictEqual(claimRes.status, 400);
      const data = await claimRes.json() as any;
      assert.strictEqual(data.error, 'SafeBrowse service needs an update. Please try again shortly.');

      // Verify fail-safe: device state is NOT PROTECTED, device config not written
      assert.notStrictEqual(testConfigMgr.getOnboardingState(), 'PROTECTED');
      assert.strictEqual(testConfigMgr.getOnboardingState(), 'NOT_CONNECTED');
      assert.strictEqual(await testConfigMgr.loadDeviceConfig(), null);
    } finally {
      pairServer.stop();
    }
  });

  it('6. ElevatedPairServer POST /api/reconnect cleanly resets pairing and profile mappings', async () => {
    // Setup pairing state and mappings
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev_to_reconnect',
      deviceToken: 'dtk_token_reconnect',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Family-PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });
    testConfigMgr.setOnboardingState('ATTENTION_REQUIRED', 'DEVICE_REVOKED');

    // Save profile mapping
    await accountMgr.saveProfileMappings([
      { windowsSid: 'S-1-5-21-1-2-3-1001', windowsUsername: 'ChildUser', childId: 'child_1', enabled: true },
    ]);
    assert.strictEqual(await accountMgr.hasProfileMappings(), true);

    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr, netMgr);
    const port = await pairServer.start(0);

    try {
      const recRes = await fetch(`http://127.0.0.1:${port}/api/reconnect`, { method: 'POST' });
      assert.strictEqual(recRes.status, 200);
      const recData = await recRes.json() as any;
      assert.strictEqual(recData.success, true);
      assert.strictEqual(recData.onboardingState, 'NOT_CONNECTED');

      // Verify files unlinked and state reset
      assert.strictEqual(testConfigMgr.getOnboardingState(), 'NOT_CONNECTED');
      assert.strictEqual(await accountMgr.hasProfileMappings(), false);
    } finally {
      pairServer.stop();
    }
  });

  it('7. GuiServer POST /api/disconnect performs complete atomic teardown and unpairs cloud', async () => {
    // Setup paired state
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev_to_disconnect',
      deviceToken: 'dtk_token_disconnect_999',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Family-PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });
    testConfigMgr.setOnboardingState('PROTECTED');

    await accountMgr.saveProfileMappings([
      { windowsSid: 'S-1-5-21-1-2-3-1001', windowsUsername: 'ChildUser', childId: 'child_1', enabled: true },
    ]);

    const guiServer = new GuiServer(testConfigMgr, accountMgr, netMgr);
    const port = await guiServer.start(0);

    try {
      const discRes = await fetch(`http://127.0.0.1:${port}/api/disconnect`, { method: 'POST' });
      assert.strictEqual(discRes.status, 200);
      const discData = await discRes.json() as any;
      assert.strictEqual(discData.success, true);
      assert.strictEqual(discData.disconnected, true);

      // Verify cloud unpair was requested with device token
      assert.strictEqual(unpairCalledWithToken, 'dtk_token_disconnect_999');

      // Verify local configuration and mappings cleared
      assert.strictEqual(testConfigMgr.getOnboardingState(), 'DISCONNECTED');
      assert.strictEqual(await accountMgr.hasProfileMappings(), false);
    } finally {
      guiServer.stop();
    }
  });
});
