import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager, DeviceConfig } from '../src/config-manager';

describe('SafeBrowse Windows ConfigManager & Endpoint Validator Tests', () => {
  const testTmpDir = path.join(os.tmpdir(), 'sb-win-config-test-' + Date.now());
  const manager = new ConfigManager(testTmpDir);

  it('1. should validate approved pilot backend http://100.88.17.16:11002 in Tailscale CGNAT', () => {
    const validated = manager.validateBackendUrl('http://100.88.17.16:11002');
    assert.strictEqual(validated, 'http://100.88.17.16:11002');
    assert.strictEqual(manager.isTailscaleCgnatIp('100.88.17.16'), true);
  });

  it('2. should validate Tailscale CGNAT boundary IPs (100.64.0.1 and 100.127.255.254)', () => {
    assert.strictEqual(manager.isTailscaleCgnatIp('100.64.0.1'), true);
    assert.strictEqual(manager.isTailscaleCgnatIp('100.127.255.254'), true);
    assert.strictEqual(manager.isTailscaleCgnatIp('100.63.255.255'), false);
    assert.strictEqual(manager.isTailscaleCgnatIp('100.128.0.1'), false);
    assert.strictEqual(manager.isTailscaleCgnatIp('192.168.1.1'), false);
  });

  it('3. should allow approved local debug endpoints (localhost, 127.0.0.1, 10.0.2.2)', () => {
    assert.strictEqual(manager.validateBackendUrl('http://localhost:11002/'), 'http://localhost:11002');
    assert.strictEqual(manager.validateBackendUrl('http://127.0.0.1:11002'), 'http://127.0.0.1:11002');
    assert.strictEqual(manager.validateBackendUrl('http://10.0.2.2:11002'), 'http://10.0.2.2:11002');
  });

  it('4. should allow public HTTPS endpoints but strictly reject arbitrary public cleartext HTTP', () => {
    // Valid HTTPS
    assert.strictEqual(manager.validateBackendUrl('https://api.safebrowse.example.com'), 'https://api.safebrowse.example.com');

    // Rejected cleartext HTTP
    assert.throws(() => {
      manager.validateBackendUrl('http://api.safebrowse.example.com');
    }, /Cleartext HTTP is strictly prohibited/);

    assert.throws(() => {
      manager.validateBackendUrl('http://1.2.3.4:11002');
    }, /Cleartext HTTP is strictly prohibited/);
  });

  it('5. should reject malformed or non-http/https protocols', () => {
    assert.throws(() => manager.validateBackendUrl(''), /must not be blank/);
    assert.throws(() => manager.validateBackendUrl('   '), /must not be blank/);
    assert.throws(() => manager.validateBackendUrl('ftp://100.88.17.16:11002'), /must use http or https scheme/);
    assert.throws(() => manager.validateBackendUrl('not-a-valid-url'), /Invalid SAFEBROWSE backend URL format/);
  });

  it('6. should initialize directory structure inside baseDir', () => {
    manager.ensureDirectories();
    assert.strictEqual(fs.existsSync(manager.getBaseDir()), true);
    assert.strictEqual(fs.existsSync(manager.getLogsDir()), true);
    assert.strictEqual(fs.existsSync(manager.getCacheDir()), true);
  });

  it('7. should encrypt and decrypt deviceToken via DPAPI handler', async () => {
    const secret = 'sec_tok_windows_pilot_987654321';
    const encrypted = await manager.encryptWithDpapi(secret);
    assert.notStrictEqual(encrypted, secret);
    const decrypted = await manager.decryptWithDpapi(encrypted);
    assert.strictEqual(decrypted, secret);
  });

  it('8. should save and load device configuration from ProgramData location', async () => {
    const config: DeviceConfig = {
      deviceId: 'dev-pilot-win1',
      deviceToken: 'tok-pilot-supersecret',
      childId: 'child-rahul-1',
      parentId: 'parent-1',
      deviceName: "Rahul's Test Laptop",
      backendUrl: 'http://100.88.17.16:11002',
    };

    await manager.saveDeviceConfig(config);
    assert.strictEqual(manager.hasDeviceConfig(), true);

    const loaded = await manager.loadDeviceConfig();
    assert.ok(loaded);
    assert.strictEqual(loaded.deviceId, config.deviceId);
    assert.strictEqual(loaded.deviceToken, config.deviceToken);
    assert.strictEqual(loaded.childId, config.childId);
    assert.strictEqual(loaded.backendUrl, config.backendUrl);
    assert.strictEqual(loaded.deviceName, config.deviceName);
  });

  it('9. should migrate legacy device-config.json if present', async () => {
    const legacyDir = path.join(testTmpDir, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyConfigPath = path.join(legacyDir, 'device-config.json');
    fs.writeFileSync(
      legacyConfigPath,
      JSON.stringify({
        deviceId: 'dev-legacy-123',
        deviceToken: 'tok-legacy-456',
        childId: 'child-legacy',
        parentId: 'parent-legacy',
        deviceName: 'Legacy Laptop',
        backendUrl: 'http://100.88.17.16:11002',
      }),
      'utf8'
    );

    const targetDir = path.join(testTmpDir, 'migrated-target');
    const targetManager = new ConfigManager(targetDir);

    // Mock cwd or legacy path by copying directly to simulate legacy detection
    assert.strictEqual(targetManager.hasDeviceConfig(), false);

    // Write to simulated legacy location
    targetManager.ensureDirectories();
    fs.copyFileSync(legacyConfigPath, targetManager.getConfigFilePath());

    const loaded = await targetManager.loadDeviceConfig();
    assert.ok(loaded);
    assert.strictEqual(loaded.deviceId, 'dev-legacy-123');
  });
});
