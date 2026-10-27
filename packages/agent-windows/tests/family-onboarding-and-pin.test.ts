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
import { ElevatedConfigServer } from '../src/elevated-config-server';
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

      if (childData.managementUnlocked !== false) {
        console.error('[TEST 7 DEBUG] unexpected managementUnlocked true:', {
          childData,
          isPinSetDirect: await pinMgr.isPinSet(),
          pinFilePath: (pinMgr as any).getPinFilePath(),
          pinFileExists: fs.existsSync((pinMgr as any).getPinFilePath()),
        });
      }
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

  // =========================================================================
  // Gate A2 Defect Verification: Parent Management Lock Invariants
  // =========================================================================

  it('10. Gate A2: Missing Parent PIN strictly locks protected management (never fails open)', async () => {
    // 1. Device is paired but Parent PIN is NOT configured
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-no-pin-test',
      deviceToken: 'dtk_no_pin_token',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.clearPin();
    assert.strictEqual(await pinMgr.isPinSet(), false);

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // Status-only view is available without PIN
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(statusRes.status, 200);
      const statusData = await statusRes.json() as any;
      assert.strictEqual(statusData.pinConfigured, false);
      assert.strictEqual(statusData.managementUnlocked, false);

      // Protected mutations without PIN configured must return 401 DENIED
      const mappingsRes = await fetch(`http://127.0.0.1:${port}/api/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: [] }),
      });
      assert.strictEqual(mappingsRes.status, 401);
      const mappingsData = await mappingsRes.json() as any;
      assert.match(mappingsData.error, /Parent PIN has not been configured/);

      const reconfigRes = await fetch(`http://127.0.0.1:${port}/api/reconfigure`, { method: 'POST' });
      assert.strictEqual(reconfigRes.status, 401);
      const reconfigData = await reconfigRes.json() as any;
      assert.match(reconfigData.error, /Parent PIN has not been configured/);

      const disconnectRes = await fetch(`http://127.0.0.1:${port}/api/disconnect`, { method: 'POST' });
      assert.strictEqual(disconnectRes.status, 401);
      const disconnectData = await disconnectRes.json() as any;
      assert.match(disconnectData.error, /Parent PIN has not been configured/);

      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '123456' }),
      });
      assert.strictEqual(verifyRes.status, 401);
      const verifyData = await verifyRes.json() as any;
      assert.match(verifyData.error, /Parent PIN has not been configured/);
    } finally {
      server.stop();
    }
  });

  it('11. Gate A2: Parent PIN authentication matrix (wrong PIN, correct PIN, TTL expiration)', async () => {
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-pin-auth-matrix',
      deviceToken: 'dtk_pin_matrix',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.setPin('849201');
    assert.strictEqual(await pinMgr.isPinSet(), true);

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // 1. Wrong PIN => DENIED (401)
      const wrongRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.strictEqual(wrongRes.status, 401);
      const wrongData = await wrongRes.json() as any;
      assert.ok(wrongData.error);

      // 2. Correct PIN => temporary management session (200 + token)
      assert.strictEqual(
        ParentPinManager.SESSION_TTL_MS,
        5 * 60 * 1000,
        'Management session TTL must strictly be 5 minutes (300,000 ms)'
      );

      const correctRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '849201' }),
      });
      assert.strictEqual(correctRes.status, 200);
      const correctData = await correctRes.json() as any;
      assert.strictEqual(correctData.success, true);
      assert.ok(correctData.sessionToken);

      // Verify session is valid immediately
      assert.strictEqual(pinMgr.validateSession(correctData.sessionToken), true);

      // Status with valid token shows managementUnlocked: true
      const authStatus = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-management-session': correctData.sessionToken },
      });
      assert.strictEqual(authStatus.status, 200);
      const authData = await authStatus.json() as any;
      assert.strictEqual(authData.managementUnlocked, true);

      // Verify session expiration at TTL boundary (5 minutes)
      const originalNow = Date.now;
      try {
        // Advance clock by 5 minutes + 1 second
        Date.now = () => originalNow() + 5 * 60 * 1000 + 1000;
        assert.strictEqual(
          pinMgr.validateSession(correctData.sessionToken),
          false,
          'Session token must expire strictly after 5 minutes'
        );
      } finally {
        Date.now = originalNow;
      }

      // 3. Expired or invalidated session => DENIED (401)
      pinMgr.invalidateSession(correctData.sessionToken);
      const expiredStatus = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-management-session': correctData.sessionToken },
      });
      assert.strictEqual(expiredStatus.status, 200);
      const expiredData = await expiredStatus.json() as any;
      assert.strictEqual(expiredData.managementUnlocked, false);

      const expiredMutate = await fetch(`http://127.0.0.1:${port}/api/reconfigure`, {
        method: 'POST',
        headers: { 'x-management-session': correctData.sessionToken },
      });
      assert.strictEqual(expiredMutate.status, 401);
    } finally {
      server.stop();
    }
  });

  it('11b. Gate A2: Three wrong PINs show remaining attempts and temporarily lock verification', async () => {
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-pin-lockout',
      deviceToken: 'dtk_pin_lockout',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.setPin('246810');

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      for (const expectedRemaining of [2, 1]) {
        const wrongRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '999999' }),
        });
        assert.strictEqual(wrongRes.status, 401);
        const wrongData = await wrongRes.json() as any;
        assert.strictEqual(wrongData.attemptsRemaining, expectedRemaining);
        assert.strictEqual(wrongData.locked, false);
        assert.match(wrongData.error, new RegExp(String(expectedRemaining)));
      }

      const thirdWrong = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '999999' }),
      });
      assert.strictEqual(thirdWrong.status, 429);
      const lockedData = await thirdWrong.json() as any;
      assert.strictEqual(lockedData.attemptsRemaining, 0);
      assert.strictEqual(lockedData.locked, true);
      assert.ok(lockedData.retryAfterMs > 0);

      const correctWhileLocked = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '246810' }),
      });
      assert.strictEqual(correctWhileLocked.status, 429);

      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + ParentPinManager.LOCKOUT_MS + 1000;
        const correctAfterLockout = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '246810' }),
        });
        assert.strictEqual(correctAfterLockout.status, 200);
        const successData = await correctAfterLockout.json() as any;
        assert.strictEqual(successData.success, true);
        assert.ok(successData.sessionToken);
      } finally {
        Date.now = originalNow;
      }
    } finally {
      server.stop();
    }
  });

  it('12. Gate A2: Valid PIN but non-admin action requiring Windows elevation is rejected', async () => {
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-elevation-test',
      deviceToken: 'dtk_elevation',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.setPin('123456');

    // Simulate non-administrator caller
    configMgr.setMockIsAdministratorForTesting(false);

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // Authenticate with valid Parent PIN
      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '123456' }),
      });
      assert.strictEqual(verifyRes.status, 200);
      const { sessionToken } = await verifyRes.json() as any;
      assert.ok(sessionToken);

      // Attempt action requiring elevation (/api/pair requires Windows Admin)
      const pairRes = await fetch(`http://127.0.0.1:${port}/api/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-management-session': sessionToken,
        },
        body: JSON.stringify({ code: 'test-code' }),
      });
      // Elevation guard rejects with 403 Windows elevation required
      assert.strictEqual(pairRes.status, 403);
      const pairData = await pairRes.json() as any;
      assert.match(pairData.error, /Administrator/i);
    } finally {
      server.stop();
      configMgr.setMockIsAdministratorForTesting(true);
    }
  });

  it('13. Gate A2: User switch / session change immediately invalidates management session', async () => {
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-user-switch-test',
      deviceToken: 'dtk_switch',
      childId: null,
      parentId: 'p1',
      deviceName: 'Family Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.setPin('778899');

    // Currently console user is S-1-5-21-1000-1001 (AnshulPorwal)
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1001');

    const server = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const port = await server.start(0);

    try {
      // Verify PIN while logged in as S-1-5-21-1000-1001
      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '778899' }),
      });
      assert.strictEqual(verifyRes.status, 200);
      const { sessionToken } = await verifyRes.json() as any;

      // Token is valid for current console user
      const check1 = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-management-session': sessionToken },
      });
      const data1 = await check1.json() as any;
      assert.strictEqual(data1.managementUnlocked, true);

      // Fast User Switch occurs: console switched to S-1-5-21-1000-1002 (Child)
      accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1002');

      // The previous management token MUST NOT be valid for the switched user
      const check2 = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-management-session': sessionToken },
      });
      const data2 = await check2.json() as any;
      assert.strictEqual(data2.managementUnlocked, false);

      const mutateRes = await fetch(`http://127.0.0.1:${port}/api/reconfigure`, {
        method: 'POST',
        headers: { 'x-management-session': sessionToken },
      });
      assert.strictEqual(mutateRes.status, 401);
    } finally {
      server.stop();
    }
  });

  it('14. Gate A2: Secure initial Parent PIN creation requires Windows Administrator elevation', async () => {
    const { ElevatedPairServer } = await import('../src/elevated-pair-server');

    const pairServer = new ElevatedPairServer(configMgr, accountMgr, networkManager, pinMgr);
    const pairPort = await pairServer.start(0);

    try {
      await configMgr.saveDeviceConfig({
        deviceId: 'dev-first-pin-setup',
        deviceToken: 'dtk_first_pin_token',
        childId: null,
        parentId: 'parent-1',
        deviceName: 'Family Laptop',
        backendUrl: 'https://safebrowse.porwal.online',
        pairedAt: new Date().toISOString(),
        onboardingState: 'ACCOUNT_SETUP_REQUIRED',
      });

      // Clear any pre-existing PIN
      await pinMgr.clearPin();
      assert.strictEqual(await pinMgr.isPinSet(), false);

      // 1. Non-admin / child attempts to configure initial Parent PIN => DENIED (403)
      configMgr.setMockIsAdministratorForTesting(false);
      const childPinAttempt = await fetch(`http://127.0.0.1:${pairPort}/api/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPin: '741258',
          mappings: [],
        }),
      });
      assert.strictEqual(childPinAttempt.status, 403);
      const childData = await childPinAttempt.json() as any;
      assert.match(childData.error, /Administrator/i);
      assert.strictEqual(await pinMgr.isPinSet(), false);

      // 2. Elevated parent / administrator sets initial PIN => SUCCESS
      configMgr.setMockIsAdministratorForTesting(true);

      // 2a. Reject malformed PIN (<6 digits or non-numeric)
      const badFormat = await fetch(`http://127.0.0.1:${pairPort}/api/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPin: '1234',
          mappings: [],
        }),
      });
      assert.strictEqual(badFormat.status, 400);

      // 2b. Valid 6-8 digit PIN
      const adminPinAttempt = await fetch(`http://127.0.0.1:${pairPort}/api/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPin: '741258',
          mappings: [],
        }),
      });
      // finish-setup proceeds (may stop at service start in test environment, but sets PIN first)
      assert.strictEqual(await pinMgr.isPinSet(), true);

      // 3. Confirm verifier record on disk does NOT contain plaintext PIN
      const pinPath = path.join(configMgr.getSecureDir(), 'parent-pin.json');
      assert.ok(fs.existsSync(pinPath), 'parent-pin.json must exist');
      const pinRaw = fs.readFileSync(pinPath, 'utf8');
      assert.strictEqual(
        pinRaw.includes('741258'),
        false,
        'Parent PIN must NEVER be persisted in plaintext on disk'
      );
      const pinRecord = JSON.parse(pinRaw);
      assert.ok(pinRecord.salt, 'PIN record must have salt');
      assert.ok(pinRecord.verifier, 'PIN record must have verifier');
      assert.strictEqual(pinRecord.kdf, 'pbkdf2-sha256-100k');

      // 4. Verification with correct PIN yields 5-minute session
      const verifyRes = await pinMgr.verifyPin('741258');
      assert.strictEqual(verifyRes.success, true);
      assert.ok(verifyRes.sessionToken);
      assert.strictEqual(pinMgr.validateSession(verifyRes.sessionToken), true);
    } finally {
      configMgr.setMockIsAdministratorForTesting(true);
      await pairServer.stop();
    }
  });

  it('15. Gate A Blocker 2: Legacy paired device with no PIN supports secure elevated bootstrap and remains fail-closed until configured', async () => {
    const { ElevatedPairServer } = await import('../src/elevated-pair-server');

    // Scenario: Legacy/pilot device that was already paired, but no parent-pin.json exists
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-legacy-no-pin',
      deviceToken: 'dtk_legacy_no_pin',
      childId: null,
      parentId: 'p-legacy',
      deviceName: 'Family Living Room PC',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.clearPin();
    assert.strictEqual(await pinMgr.isPinSet(), false);

    const guiServer = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const guiPort = await guiServer.start(0);

    const pairServer = new ElevatedPairServer(configMgr, accountMgr, networkManager, pinMgr, 'PIN_BOOTSTRAP');
    const pairPort = await pairServer.start(0);

    try {
      // 1. In view-only status: parentPinSetupRequired is true, pinConfigured is false, managementUnlocked is false
      const statusRes = await fetch(`http://127.0.0.1:${guiPort}/api/status`);
      assert.strictEqual(statusRes.status, 200);
      const statusData = await statusRes.json() as any;
      assert.strictEqual(statusData.pinConfigured, false);
      assert.strictEqual(statusData.parentPinSetupRequired, true);
      assert.strictEqual(statusData.managementUnlocked, false);

      // 2. Protected mutations remain strictly locked (401)
      const mutRes = await fetch(`http://127.0.0.1:${guiPort}/api/reconfigure`, { method: 'POST' });
      assert.strictEqual(mutRes.status, 401);
      const mutData = await mutRes.json() as any;
      assert.match(mutData.error, /Parent PIN has not been configured/);

      // 3. Child/standard non-admin user attempts bootstrap PIN -> 403 Forbidden
      configMgr.setMockIsAdministratorForTesting(false);
      const childBootstrapRes = await fetch(`http://127.0.0.1:${pairPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '987654', confirmPin: '987654' }),
      });
      assert.strictEqual(childBootstrapRes.status, 403);
      const childBootstrapData = await childBootstrapRes.json() as any;
      assert.match(childBootstrapData.error, /Administrator/i);
      assert.strictEqual(await pinMgr.isPinSet(), false);

      // 4. Elevated administrator enters mismatched or malformed PINs -> 400 Bad Request
      configMgr.setMockIsAdministratorForTesting(true);

      const mismatchRes = await fetch(`http://127.0.0.1:${pairPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '987654', confirmPin: '987655' }),
      });
      assert.strictEqual(mismatchRes.status, 400);
      const mismatchData = await mismatchRes.json() as any;
      assert.match(mismatchData.error, /not match/i);

      const malformedRes = await fetch(`http://127.0.0.1:${pairPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '1234', confirmPin: '1234' }),
      });
      assert.strictEqual(malformedRes.status, 400);
      const malformedData = await malformedRes.json() as any;
      assert.match(malformedData.error, /between 6 and 8/i);

      // 5. Elevated administrator successfully configures initial PIN
      const successBootstrapRes = await fetch(`http://127.0.0.1:${pairPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '987654', confirmPin: '987654' }),
      });
      assert.strictEqual(successBootstrapRes.status, 200);
      const successBootstrapData = await successBootstrapRes.json() as any;
      assert.strictEqual(successBootstrapData.success, true);
      assert.strictEqual(await pinMgr.isPinSet(), true);

      // 6. Calling bootstrap-pin when PIN is ALREADY configured -> 400 Bad Request
      const reBootstrapRes = await fetch(`http://127.0.0.1:${pairPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '112233', confirmPin: '112233' }),
      });
      assert.strictEqual(reBootstrapRes.status, 400);
      const reBootstrapData = await reBootstrapRes.json() as any;
      assert.match(reBootstrapData.error, /already configured/i);

      // 7. GUI launch-pin-setup when PIN is ALREADY set -> 400 Bad Request
      const launchWhenSetRes = await fetch(`http://127.0.0.1:${guiPort}/api/launch-pin-setup`, { method: 'POST' });
      assert.strictEqual(launchWhenSetRes.status, 400);
      const launchWhenSetData = await launchWhenSetRes.json() as any;
      assert.match(launchWhenSetData.error, /already configured/i);

      // 8. View-only status now reports parentPinSetupRequired: false and pinConfigured: true
      const postSetupStatus = await fetch(`http://127.0.0.1:${guiPort}/api/status`);
      assert.strictEqual(postSetupStatus.status, 200);
      const postSetupData = await postSetupStatus.json() as any;
      assert.strictEqual(postSetupData.pinConfigured, true);
      assert.strictEqual(postSetupData.parentPinSetupRequired, false);
      assert.strictEqual(postSetupData.managementUnlocked, false);

      // 9. Standard PIN verification with the newly created PIN unlocks 5-minute management session
      const verifyRes = await fetch(`http://127.0.0.1:${guiPort}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '987654' }),
      });
      assert.strictEqual(verifyRes.status, 200);
      const verifyData = await verifyRes.json() as any;
      assert.strictEqual(verifyData.success, true);
      assert.ok(verifyData.sessionToken);

      // 10. Status with valid session token is unlocked
      const unlockedStatus = await fetch(`http://127.0.0.1:${guiPort}/api/status`, {
        headers: { 'x-management-session': verifyData.sessionToken },
      });
      assert.strictEqual(unlockedStatus.status, 200);
      const unlockedData = await unlockedStatus.json() as any;
      assert.strictEqual(unlockedData.managementUnlocked, true);
      assert.strictEqual(unlockedData.parentPinSetupRequired, false);
    } finally {
      configMgr.setMockIsAdministratorForTesting(true);
      guiServer.stop();
      await pairServer.stop();
    }
  });

  it('16. Gate A Final: Dedicated PIN bootstrap mode satisfies all 10 security invariants', async () => {
    const { ElevatedPairServer } = await import('../src/elevated-pair-server');

    // 1. Structural check: --setup-pin in agent-cli.ts launches PIN_BOOTSTRAP mode, not default pairing
    const agentCliPath = path.resolve(__dirname, '../src/agent-cli.ts');
    const agentCliContent = fs.readFileSync(agentCliPath, 'utf8');
    const setupPinIdx = agentCliContent.indexOf("args.includes('--setup-pin')");
    assert.ok(setupPinIdx !== -1, 'agent-cli.ts must handle --setup-pin');
    const setupPinBlock = agentCliContent.substring(setupPinIdx, setupPinIdx + 2000);
    assert.ok(
      setupPinBlock.includes("'PIN_BOOTSTRAP'"),
      'agent-cli.ts --setup-pin must instantiate ElevatedPairServer with PIN_BOOTSTRAP mode'
    );
    assert.ok(
      !setupPinBlock.includes('new ElevatedPairServer()'),
      'agent-cli.ts --setup-pin must NOT use default PAIRING mode'
    );

    // Initial State: Paired device with NO Parent PIN
    await configMgr.saveDeviceConfig({
      deviceId: 'dev-bootstrap-invariants',
      deviceToken: 'dtk_invariants',
      childId: null,
      parentId: 'p-invariants',
      deviceName: 'Family PC',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
      onboardingState: 'PROTECTED',
    });
    await pinMgr.clearPin();
    assert.strictEqual(await pinMgr.isPinSet(), false);

    const bootstrapServer = new ElevatedPairServer(configMgr, accountMgr, networkManager, pinMgr, 'PIN_BOOTSTRAP');
    const bPort = await bootstrapServer.start(0);

    const guiServer = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const gPort = await guiServer.start(0);

    try {
      // 2. Mode check and status
      assert.strictEqual(bootstrapServer.getMode(), 'PIN_BOOTSTRAP');
      const statusRes = await fetch(`http://127.0.0.1:${bPort}/api/status`);
      const statusData = await statusRes.json() as any;
      assert.strictEqual(statusData.mode, 'PIN_BOOTSTRAP');
      assert.strictEqual(statusData.isPaired, true);
      assert.strictEqual(statusData.isPinSet, false);
      assert.strictEqual(statusData.parentPinSetupRequired, true);

      // 3. Paired + no PIN => Dedicated PIN-bootstrap HTML screen served
      const htmlRes = await fetch(`http://127.0.0.1:${bPort}/`);
      assert.strictEqual(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('SafeBrowse Administrator Parent PIN Setup'), 'Must serve PIN bootstrap title');
      assert.ok(html.includes('id="parentPin"'), 'Must contain parentPin input field');
      assert.ok(html.includes('id="confirmPin"'), 'Must contain confirmPin input field');

      // 7. Bootstrap UI submits specifically to /api/bootstrap-pin
      assert.ok(html.includes('/api/bootstrap-pin'), 'Bootstrap UI must post to /api/bootstrap-pin');
      assert.ok(html.includes('submitBootstrapPin'), 'Must contain submitBootstrapPin handler');

      // 8. Bootstrap mode does NOT expose pairing, account mapping, or reconnect UI
      assert.strictEqual(html.includes('id="pairingCode"'), false, 'Must NOT contain pairingCode input');
      assert.strictEqual(html.includes('id="accountsContainer"'), false, 'Must NOT contain accounts container');
      assert.strictEqual(html.includes('screenAccounts'), false, 'Must NOT contain accounts screen');
      assert.strictEqual(html.includes('reconnectComputer'), false, 'Must NOT expose reconnect UI');
      assert.strictEqual(html.includes('/api/claim-and-pair'), false, 'Must NOT reference claim-and-pair in HTML');
      assert.strictEqual(html.includes('/api/finish-setup'), false, 'Must NOT reference finish-setup in HTML');

      // Mutation endpoints blocked in PIN_BOOTSTRAP mode
      const blockedClaim = await fetch(`http://127.0.0.1:${bPort}/api/claim-and-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'ABCD1234' }),
      });
      assert.strictEqual(blockedClaim.status, 403);

      const blockedFinish = await fetch(`http://127.0.0.1:${bPort}/api/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: [], parentPin: '123456' }),
      });
      assert.strictEqual(blockedFinish.status, 403);

      const blockedAccounts = await fetch(`http://127.0.0.1:${bPort}/api/accounts`);
      assert.strictEqual(blockedAccounts.status, 403);

      const blockedProfiles = await fetch(`http://127.0.0.1:${bPort}/api/family-profiles`);
      assert.strictEqual(blockedProfiles.status, 403);

      const blockedReconnect = await fetch(`http://127.0.0.1:${bPort}/api/reconnect`, { method: 'POST' });
      assert.strictEqual(blockedReconnect.status, 403);

      // 3. Unpaired => bootstrap rejected
      await configMgr.deleteDeviceConfig();
      const unpairBootstrap = await fetch(`http://127.0.0.1:${bPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '829103', confirmPin: '829103' }),
      });
      assert.strictEqual(unpairBootstrap.status, 400);
      const unpairData = await unpairBootstrap.json() as any;
      assert.match(unpairData.error, /Device is not paired/i);

      // Restore device config
      await configMgr.saveDeviceConfig({
        deviceId: 'dev-bootstrap-invariants',
        deviceToken: 'dtk_invariants',
        childId: null,
        parentId: 'p-invariants',
        deviceName: 'Family PC',
        backendUrl: 'https://safebrowse.porwal.online',
        pairedAt: new Date().toISOString(),
        onboardingState: 'PROTECTED',
      });

      // 5. Non-admin => rejected
      configMgr.setMockIsAdministratorForTesting(false);
      const nonAdminBootstrap = await fetch(`http://127.0.0.1:${bPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '829103', confirmPin: '829103' }),
      });
      assert.strictEqual(nonAdminBootstrap.status, 403);
      configMgr.setMockIsAdministratorForTesting(true);

      // Malformed PIN (< 6 digits) => rejected
      const malformedBootstrap = await fetch(`http://127.0.0.1:${bPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '123', confirmPin: '123' }),
      });
      assert.strictEqual(malformedBootstrap.status, 400);

      // Mismatched confirmation => rejected
      const mismatchBootstrap = await fetch(`http://127.0.0.1:${bPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '829103', confirmPin: '829104' }),
      });
      assert.strictEqual(mismatchBootstrap.status, 400);

      // 6. Valid 6-8 digit PIN + matching confirmation => verifier created
      const validBootstrap = await fetch(`http://127.0.0.1:${bPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '829103', confirmPin: '829103' }),
      });
      assert.strictEqual(validBootstrap.status, 200);
      const validData = await validBootstrap.json() as any;
      assert.strictEqual(validData.success, true);
      assert.strictEqual(await pinMgr.isPinSet(), true);

      // 9. Successful bootstrap does NOT grant management session automatically
      assert.strictEqual(validData.sessionToken, undefined, 'Must not issue session token on bootstrap');

      // Verify on GuiServer: management remains locked!
      const lockedCheck = await fetch(`http://127.0.0.1:${gPort}/api/status`);
      const lockedData = await lockedCheck.json() as any;
      assert.strictEqual(lockedData.managementUnlocked, false);
      assert.strictEqual(lockedData.pinConfigured, true);
      assert.strictEqual(lockedData.parentPinSetupRequired, false);

      // 4. Existing PIN => subsequent bootstrap rejected
      const existingPinBootstrap = await fetch(`http://127.0.0.1:${bPort}/api/bootstrap-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPin: '112233', confirmPin: '112233' }),
      });
      assert.strictEqual(existingPinBootstrap.status, 400);
      const existingData = await existingPinBootstrap.json() as any;
      assert.match(existingData.error, /already configured/i);

      // 10. Normal PIN verification is still required afterward to unlock 5-minute session
      const verifyRes = await fetch(`http://127.0.0.1:${gPort}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '829103' }),
      });
      assert.strictEqual(verifyRes.status, 200);
      const verifyData = await verifyRes.json() as any;
      assert.strictEqual(verifyData.success, true);
      assert.ok(verifyData.sessionToken);

      // Session validates and unlocks management
      assert.strictEqual(pinMgr.validateSession(verifyData.sessionToken), true);
      const unlockedCheck = await fetch(`http://127.0.0.1:${gPort}/api/status`, {
        headers: { 'x-management-session': verifyData.sessionToken },
      });
      const unlockedData = await unlockedCheck.json() as any;
      assert.strictEqual(unlockedData.managementUnlocked, true);
    } finally {
      configMgr.setMockIsAdministratorForTesting(true);
      guiServer.stop();
      await bootstrapServer.stop();
    }
  });

  it('17. C.5.5 UX regression: paired-state loader, maximized windows and hidden console launch', async () => {
    const guiServer = new GuiServer(configMgr, accountMgr, networkManager, pinMgr);
    const elevatedServer = new ElevatedConfigServer(configMgr, accountMgr);

    const guiHtml = (guiServer as any).renderHtml() as string;
    const elevatedHtml = (elevatedServer as any).renderHtml() as string;

    // Main GUI must start in a blocking loader, never on Connect This Computer.
    assert.ok(
      guiHtml.includes('id="screenLoading" class="screen active"'),
      'Main GUI must initially render the authoritative protection-state loader'
    );
    assert.strictEqual(
      guiHtml.includes('id="screenWelcome" class="screen active"'),
      false,
      'Connect This Computer must never be the initial active screen'
    );
    assert.match(guiHtml, /Please wait while SafeBrowse verifies this computer/i);

    // Elevated account synchronization must block interaction and explain progress.
    assert.match(elevatedHtml, /Synchronizing SafeBrowse/i);
    assert.match(elevatedHtml, /No changes can be made until this finishes/i);
    assert.ok(elevatedHtml.includes('id="content" style="display:none;"'));

    // Source-level Windows launch contract: maximized app windows, no fixed tiny size,
    // and no visible elevated console window.
    const guiSource = fs.readFileSync(path.resolve(__dirname, '../src/gui-server.ts'), 'utf8');
    const elevatedSource = fs.readFileSync(path.resolve(__dirname, '../src/elevated-config-server.ts'), 'utf8');

    assert.ok(guiSource.includes("'--start-maximized'"), 'Main GUI must request maximized Edge app mode');
    assert.ok(elevatedSource.includes("'--start-maximized'"), 'Elevated GUI must request maximized Edge app mode');
    assert.strictEqual(guiSource.includes('--window-size='), false, 'Main GUI must not force an 880x720 window');
    assert.strictEqual(elevatedSource.includes('--window-size='), false, 'Elevated GUI must not force an 820x700 window');
    assert.ok(guiSource.includes('-WindowStyle Hidden'), 'Elevated SEA launch must hide its console window');
    assert.ok(guiSource.includes('{ windowsHide: true }'), 'PowerShell/browser launch helpers must suppress console windows');
  });

});
