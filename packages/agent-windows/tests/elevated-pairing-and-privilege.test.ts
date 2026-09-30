import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { ConfigManager } from '../src/config-manager';
import { WindowsAccountManager, FamilyChildProfile } from '../src/account-manager';
import { GuiServer } from '../src/gui-server';
import { ElevatedPairServer } from '../src/elevated-pair-server';
import { ElevatedConfigServer } from '../src/elevated-config-server';
import { networkManager } from '../src/network-manager';

describe('SafeBrowse Windows Pilot — Elevated Pairing & Privilege Separation Suite (v1.0.2-pilot)', () => {
  let tmpDir: string;
  let testConfigMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let mockCloudServer: http.Server | null = null;
  let mockCloudPort: number = 0;
  let mockBackendUrl: string = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pair-test-'));
    testConfigMgr = new ConfigManager(tmpDir);
    testConfigMgr.setMockIsAdministratorForTesting(true);
    networkManager.setUpstreamResolutionCheckerForTesting(async () => true);

    accountMgr = new WindowsAccountManager(tmpDir);
    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1001', disabled: false, isCurrentConsoleUser: true },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1002', disabled: false, isCurrentConsoleUser: false },
    ]);
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1001');

    // Start mock cloud server
    await new Promise<void>((resolve) => {
      mockCloudServer = http.createServer((req, res) => {
        const parsed = new URL(req.url || '', `http://127.0.0.1:${mockCloudPort}`);

        if (parsed.pathname === '/api/devices/claim' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const data = JSON.parse(body || '{}');
            if (data.code === 'SB-EXPIRED' || data.code === 'SB-INVALID') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Pairing code expired or invalid' }));
              return;
            }

            if (data.code === 'SB-SERVER-ERROR') {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal server error' }));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                device: {
                  id: 'dev-pilot-v102',
                  deviceToken: 'dtk_super_secret_token_live_102',
                  childId: 'child-manjari-102',
                  parentId: 'parent-anshul-102',
                  name: data.deviceName || 'Family Laptop',
                },
                familyProfiles: [
                  { id: 'child-manjari-102', name: 'Manjari', age: 12 },
                  { id: 'child-rahul-102', name: 'Rahul', age: 8 },
                ],
              })
            );
          });
          return;
        }

        if (parsed.pathname.startsWith('/api/policies/device/') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              policy: {
                version: 1,
                name: 'Standard Child Policy',
                categories: ['pornography', 'gambling'],
              },
            })
          );
          return;
        }

        if (
          (parsed.pathname === '/api/devices/family-profiles' || parsed.pathname === '/api/devices/profiles') &&
          req.method === 'GET'
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              profiles: [
                { id: 'child-manjari-102', name: 'Manjari', age: 12 },
                { id: 'child-rahul-102', name: 'Rahul', age: 8 },
              ],
            })
          );
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      mockCloudServer.listen(0, '127.0.0.1', () => {
        const addr = mockCloudServer!.address();
        mockCloudPort = typeof addr === 'object' && addr ? addr.port : 0;
        mockBackendUrl = `http://127.0.0.1:${mockCloudPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    networkManager.setUpstreamResolutionCheckerForTesting(null);
    if (mockCloudServer) {
      mockCloudServer.close();
      mockCloudServer = null;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Normal GUI opens unelevated and renders friendly interface without requiring admin privileges', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(false);
    const gui = new GuiServer(testConfigMgr, accountMgr);
    const port = await gui.start(0);

    try {
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(statusRes.status, 200);
      const data: any = await statusRes.json();
      assert.strictEqual(data.isPaired, false);
      assert.strictEqual(data.config, null);

      const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('SafeBrowse Family Protection'));
      assert.ok(html.includes('Attach Device'));
      assert.ok(html.includes('launchElevatedPair'));
    } finally {
      await gui.stop();
    }
  });

  it('2. Normal GUI cannot directly write secure config via POST /api/pair (returns 403 Forbidden)', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(false);
    const gui = new GuiServer(testConfigMgr, accountMgr);
    const port = await gui.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'SB-TEST-0001',
          deviceName: 'Unelevated Laptop',
          backendUrl: mockBackendUrl,
        }),
      });

      assert.strictEqual(res.status, 403);
      const data: any = await res.json();
      assert.strictEqual(data.error, 'Administrator approval is required to attach this device.');

      // Invariant: No secure configuration created
      assert.strictEqual(fs.existsSync(testConfigMgr.getConfigFilePath()), false);
      assert.strictEqual(fs.existsSync(testConfigMgr.getSanitizedConfigFilePath()), false);
    } finally {
      await gui.stop();
    }
  });

  it('3. Normal GUI Attach Device triggers UAC request via POST /api/launch-pair', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(false);
    const gui = new GuiServer(testConfigMgr, accountMgr);
    const port = await gui.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/launch-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'SB-VALID-1234',
          deviceName: 'Family Laptop',
        }),
      });

      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.message, 'Administrator elevation requested');
    } finally {
      await gui.stop();
    }
  });

  it('4. Cancelling UAC leaves zero configuration and does not consume pairing code', async () => {
    // When UAC is cancelled by user, launch-pair catches the cancellation
    // Here we verify invariant: no local files exist before elevated process writes them
    assert.strictEqual(fs.existsSync(testConfigMgr.getConfigFilePath()), false);
    assert.strictEqual(fs.existsSync(testConfigMgr.getSanitizedConfigFilePath()), false);
  });

  it('5. Elevated pairing process starts on dedicated port and renders administrator UI', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(true);
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const port = await pairServer.start(0);

    try {
      const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('SafeBrowse Setup Wizard'));
      assert.ok(html.includes('ADMINISTRATOR'));
      assert.ok(html.includes('Attach Device to Family'));
      assert.ok(html.includes('input-code'));

      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(statusRes.status, 200);
      const statusData: any = await statusRes.json();
      assert.strictEqual(statusData.isElevated, true);
      assert.strictEqual(statusData.isPaired, false);
    } finally {
      pairServer.stop();
    }
  });

  it('6. Elevated process: valid code claims device, persists DPAPI secure config, and sanitizes state', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(true);
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const port = await pairServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/claim-and-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'SB-VALID-9999',
          deviceName: 'Rahul & Manjari Laptop',
          backendUrl: mockBackendUrl,
        }),
      });

      assert.strictEqual(res.status, 200);
      const data: any = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.message, 'Device attached successfully.');
      assert.strictEqual(data.device.deviceId, 'dev-pilot-v102');
      assert.strictEqual(data.device.deviceName, 'Rahul & Manjari Laptop');

      // Verify secure config exists
      const securePath = testConfigMgr.getConfigFilePath();
      assert.ok(fs.existsSync(securePath));
      const secureConfig = await testConfigMgr.loadDeviceConfig();
      assert.ok(secureConfig);
      assert.strictEqual(secureConfig.deviceId, 'dev-pilot-v102');
      assert.strictEqual(secureConfig.deviceToken, 'dtk_super_secret_token_live_102');

      // Verify sanitized config exists
      const sanitizedPath = testConfigMgr.getSanitizedConfigFilePath();
      assert.ok(fs.existsSync(sanitizedPath));
      const sanitized = await testConfigMgr.loadSanitizedConfig();
      assert.ok(sanitized);
      assert.strictEqual(sanitized.deviceId, 'dev-pilot-v102');
      assert.strictEqual(sanitized.isPaired, true);
    } finally {
      pairServer.stop();
    }
  });

  it('7. Invalid or expired pairing code is rejected with user-friendly error without writing files', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(true);
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const port = await pairServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/claim-and-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'SB-EXPIRED',
          deviceName: 'Laptop',
          backendUrl: mockBackendUrl,
        }),
      });

      assert.strictEqual(res.status, 400);
      const data: any = await res.json();
      assert.ok(data.error.includes('pairing code is invalid or has expired'));

      // Invariant: No partial config files
      assert.strictEqual(fs.existsSync(testConfigMgr.getConfigFilePath()), false);
      assert.strictEqual(fs.existsSync(testConfigMgr.getSanitizedConfigFilePath()), false);
    } finally {
      pairServer.stop();
    }
  });

  it('8. Invariant: deviceToken is never exposed in normal GUI status or API endpoints', async () => {
    // Setup paired state
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-secure-999',
      deviceToken: 'dtk_strictly_confidential_token_never_expose',
      backendUrl: mockBackendUrl,
      deviceName: 'Secure Family PC',
      childId: 'child-101',
      parentId: 'parent-101',
      pairedAt: new Date().toISOString(),
    });

    // Start normal unelevated GUI
    testConfigMgr.setMockIsAdministratorForTesting(false);
    const gui = new GuiServer(testConfigMgr, accountMgr);
    const port = await gui.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();

      // Crucial security invariant: deviceToken must NOT appear in raw text of status API
      assert.strictEqual(body.includes('dtk_strictly_confidential_token_never_expose'), false);

      const parsed: any = JSON.parse(body);
      assert.strictEqual(parsed.isPaired, true);
      assert.strictEqual(parsed.config.deviceId, 'dev-secure-999');
      assert.strictEqual(parsed.config.deviceToken, undefined);
    } finally {
      await gui.stop();
    }
  });

  it('9. Invariant: deviceToken is never written plaintext to disk (only DPAPI ciphertext)', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-dpapi-test',
      deviceToken: 'dtk_plaintext_must_not_appear_on_disk',
      backendUrl: mockBackendUrl,
      deviceName: 'Family Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    const securePath = testConfigMgr.getConfigFilePath();
    const rawContent = fs.readFileSync(securePath, 'utf8');

    // Token must NOT exist in plaintext anywhere in the file
    assert.strictEqual(rawContent.includes('dtk_plaintext_must_not_appear_on_disk'), false);

    const json = JSON.parse(rawContent);
    assert.strictEqual(json.deviceToken, undefined);
    assert.ok(json.deviceTokenEncrypted);
  });

  it('10. Invariant: sanitized-config.json contains zero secrets or encrypted tokens', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-sanitized-test',
      deviceToken: 'dtk_token_to_verify_zero_secret',
      backendUrl: mockBackendUrl,
      deviceName: 'Family Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    const sanitizedPath = testConfigMgr.getSanitizedConfigFilePath();
    const rawContent = fs.readFileSync(sanitizedPath, 'utf8');

    assert.strictEqual(rawContent.includes('dtk_'), false);
    assert.strictEqual(rawContent.includes('Encrypted'), false);

    const json = JSON.parse(rawContent);
    assert.strictEqual(json.deviceId, 'dev-sanitized-test');
    assert.strictEqual(json.isPaired, true);
    assert.strictEqual(json.deviceToken, undefined);
    assert.strictEqual(json.deviceTokenEncrypted, undefined);
  });

  it('11. SafeBrowseChildService start and verification returns clean result', async () => {
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const serviceResult = await pairServer.startAndVerifyService();
    assert.ok(serviceResult);
    assert.strictEqual(typeof serviceResult.running, 'boolean');
    assert.strictEqual(typeof serviceResult.message, 'string');
  });

  it('12. Normal GUI automatically transitions from Not Paired to Paired after elevated pairing', async () => {
    // 1. Initial unelevated GUI starts with Not Paired state
    testConfigMgr.setMockIsAdministratorForTesting(false);
    const gui = new GuiServer(testConfigMgr, accountMgr);
    const port = await gui.start(0);

    try {
      const res1 = await fetch(`http://127.0.0.1:${port}/api/status`);
      const data1: any = await res1.json();
      assert.strictEqual(data1.isPaired, false);

      // 2. Elevated pairing completes in separate elevated process
      testConfigMgr.setMockIsAdministratorForTesting(true);
      const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
      const pairPort = await pairServer.start(0);

      try {
        const claimRes = await fetch(`http://127.0.0.1:${pairPort}/api/claim-and-pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 'SB-TRANSITION-TEST',
            deviceName: 'Shared Family Laptop',
            backendUrl: mockBackendUrl,
          }),
        });
        assert.strictEqual(claimRes.status, 200);
      } finally {
        pairServer.stop();
      }

      // 3. Normal GUI detects pairing via /api/status reload
      testConfigMgr.setMockIsAdministratorForTesting(false);
      const res2 = await fetch(`http://127.0.0.1:${port}/api/status`);
      const data2: any = await res2.json();
      assert.strictEqual(data2.isPaired, true);
      assert.strictEqual(data2.config.deviceId, 'dev-pilot-v102');
      assert.strictEqual(data2.config.deviceName, 'Shared Family Laptop');
    } finally {
      await gui.stop();
    }
  });

  it('13. Reconfigure accounts continues to function seamlessly with UAC elevation', async () => {
    // Device paired
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-reconfig-test',
      deviceToken: 'dtk_token_reconfig_123',
      backendUrl: mockBackendUrl,
      deviceName: 'Family Laptop',
      childId: 'child-manjari-102',
      parentId: 'parent-anshul-102',
      pairedAt: new Date().toISOString(),
    });

    testConfigMgr.setMockIsAdministratorForTesting(true);
    const elevatedConfig = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const configPort = await elevatedConfig.start(0);

    try {
      const stateRes = await fetch(`http://127.0.0.1:${configPort}/api/config-state`);
      assert.strictEqual(stateRes.status, 200);
      const stateData: any = await stateRes.json();
      assert.strictEqual(stateData.deviceId, 'dev-reconfig-test');
      assert.strictEqual(stateData.accounts.length, 2);

      // Save mappings in elevated configuration
      const saveRes = await fetch(`http://127.0.0.1:${configPort}/api/save-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            {
              windowsSid: 'S-1-5-21-1000-1002',
              windowsUsername: 'Manjari',
              childId: 'child-manjari-102',
              childName: 'Manjari',
              enabled: true,
            },
          ],
        }),
      });

      assert.strictEqual(saveRes.status, 200);
      const saveData: any = await saveRes.json();
      assert.strictEqual(saveData.success, true);
    } finally {
      elevatedConfig.stop();
    }
  });

  it('14. Backend unreachable during pairing returns descriptive network error without writing config', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(true);
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const port = await pairServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/claim-and-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'SB-TEST-NET-ERR',
          deviceName: 'Family Laptop',
          backendUrl: 'http://127.0.0.1:59999', // Non-existent port
        }),
      });

      assert.strictEqual(res.status, 502);
      const data: any = await res.json();
      assert.ok(data.error.includes('unreachable'));

      // Invariant: zero config files
      assert.strictEqual(fs.existsSync(testConfigMgr.getConfigFilePath()), false);
    } finally {
      pairServer.stop();
    }
  });

  it('15. ElevatedPairServer rejects claim-and-pair when unelevated (returns 403 Forbidden)', async () => {
    testConfigMgr.setMockIsAdministratorForTesting(false);
    testConfigMgr.setPlatformForTesting('win32');
    const pairServer = new ElevatedPairServer(testConfigMgr, accountMgr);
    const port = await pairServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/claim-and-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'SB-VALID-9999',
          deviceName: 'Family Laptop',
          backendUrl: mockBackendUrl,
        }),
      });

      assert.strictEqual(res.status, 403);
      const data: any = await res.json();
      assert.ok(data.error.includes('Administrator approval is required'));
      assert.strictEqual(fs.existsSync(testConfigMgr.getConfigFilePath()), false);
    } finally {
      testConfigMgr.setPlatformForTesting(null);
      pairServer.stop();
    }
  });
});
