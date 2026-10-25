process.env.NODE_ENV = 'test';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { ConfigManager } from '../src/config-manager';
import { ParentPinManager } from '../src/parent-pin-manager';
import { WindowsAccountManager, WindowsProfileMapping } from '../src/account-manager';
import { GuiServer } from '../src/gui-server';
import { ElevatedPairServer } from '../src/elevated-pair-server';
import { networkManager } from '../src/network-manager';

describe('SafeBrowse Windows Stage C.4 — Unified Onboarding Wizard & Cloud Sync Suite', () => {
  let tmpDir: string;
  let testConfigMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let mockCloudServer: http.Server | null = null;
  let mockCloudPort: number = 0;
  let mockBackendUrl: string = '';
  let syncedCloudMappings: any = null;
  let receivedHeartbeat: any = null;
  let receivedClaimBody: any = null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wizard-test-'));
    testConfigMgr = new ConfigManager(tmpDir);
    testConfigMgr.setMockIsAdministratorForTesting(true);
    networkManager.setUpstreamResolutionCheckerForTesting(async () => true);

    accountMgr = new WindowsAccountManager(tmpDir);
    accountMgr.setMockAccountsForTesting([
      { name: 'AzureAD\\AnshulPorwal', sid: 'S-1-5-21-1000-1001', disabled: false, isCurrentConsoleUser: true },
      { name: 'ParentUser', sid: 'S-1-5-21-1000-1002', disabled: false, isCurrentConsoleUser: false },
    ]);
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1001');

    syncedCloudMappings = null;
    receivedHeartbeat = null;
    receivedClaimBody = null;

    // Start mock backend cloud server
    await new Promise<void>((resolve) => {
      mockCloudServer = http.createServer((req, res) => {
        const parsed = new URL(req.url || '', `http://127.0.0.1:${mockCloudPort}`);

        if (parsed.pathname === '/api/devices/claim' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            receivedClaimBody = JSON.parse(body || '{}');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                device: {
                  id: 'dev-laptop-123',
                  deviceToken: 'dtk_mock_token_777',
                  childId: 'child-manjari',
                  parentId: 'parent-anshul',
                  name: 'Anshul Laptop',
                },
                policy: { version: 1, rules: [] },
              })
            );
          });
          return;
        }

        if (parsed.pathname === '/api/devices/family-profiles' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              profiles: [
                { id: 'child-manjari', name: 'Manjari', age: 10 },
                { id: 'child-rahul', name: 'Rahul', age: 14 },
              ],
            })
          );
          return;
        }

        if (parsed.pathname === '/api/devices/dev-laptop-123/account-mappings' && req.method === 'PUT') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            syncedCloudMappings = JSON.parse(body || '{}');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: syncedCloudMappings.mappings.length }));
          });
          return;
        }

        if (parsed.pathname === '/api/devices/heartbeat' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            receivedHeartbeat = JSON.parse(body || '{}');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', latestPolicyVersion: 1, policyChanged: false }));
          });
          return;
        }

        if (parsed.pathname.startsWith('/api/policies/device/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: 1, rules: [] }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });

      mockCloudServer.listen(0, '127.0.0.1', () => {
        const addr = mockCloudServer!.address() as any;
        mockCloudPort = addr.port;
        mockBackendUrl = `http://127.0.0.1:${mockCloudPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (mockCloudServer) {
      await new Promise<void>((resolve) => mockCloudServer!.close(() => resolve()));
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. syncAccountMappingsToCloud successfully synchronizes mappings to backend', async () => {
    const testMappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1001',
        windowsUsername: 'AzureAD\\AnshulPorwal',
        childId: 'child-manjari',
        enabled: true,
      },
      {
        windowsSid: 'S-1-5-21-1000-1002',
        windowsUsername: 'ParentUser',
        childId: null,
        enabled: true,
      },
    ];

    const result = await accountMgr.syncAccountMappingsToCloud(
      mockBackendUrl,
      'dev-laptop-123',
      'dtk_mock_token_777',
      testMappings
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.count, 2);
    assert.ok(syncedCloudMappings);
    assert.strictEqual(syncedCloudMappings.mappings.length, 2);
    assert.strictEqual(syncedCloudMappings.mappings[0].windowsSid, 'S-1-5-21-1000-1001');
    assert.strictEqual(syncedCloudMappings.mappings[0].childId, 'child-manjari');
    assert.strictEqual(syncedCloudMappings.mappings[1].childId, null);
  });

  it('2. ElevatedPairServer executes complete first-run onboarding wizard flow', async () => {
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const pairPort = await pairServer.start(0);

    // Screen 2: Submit pairing code (testing canonical 8-character format K8X9M2W7)
    const claimRes = await fetch(`http://127.0.0.1:${pairPort}/api/claim-and-pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'K8X9M2W7',
        deviceName: 'Living Room PC',
        backendUrl: mockBackendUrl,
      }),
    });
    assert.strictEqual(claimRes.status, 200);
    const claimData: any = await claimRes.json();
    assert.strictEqual(claimData.success, true);
    assert.strictEqual(claimData.device.deviceId, 'dev-laptop-123');
    assert.strictEqual(receivedClaimBody.code, 'K8X9M2W7');

    // Screen 3: Fetch discovered accounts & family profiles
    const accountsRes = await fetch(`http://127.0.0.1:${pairPort}/api/accounts`);
    assert.strictEqual(accountsRes.status, 200);
    const accountsData: any = await accountsRes.json();
    assert.strictEqual(accountsData.accounts.length, 2);
    assert.strictEqual(accountsData.accounts[0].name, 'AzureAD\\AnshulPorwal');

    const profilesRes = await fetch(`http://127.0.0.1:${pairPort}/api/family-profiles`);
    assert.strictEqual(profilesRes.status, 200);
    const profilesData: any = await profilesRes.json();
    assert.strictEqual(profilesData.profiles.length, 2);
    assert.strictEqual(profilesData.profiles[0].name, 'Manjari');

    // Screen 4: Finish setup (persist + cloud sync + policies + heartbeat)
    const finishRes = await fetch(`http://127.0.0.1:${pairPort}/api/finish-setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentPin: '123456',
        mappings: [
          {
            windowsSid: 'S-1-5-21-1000-1001',
            windowsUsername: 'AzureAD\\AnshulPorwal',
            childId: 'child-manjari',
            childName: 'Manjari',
            enabled: true,
          },
          {
            windowsSid: 'S-1-5-21-1000-1002',
            windowsUsername: 'ParentUser',
            childId: null,
            childName: null,
            enabled: true,
          },
        ],
      }),
    });
    assert.strictEqual(finishRes.status, 200);
    const finishData: any = await finishRes.json();
    assert.strictEqual(finishData.success, true);

    // Verify local persistence
    const savedMappings = await accountMgr.loadProfileMappings();
    assert.strictEqual(savedMappings.length, 2);
    assert.strictEqual(savedMappings[0].childId, 'child-manjari');

    // Verify cloud synchronization occurred
    assert.ok(syncedCloudMappings);
    assert.strictEqual(syncedCloudMappings.mappings.length, 2);

    // Verify heartbeat was sent with active session context
    assert.ok(receivedHeartbeat);
    assert.strictEqual(receivedHeartbeat.deviceId, 'dev-laptop-123');
    assert.strictEqual(receivedHeartbeat.activeChildId, 'child-manjari');
    assert.strictEqual(receivedHeartbeat.protectionStatus, 'MANAGED_CHILD');

    // Clean close
    const closeRes = await fetch(`http://127.0.0.1:${pairPort}/api/close`, { method: 'POST' });
    assert.strictEqual(closeRes.status, 200);
    pairServer.stop();
  });

  it('3. GuiServer provides post-onboarding Day-2 quick action endpoints', async () => {
    // Pre-configure device
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-laptop-123',
      deviceToken: 'dtk_mock_token_777',
      childId: 'child-manjari',
      parentId: 'parent-anshul',
      deviceName: 'Living Room PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });

    const pinMgr = new ParentPinManager(testConfigMgr);
    await pinMgr.setPin('123456');
    const session = await pinMgr.verifyPin('123456');

    const gui = new GuiServer(testConfigMgr, accountMgr, undefined, pinMgr);
    const guiPort = await gui.start(0);

    // Check status
    const statRes = await fetch(`http://127.0.0.1:${guiPort}/api/status`);
    assert.strictEqual(statRes.status, 200);
    const statData: any = await statRes.json();
    assert.strictEqual(statData.isPaired, true);

    // Check protection
    const checkRes = await fetch(`http://127.0.0.1:${guiPort}/api/check-protection`);
    assert.strictEqual(checkRes.status, 200);
    const checkData: any = await checkRes.json();
    assert.strictEqual(checkData.success, true);

    // Open dashboard
    const dashRes = await fetch(`http://127.0.0.1:${guiPort}/api/open-dashboard`, { method: 'POST' });
    assert.strictEqual(dashRes.status, 200);

    // Disconnect device with valid Parent PIN management session
    const discRes = await fetch(`http://127.0.0.1:${guiPort}/api/disconnect`, {
      method: 'POST',
      headers: { 'x-management-session': session.sessionToken! },
    });
    assert.strictEqual(discRes.status, 200);

    // Verify config removed
    const configAfter = await testConfigMgr.loadSanitizedConfig();
    assert.strictEqual(configAfter, null);

    gui.stop();
  });
});
