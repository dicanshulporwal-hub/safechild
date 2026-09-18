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

  it('8. should encrypt and decrypt token containing spaces', async () => {
    const secretWithSpaces = 'sec tok windows pilot token with spaces 12345';
    const encrypted = await manager.encryptWithDpapi(secretWithSpaces);
    assert.notStrictEqual(encrypted, secretWithSpaces);
    const decrypted = await manager.decryptWithDpapi(encrypted);
    assert.strictEqual(decrypted, secretWithSpaces);
  });

  it('9. should encrypt and decrypt token containing quote characters (single and double quotes)', async () => {
    const secretWithQuotes = 'sec_tok_"double_quote"_and_\'single_quote\'_test';
    const encrypted = await manager.encryptWithDpapi(secretWithQuotes);
    assert.notStrictEqual(encrypted, secretWithQuotes);
    const decrypted = await manager.decryptWithDpapi(encrypted);
    assert.strictEqual(decrypted, secretWithQuotes);
  });

  it('10. should encrypt and decrypt token containing dollar signs ($)', async () => {
    const secretWithDollar = 'sec_tok_$variable_$100_${env:PATH}_$val';
    const encrypted = await manager.encryptWithDpapi(secretWithDollar);
    assert.notStrictEqual(encrypted, secretWithDollar);
    const decrypted = await manager.decryptWithDpapi(encrypted);
    assert.strictEqual(decrypted, secretWithDollar);
  });

  it('11. should encrypt and decrypt token containing ampersands (&)', async () => {
    const secretWithAmpersand = 'sec_tok_foo&bar&&baz&cmd=true';
    const encrypted = await manager.encryptWithDpapi(secretWithAmpersand);
    assert.notStrictEqual(encrypted, secretWithAmpersand);
    const decrypted = await manager.decryptWithDpapi(encrypted);
    assert.strictEqual(decrypted, secretWithAmpersand);
  });

  it('12. should encrypt and decrypt token containing unicode, symbols, and parentheses', async () => {
    const secretWithUnicode = 'sec_tok_日本語_🚀_(parentheses)_§_éèç_123';
    const encrypted = await manager.encryptWithDpapi(secretWithUnicode);
    assert.notStrictEqual(encrypted, secretWithUnicode);
    const decrypted = await manager.decryptWithDpapi(encrypted);
    assert.strictEqual(decrypted, secretWithUnicode);
  });

  it('13. should construct safe PowerShell DPAPI script using base64 without unquoted secrets or double quotes around secrets', () => {
    const rawSecret = 'sec_tok_windows_pilot_987654321';
    const expectedBase64 = Buffer.from(rawSecret, 'utf8').toString('base64');
    const encryptScript = manager.getDpapiEncryptScript(rawSecret);

    // Verify it uses FromBase64String with the base64-encoded token in single quotes
    assert.ok(encryptScript.includes(`[System.Convert]::FromBase64String('${expectedBase64}')`));

    // Verify it does NOT contain raw secret text or unquoted tokens
    assert.strictEqual(encryptScript.includes(rawSecret), false);
    assert.strictEqual(encryptScript.includes(`GetBytes(${rawSecret})`), false);
    assert.strictEqual(encryptScript.includes(`GetBytes("${rawSecret}")`), false);

    // Verify it protects with LocalMachine scope
    assert.ok(encryptScript.includes('[System.Security.Cryptography.DataProtectionScope]::LocalMachine'));

    // Verify it returns base64 ciphertext
    assert.ok(encryptScript.includes('[System.Convert]::ToBase64String($enc)'));

    // Verify decryption script structure
    const sampleCipher = 'dGVzdGNpcGhlcg==';
    const decryptScript = manager.getDpapiDecryptScript(sampleCipher);
    assert.ok(decryptScript.includes(`[System.Convert]::FromBase64String('${sampleCipher}')`));
    assert.ok(decryptScript.includes('[System.Security.Cryptography.ProtectedData]::Unprotect('));
    assert.ok(decryptScript.includes('[System.Security.Cryptography.DataProtectionScope]::LocalMachine'));
    assert.ok(decryptScript.includes('[System.Convert]::ToBase64String($bytes)'));
  });

  it('14. should save device configuration omitting plaintext token on disk and load with decrypted token', async () => {
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

    // Verify persisted JSON on disk strictly omits plaintext deviceToken
    const rawOnDisk = fs.readFileSync(manager.getConfigFilePath(), 'utf8');
    const parsedOnDisk = JSON.parse(rawOnDisk);
    assert.strictEqual(parsedOnDisk.deviceToken, undefined);
    assert.strictEqual(rawOnDisk.includes('"deviceToken":'), false);
    assert.strictEqual(rawOnDisk.includes('tok-pilot-supersecret'), false);
    assert.ok(parsedOnDisk.deviceTokenEncrypted);

    // Verify loaded config contains decrypted deviceToken in memory
    const loaded = await manager.loadDeviceConfig();
    assert.ok(loaded);
    assert.strictEqual(loaded.deviceId, config.deviceId);
    assert.strictEqual(loaded.deviceToken, config.deviceToken);
    assert.strictEqual(loaded.childId, config.childId);
    assert.strictEqual(loaded.backendUrl, config.backendUrl);
    assert.strictEqual(loaded.deviceName, config.deviceName);
  });

  it('15. should enforce Windows fail-closed security: never persist plaintext deviceToken on encryption failure', async () => {
    const failTmpDir = path.join(os.tmpdir(), 'sb-win-fail-test-' + Date.now());
    const failManager = new ConfigManager(failTmpDir);
    failManager.setPlatformForTesting('win32');

    // Simulate encryption failure (e.g. DPAPI failure or unhandled error)
    failManager.encryptWithDpapi = async () => {
      throw new Error('Simulated DPAPI hardware failure');
    };

    const config: DeviceConfig = {
      deviceId: 'dev-pilot-fail',
      deviceToken: 'super-secret-token-should-never-be-saved',
      childId: 'child-1',
      parentId: 'parent-1',
      deviceName: 'Fail Test Laptop',
      backendUrl: 'http://100.88.17.16:11002',
    };

    await assert.rejects(
      async () => {
        await failManager.saveDeviceConfig(config);
      },
      /Simulated DPAPI hardware failure/
    );

    // Confirm that no config file was written to disk with plaintext token
    assert.strictEqual(fs.existsSync(failManager.getConfigFilePath()), false);
  });

  it('16. should enforce Windows fail-closed security: reject unencrypted or corrupted config on load', async () => {
    const winSecTmpDir = path.join(os.tmpdir(), 'sb-win-sec-test-' + Date.now());
    const winSecManager = new ConfigManager(winSecTmpDir);
    winSecManager.setPlatformForTesting('win32');
    winSecManager.ensureDirectories();

    // 1. Config with only plaintext deviceToken and missing deviceTokenEncrypted
    fs.writeFileSync(
      winSecManager.getConfigFilePath(),
      JSON.stringify({
        deviceId: 'dev-insecure',
        deviceToken: 'plaintext-token-must-be-rejected',
        childId: 'child-1',
        parentId: 'parent-1',
        deviceName: 'Insecure Laptop',
        backendUrl: 'http://100.88.17.16:11002',
      }),
      'utf8'
    );

    const loadedInsecure = await winSecManager.loadDeviceConfig();
    assert.strictEqual(loadedInsecure, null, 'Must reject configuration lacking deviceTokenEncrypted on Windows');

    // 2. Config with invalid/un-decryptable deviceTokenEncrypted
    fs.writeFileSync(
      winSecManager.getConfigFilePath(),
      JSON.stringify({
        deviceId: 'dev-corrupt',
        deviceToken: 'fallback-token-must-not-be-used',
        deviceTokenEncrypted: 'corrupt-ciphertext',
        childId: 'child-1',
        parentId: 'parent-1',
        deviceName: 'Corrupt Laptop',
        backendUrl: 'http://100.88.17.16:11002',
      }),
      'utf8'
    );

    winSecManager.decryptWithDpapi = async () => {
      throw new Error('DPAPI Unprotect failed: key not found');
    };

    const loadedCorrupt = await winSecManager.loadDeviceConfig();
    assert.strictEqual(loadedCorrupt, null, 'Must never fall back to plaintext token on Windows decryption failure');
  });

  it('17. should migrate legacy config, encrypt token, delete plaintext, and remove legacy file after target exists', async () => {
    const legacyDir = path.join(testTmpDir, 'legacy-mig');
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

    assert.strictEqual(targetManager.hasDeviceConfig(), false);
    assert.strictEqual(fs.existsSync(legacyConfigPath), true);

    // Perform migration using explicit legacy path
    const migrated = await targetManager.migrateLegacyConfigIfPresent(legacyConfigPath);
    assert.strictEqual(migrated, true);

    // Target file must exist now
    assert.strictEqual(targetManager.hasDeviceConfig(), true);

    // Legacy file must have been unlinked after successful target creation
    assert.strictEqual(fs.existsSync(legacyConfigPath), false);

    // Target file on disk must have deviceTokenEncrypted and NO plaintext deviceToken
    const rawTarget = fs.readFileSync(targetManager.getConfigFilePath(), 'utf8');
    const parsedTarget = JSON.parse(rawTarget);
    assert.strictEqual(parsedTarget.deviceToken, undefined);
    assert.strictEqual(rawTarget.includes('"deviceToken":'), false);
    assert.strictEqual(rawTarget.includes('tok-legacy-456'), false);
    assert.ok(parsedTarget.deviceTokenEncrypted);
    assert.ok(parsedTarget.migratedAt);

    // Target manager must load configuration successfully with decrypted token
    const loaded = await targetManager.loadDeviceConfig();
    assert.ok(loaded);
    assert.strictEqual(loaded.deviceId, 'dev-legacy-123');
    assert.strictEqual(loaded.deviceToken, 'tok-legacy-456');
  });

  it('18. should not delete legacy file if migration fails before writing target', async () => {
    const failLegacyDir = path.join(testTmpDir, 'legacy-fail');
    fs.mkdirSync(failLegacyDir, { recursive: true });
    const legacyConfigPath = path.join(failLegacyDir, 'device-config.json');
    fs.writeFileSync(
      legacyConfigPath,
      JSON.stringify({
        deviceId: 'dev-legacy-preserve',
        deviceToken: 'tok-legacy-preserve-456',
      }),
      'utf8'
    );

    const failTargetDir = path.join(testTmpDir, 'migrated-fail-target');
    const failTargetManager = new ConfigManager(failTargetDir);

    // Simulate failure during token encryption
    failTargetManager.encryptWithDpapi = async () => {
      throw new Error('Encryption error during migration');
    };

    const migrated = await failTargetManager.migrateLegacyConfigIfPresent(legacyConfigPath);
    assert.strictEqual(migrated, false);

    // Legacy file must NOT be deleted
    assert.strictEqual(fs.existsSync(legacyConfigPath), true);
    assert.strictEqual(fs.existsSync(failTargetManager.getConfigFilePath()), false);
  });

  it('19. should verify Windows persisted config never contains "deviceToken": "<plaintext>" under Windows platform mode', async () => {
    const winPersistDir = path.join(os.tmpdir(), 'sb-win-persist-test-' + Date.now());
    const winManager = new ConfigManager(winPersistDir);
    winManager.setPlatformForTesting('win32');

    const config: DeviceConfig = {
      deviceId: 'dev-win-enforce',
      deviceToken: 'super-confidential-device-credential-999',
      childId: 'child-win',
      parentId: 'parent-win',
      deviceName: 'Enforced Windows PC',
      backendUrl: 'http://100.88.17.16:11002',
    };

    await winManager.saveDeviceConfig(config);

    const rawPersisted = fs.readFileSync(winManager.getConfigFilePath(), 'utf8');
    assert.strictEqual(rawPersisted.includes('"deviceToken":'), false, 'Persisted file must never contain plaintext deviceToken key');
    assert.strictEqual(rawPersisted.includes('super-confidential-device-credential-999'), false, 'Persisted file must never contain plaintext secret string');

    const parsedPersisted = JSON.parse(rawPersisted);
    assert.strictEqual(parsedPersisted.deviceToken, undefined);
    assert.ok(parsedPersisted.deviceTokenEncrypted);

    // Verify round-trip load
    const loaded = await winManager.loadDeviceConfig();
    assert.ok(loaded);
    assert.strictEqual(loaded.deviceToken, 'super-confidential-device-credential-999');
  });

  it('20. should construct secure Windows ACL command: SYSTEM & Administrators Full Control, /inheritance:r, and no Users RX', () => {
    const testDir = 'C:\\ProgramData\\SafeBrowse';
    const aclCmd = manager.getWindowsAclCommand(testDir);

    // 1. Must remove inherited permissive ACLs from ProgramData
    assert.ok(aclCmd.includes('/inheritance:r'), 'Must remove inherited permissions with /inheritance:r');

    // 2. Must explicitly grant SYSTEM Full Control with Object & Container inheritance
    assert.ok(
      aclCmd.includes('"SYSTEM":(OI)(CI)F') || (aclCmd.includes('SYSTEM') && aclCmd.includes('(OI)(CI)F')),
      'Must grant SYSTEM Full Control with (OI)(CI)F'
    );

    // 3. Must explicitly grant BUILTIN\\Administrators Full Control with Object & Container inheritance
    assert.ok(
      aclCmd.includes('Administrators') && aclCmd.includes('(OI)(CI)F'),
      'Must grant Administrators Full Control with (OI)(CI)F'
    );

    // 4. Must strictly NOT include Users RX or any Users permission grant
    assert.strictEqual(aclCmd.includes('Users":(OI)(CI)RX'), false, 'Must NOT grant Users:(OI)(CI)RX');
    assert.strictEqual(aclCmd.includes('Users:RX'), false, 'Must NOT grant Users:RX');
    assert.strictEqual(aclCmd.includes('/grant:r "Users"'), false, 'Must NOT grant permissions to Users');
    assert.strictEqual(aclCmd.includes('/grant "Users"'), false, 'Must NOT grant permissions to Users');
    assert.strictEqual(aclCmd.includes('Authenticated Users'), false, 'Must NOT grant permissions to Authenticated Users');

    // 5. Must explicitly remove any existing granted permissions for Users
    assert.ok(aclCmd.includes('/remove:g "Users"'), 'Must explicitly remove existing Users grant');
  });

  it('21. should enforce Windows fail-closed security: abort credential save if Windows ACL enforcement fails', async () => {
    const aclFailDir = path.join(os.tmpdir(), 'sb-win-acl-fail-' + Date.now());
    const aclFailManager = new ConfigManager(aclFailDir);
    aclFailManager.setPlatformForTesting('win32');

    // Simulate Windows ACL setup failure (e.g. icacls execution error or access denied)
    aclFailManager.setAclExecutorForTesting((_cmd: string) => {
      throw new Error('Simulated icacls failure: Access is denied (Error 5)');
    });

    const config: DeviceConfig = {
      deviceId: 'dev-acl-fail',
      deviceToken: 'secret-token-should-not-persist-on-acl-fail',
      childId: 'child-1',
      parentId: 'parent-1',
      deviceName: 'ACL Fail Laptop',
      backendUrl: 'http://100.88.17.16:11002',
    };

    await assert.rejects(
      async () => {
        await aclFailManager.saveDeviceConfig(config);
      },
      /Failed to secure Windows directory permissions|Simulated icacls failure/
    );

    // Verify config file was NOT created
    assert.strictEqual(fs.existsSync(aclFailManager.getConfigFilePath()), false);
  });
});
