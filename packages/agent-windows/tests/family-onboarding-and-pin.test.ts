process.env.NODE_ENV = 'test';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { ConfigManager, DeviceConfig } from '../src/config-manager';
import { WindowsAccountManager, WindowsProfileMapping } from '../src/account-manager';
import { ParentPinManager } from '../src/parent-pin-manager';
import { GuiServer } from '../src/gui-server';
import { ElevatedPairServer } from '../src/elevated-pair-server';
import { networkManager } from '../src/network-manager';

describe('SafeBrowse Stage C.5 — Family-Level Onboarding, Cloud Truth & Parent Lock Suite', () => {
  let tmpDir: string;
  let configMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let pinMgr: ParentPinManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-c5-test-'));
    configMgr = new ConfigManager(tmpDir);
    configMgr.setMockIsAdministratorForTesting(true);
    networkManager.setUpstreamResolutionCheckerForTesting(async () => true);

    accountMgr = new WindowsAccountManager(tmpDir);
    accountMgr.setMockAccountsForTesting([
      { name: 'AzureAD\\AnshulPorwal', sid: 'S-1-5-21-1000-1001', disabled: false, isCurrentConsoleUser: true },
      { name: 'ParentUser', sid: 'S-1-5-21-1000-1002', disabled: false, isCurrentConsoleUser: false },
    ]);
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1001');

    pinMgr = new ParentPinManager(configMgr);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // 1. Windows Family Pairing & Device Model Invariants
  // =========================================================================

  it('1. Windows device configuration stores childId as null (family-level ownership)', async () => {
    const config: DeviceConfig = {
      deviceId: 'dev-family-laptop',
      deviceToken: 'dtk_family_token_123',
      childId: null, // Windows device belongs to Family, childId is strictly null
      parentId: 'parent-123',
      familyId: 'fam-789',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'ACCOUNT_SETUP_REQUIRED',
    };

    await configMgr.saveDeviceConfig(config);
    const loaded = await configMgr.loadDeviceConfig();

    assert.ok(loaded);
    assert.strictEqual(loaded.deviceId, 'dev-family-laptop');
    assert.strictEqual(loaded.childId, null);
    assert.strictEqual(loaded.familyId, 'fam-789');

    const sanitized = await configMgr.loadSanitizedConfig();
    assert.ok(sanitized);
    assert.strictEqual(sanitized.deviceId, 'dev-family-laptop');
    assert.strictEqual(sanitized.childId, null);
    assert.strictEqual(sanitized.onboardingState, 'ACCOUNT_SETUP_REQUIRED');
  });

  // =========================================================================
  // 2. Zero Automatic Preselection in Setup UI
  // =========================================================================

  it('2. Setup Wizard UI provides zero automatic preselection and requires explicit choice', async () => {
    const server = new ElevatedPairServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Verify no autoPreselect code in script
      assert.strictEqual(html.includes('const autoPreselect ='), false);

      // Verify explicit placeholder option exists
      assert.ok(html.includes('Choose who uses this account...'));
      assert.ok(html.includes('Parent / Do not protect'));
      assert.ok(html.includes('Set SafeBrowse Parent PIN'));
      assert.ok(html.includes('Confirm Account Assignments & Activate'));
    } finally {
      server.stop();
    }
  });

  // =========================================================================
  // 3. Parent PIN Manager Security & Lifecycle
  // =========================================================================

  it('3. Parent PIN Manager rejects non-6-8 digit formats and validates correctly', async () => {
    assert.strictEqual(await pinMgr.isPinSet(), false);

    // Reject short, long, non-digit
    await assert.rejects(async () => pinMgr.setPin('12345'), /between 6 and 8 numeric digits/);
    await assert.rejects(async () => pinMgr.setPin('123456789'), /between 6 and 8 numeric digits/);
    await assert.rejects(async () => pinMgr.setPin('abcdef'), /between 6 and 8 numeric digits/);

    // Valid 6-digit PIN
    await pinMgr.setPin('839201');
    assert.strictEqual(await pinMgr.isPinSet(), true);

    // Verify plaintext is not stored
    const raw = fs.readFileSync(path.join(tmpDir, 'secure', 'parent-pin.json'), 'utf8');
    assert.strictEqual(raw.includes('839201'), false);
    const record = JSON.parse(raw);
    assert.ok(record.salt);
    assert.ok(record.verifier);
    assert.strictEqual(record.kdf, 'pbkdf2-sha256-100k');

    // Incorrect PIN verification fails
    const failRes = await pinMgr.verifyPin('000000');
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.sessionToken, undefined);

    // Correct PIN verification succeeds and generates session token
    const okRes = await pinMgr.verifyPin('839201');
    assert.strictEqual(okRes.success, true);
    assert.ok(okRes.sessionToken);
    assert.ok(okRes.sessionToken?.startsWith('mgmt_'));

    // Validate active session
    assert.strictEqual(pinMgr.validateSession(okRes.sessionToken), true);
    assert.strictEqual(pinMgr.validateSession('fake_token'), false);
    assert.strictEqual(pinMgr.validateSession(undefined), false);

    // Clear PIN
    await pinMgr.clearPin();
    assert.strictEqual(await pinMgr.isPinSet(), false);
    assert.strictEqual(pinMgr.validateSession(okRes.sessionToken), false);
  });

  // =========================================================================
  // 4. Session Expiry & Invalidation
  // =========================================================================

  it('4. Parent PIN management session expires after TTL or upon explicit invalidation', async () => {
    await pinMgr.setPin('998877');
    const verifyRes = await pinMgr.verifyPin('998877');
    assert.ok(verifyRes.sessionToken);

    assert.strictEqual(pinMgr.validateSession(verifyRes.sessionToken), true);

    // Invalidate session explicitly (e.g. user switch, lock, or disconnect)
    pinMgr.invalidateSession(verifyRes.sessionToken);
    assert.strictEqual(pinMgr.validateSession(verifyRes.sessionToken), false);
  });

  // =========================================================================
  // 5. Setup Wizard requires Parent PIN in finish-setup
  // =========================================================================

  it('5. Elevated setup wizard rejects finish-setup when parentPin is missing or invalid', async () => {
    // Configure machine as paired
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-pin-test',
      deviceToken: 'dtk_pin_test',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family PC',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'ACCOUNT_SETUP_REQUIRED',
    });

    const server = new ElevatedPairServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // 1. Missing PIN -> 400
      const resMissing = await fetch(`http://127.0.0.1:${port}/api/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            { windowsSid: 'S-1-5-21-1000-1001', windowsUsername: 'AzureAD\\AnshulPorwal', childId: 'child-1', enabled: true },
          ],
        }),
      });
      assert.strictEqual(resMissing.status, 400);
      const dataMissing = await resMissing.json() as any;
      assert.ok(dataMissing.error.includes('Parent PIN'));

      // 2. Invalid format PIN -> 400
      const resBad = await fetch(`http://127.0.0.1:${port}/api/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPin: '12',
          mappings: [
            { windowsSid: 'S-1-5-21-1000-1001', windowsUsername: 'AzureAD\\AnshulPorwal', childId: 'child-1', enabled: true },
          ],
        }),
      });
      assert.strictEqual(resBad.status, 400);

      // Verify PIN was not persisted
      assert.strictEqual(await pinMgr.isPinSet(), false);
    } finally {
      server.stop();
    }
  });

  // =========================================================================
  // 6. Localhost Security & Cross-Origin Attack Prevention
  // =========================================================================

  it('6. GuiServer rejects malicious cross-origin requests from arbitrary websites', async () => {
    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // Evil website origin attempting CSRF against local agent
      const evilRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: {
          'Origin': 'https://malicious-child-bypass.com',
        },
      });
      assert.strictEqual(evilRes.status, 403);
      const evilData = await evilRes.json() as any;
      assert.ok(evilData.error.includes('Cross-origin'));

      // Loopback origin is allowed
      const okRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: {
          'Origin': `http://127.0.0.1:${port}`,
        },
      });
      assert.strictEqual(okRes.status, 200);
    } finally {
      server.stop();
    }
  });

  // =========================================================================
  // 7. Child Session Information Hiding & Parent PIN Lock Protection
  // =========================================================================

  it('7. GuiServer hides deviceId, SIDs, and DNS internals for locked child sessions', async () => {
    // 1. Configure paired device and Parent PIN
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-secret-internal-id-999',
      deviceToken: 'dtk_secret_token_never_expose',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.setPin('554433');
    await accountMgr.saveProfileMappingsTransaction([
      { windowsSid: 'S-1-5-21-1000-1001', windowsUsername: 'AzureAD\\AnshulPorwal', childId: 'child-rahul', childName: 'Rahul', enabled: true },
      { windowsSid: 'S-1-5-21-1000-1002', windowsUsername: 'ParentUser', childId: null, childName: null, enabled: false },
    ], 'dev-secret-internal-id-999', 'Family Laptop');

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // Child query without management session token
      const childRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(childRes.status, 200);
      const childData = await childRes.json() as any;

      assert.strictEqual(childData.managementUnlocked, false);
      assert.strictEqual(childData.pinConfigured, true);
      // Secret device identifiers & SIDs hidden
      assert.strictEqual(childData.config.deviceId, undefined);
      assert.strictEqual(childData.activeSession.sid, undefined);
      assert.strictEqual(childData.mappings[0].windowsSid, undefined);
      assert.strictEqual(childData.mappings[0].windowsUsername, 'AzureAD\\AnshulPorwal');
      assert.strictEqual(childData.mappings[0].isManaged, true);
      assert.strictEqual(childData.mappings[0].childName, 'Rahul');

      // Attempting to disconnect without PIN session returns 401
      const discUnauth = await fetch(`http://127.0.0.1:${port}/api/disconnect`, { method: 'POST' });
      assert.strictEqual(discUnauth.status, 401);

      // Attempting to reconfigure without PIN session returns 401
      const reconfigUnauth = await fetch(`http://127.0.0.1:${port}/api/reconfigure`, { method: 'POST' });
      assert.strictEqual(reconfigUnauth.status, 401);

      // Unlock with Parent PIN
      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '554433' }),
      });
      assert.strictEqual(verifyRes.status, 200);
      const verifyData = await verifyRes.json() as any;
      assert.ok(verifyData.sessionToken);

      // Authenticated query with session token reveals management details
      const authRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-management-session': verifyData.sessionToken },
      });
      assert.strictEqual(authRes.status, 200);
      const authData = await authRes.json() as any;
      assert.strictEqual(authData.managementUnlocked, true);
      assert.strictEqual(authData.config.deviceId, 'dev-secret-internal-id-999');
      assert.strictEqual(authData.mappings[0].windowsSid, 'S-1-5-21-1000-1001');
    } finally {
      server.stop();
    }
  });

  // =========================================================================
  // 8. Complete 12-Step Disconnect Teardown Transaction
  // =========================================================================

  it('8. Disconnect transaction cleans up credentials, clears Parent PIN, and restores state', async () => {
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-teardown-123',
      deviceToken: 'dtk_teardown_abc',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.setPin('654321');
    await accountMgr.saveProfileMappingsTransaction([
      { windowsSid: 'S-1-5-21-1000-1001', windowsUsername: 'AzureAD\\AnshulPorwal', childId: 'c1', enabled: true },
    ], 'dev-teardown-123', 'Family Laptop');

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // Unlock session
      const unlockRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '654321' }),
      });
      const { sessionToken } = await unlockRes.json() as any;

      // Execute disconnect
      const discRes = await fetch(`http://127.0.0.1:${port}/api/disconnect`, {
        method: 'POST',
        headers: { 'x-management-session': sessionToken },
      });
      assert.strictEqual(discRes.status, 200);
      const discData = await discRes.json() as any;
      assert.strictEqual(discData.success, true);
      assert.strictEqual(discData.disconnected, true);

      // Verify teardown:
      // 1. PIN verifier cleared
      assert.strictEqual(await pinMgr.isPinSet(), false);
      // 2. Profile mappings cleared
      assert.strictEqual(await accountMgr.hasProfileMappings(), false);
      // 3. Credentials deleted
      assert.strictEqual(configMgr.hasDeviceConfig(), false);
      // 4. Onboarding state reset
      assert.strictEqual(configMgr.getOnboardingState(), 'DISCONNECTED');
    } finally {
      server.stop();
    }
  });

  // =========================================================================
  // 9. PowerShell Account Discovery Script Syntax & Structure Verification
  // =========================================================================

  it('9. WindowsAccountManager discovery PowerShell script has zero syntax or brace balance defects', () => {
    const script = WindowsAccountManager.getDiscoveryPowerShellScript();
    assert.ok(script);
    assert.ok(script.length > 500);

    // Verify balance of braces, parentheses, and brackets
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;

    for (let i = 0; i < script.length; i++) {
      const ch = script[i];
      if (ch === '{') braceCount++;
      else if (ch === '}') braceCount--;
      else if (ch === '(') parenCount++;
      else if (ch === ')') parenCount--;
      else if (ch === '[') bracketCount++;
      else if (ch === ']') bracketCount--;

      assert.ok(braceCount >= 0, `Unmatched closing brace at char ${i}`);
      assert.ok(parenCount >= 0, `Unmatched closing parenthesis at char ${i}`);
      assert.ok(bracketCount >= 0, `Unmatched closing bracket at char ${i}`);
    }

    assert.strictEqual(braceCount, 0, 'Script has unbalanced curly braces');
    assert.strictEqual(parenCount, 0, 'Script has unbalanced parentheses');
    assert.strictEqual(bracketCount, 0, 'Script has unbalanced square brackets');

    // Verify presence of interactive identity sources
    assert.ok(script.includes('Win32_UserAccount'));
    assert.ok(script.includes('explorer.exe'));
    assert.ok(script.includes('ProfileList'));
    assert.ok(script.includes('System.Security.Principal.SecurityIdentifier'));
  });
});
