import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';

process.env.NODE_ENV = 'test';
import {
  WindowsAccountManager,
  WindowsProfileMapping,
  WindowsAccount,
  FamilyChildProfile,
} from '../src/account-manager';
import { ConfigManager, DeviceConfig } from '../src/config-manager';
import { GuiServer } from '../src/gui-server';

describe('SafeBrowse Windows Pilot — Account Mapping Reliability & Secure Save Suite', () => {
  let tempDir: string;
  let accountMgr: WindowsAccountManager;
  let testConfigMgr: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acc-test-'));
    accountMgr = new WindowsAccountManager(tempDir);
    testConfigMgr = new ConfigManager(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // 1. Account Discovery & Filtering Tests
  // =========================================================================
  it('1. should filter out disabled accounts from discovery', () => {
    assert.strictEqual(
      accountMgr.isSystemOrServiceAccount('OldAccount', 'S-1-5-21-1000-1000-1000-1005', true),
      true,
      'Disabled accounts must be filtered'
    );
    assert.strictEqual(
      accountMgr.isSystemOrServiceAccount('ActiveUser', 'S-1-5-21-1000-1000-1000-1006', false),
      false,
      'Active accounts must not be filtered'
    );
  });

  it('2. should filter out well-known system SIDs and service identities', () => {
    const wellKnown = [
      { name: 'SYSTEM', sid: 'S-1-5-18' },
      { name: 'LOCAL SERVICE', sid: 'S-1-5-19' },
      { name: 'NETWORK SERVICE', sid: 'S-1-5-20' },
      { name: 'AppPoolIdentity', sid: 'S-1-5-82-12345' },
      { name: 'Window Manager', sid: 'S-1-5-90-1' },
      { name: 'Font Driver Host', sid: 'S-1-5-96-0' },
      { name: 'DWM-1', sid: 'S-1-5-21-1000-1000-1000-999' },
      { name: 'UMFD-0', sid: 'S-1-5-21-1000-1000-1000-998' },
      { name: 'TrustedInstaller', sid: 'S-1-5-32-544' },
    ];

    for (const item of wellKnown) {
      assert.strictEqual(
        accountMgr.isSystemOrServiceAccount(item.name, item.sid),
        true,
        `${item.name} (${item.sid}) must be filtered out`
      );
    }
  });

  it('3. should filter out built-in RID accounts: Administrator (-500), Guest (-501), DefaultAccount (-503), WDAG (-504)', () => {
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('Administrator', 'S-1-5-21-1000-1000-1000-500'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('Guest', 'S-1-5-21-1000-1000-1000-501'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('DefaultAccount', 'S-1-5-21-1000-1000-1000-503'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('WDAGUtilityAccount', 'S-1-5-21-1000-1000-1000-504'), true);
  });

  it('4. should filter out sandbox accounts matching /sandbox/i', () => {
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('CodexSandboxOffline', 'S-1-5-21-1000-1000-1000-1010'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('CodexSandboxOnline', 'S-1-5-21-1000-1000-1000-1011'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('WindowsSandbox', 'S-1-5-21-1000-1000-1000-1012'), true);
  });

  it('5. should preserve interactive human accounts and sort them alphabetically', async () => {
    const rawMockAccounts: WindowsAccount[] = [
      { name: 'Rahul', sid: 'S-1-5-21-1000-1000-1000-1002', disabled: false },
      { name: 'Guest', sid: 'S-1-5-21-1000-1000-1000-501', disabled: false },
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'CodexSandboxOffline', sid: 'S-1-5-21-1000-1000-1000-1010', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
      { name: 'DIC', sid: 'S-1-5-21-1000-1000-1000-1003', disabled: false },
      { name: 'DisabledChild', sid: 'S-1-5-21-1000-1000-1000-1004', disabled: true },
    ];

    accountMgr.setMockAccountsForTesting(rawMockAccounts);
    const discovered = await accountMgr.discoverAccounts();

    // Only acer, DIC, Manjari, Rahul should remain (4 accounts)
    assert.strictEqual(discovered.length, 4);

    // Should be sorted alphabetically (case-insensitive)
    const names = discovered.map((a) => a.name);
    assert.deepStrictEqual(names, ['acer', 'DIC', 'Manjari', 'Rahul']);
  });

  // =========================================================================
  // 2. Family Profiles Cloud Fetch Resilience & Caching Tests
  // =========================================================================
  it('6. should successfully fetch profiles from cloud, cache them, and return fromCache: false', async () => {
    const fakeProfiles = [
      { id: 'child-1', name: 'Manjari', age: 12 },
      { id: 'child-2', name: 'Rahul', age: 8 },
    ];

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fakeProfiles,
    });

    const result = await accountMgr.fetchFamilyProfilesWithResilience(
      'https://safebrowse.porwal.online',
      'dev-1',
      'tok-1',
      { maxRetries: 1, fetchFn: mockFetch as any }
    );

    assert.strictEqual(result.fromCache, false);
    assert.strictEqual(result.profiles.length, 2);
    assert.strictEqual(result.profiles[0].name, 'Manjari');
    assert.strictEqual(result.profiles[1].name, 'Rahul');

    // Verify cache file was written to disk
    const cached = await accountMgr.getCachedFamilyProfiles();
    assert.notStrictEqual(cached, null);
    assert.strictEqual(cached!.profiles.length, 2);
    assert.strictEqual(cached!.profiles[0].id, 'child-1');
  });

  it('7. should retry cloud fetch on transient failure and succeed on subsequent attempt', async () => {
    let callCount = 0;
    const fakeProfiles = [{ id: 'child-1', name: 'Manjari' }];

    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Connection reset by peer');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ profiles: fakeProfiles }),
      };
    };

    const result = await accountMgr.fetchFamilyProfilesWithResilience(
      'https://safebrowse.porwal.online',
      'dev-1',
      'tok-1',
      { maxRetries: 3, retryDelayMs: 10, fetchFn: mockFetch as any }
    );

    assert.strictEqual(callCount, 2);
    assert.strictEqual(result.fromCache, false);
    assert.strictEqual(result.profiles.length, 1);
    assert.strictEqual(result.profiles[0].name, 'Manjari');
  });

  it('8. should fallback to persistent local cache when all cloud retries fail and cache exists', async () => {
    // Seed the cache first
    const cachedProfiles: FamilyChildProfile[] = [
      { id: 'child-cached-1', name: 'Cached Manjari' },
      { id: 'child-cached-2', name: 'Cached Rahul' },
    ];
    await accountMgr.saveCachedFamilyProfiles(cachedProfiles);

    // Mock fetch that always fails (e.g. 503 or network down)
    const mockFetch = async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await accountMgr.fetchFamilyProfilesWithResilience(
      'https://safebrowse.porwal.online',
      'dev-1',
      'tok-1',
      { maxRetries: 2, retryDelayMs: 5, fetchFn: mockFetch as any }
    );

    assert.strictEqual(result.fromCache, true);
    assert.strictEqual(result.profiles.length, 2);
    assert.strictEqual(result.profiles[0].name, 'Cached Manjari');
    assert.notStrictEqual(result.cachedAt, undefined);
  });

  it('9. should throw descriptive error when all cloud retries fail and no cache exists', async () => {
    const mockFetch = async () => {
      throw new Error('DNS lookup failed for safebrowse.porwal.online');
    };

    await assert.rejects(
      async () => {
        await accountMgr.fetchFamilyProfilesWithResilience(
          'https://safebrowse.porwal.online',
          'dev-1',
          'tok-1',
          { maxRetries: 2, retryDelayMs: 5, fetchFn: mockFetch as any }
        );
      },
      /Unable to load family profiles\. Check SafeBrowse connection and retry\./
    );
  });

  it('10. should sanitize invalid profile objects and reject malformed entries', async () => {
    const mixedPayload = [
      { id: 'child-1', name: 'Valid Child' },
      null,
      { id: '', name: 'No ID Child' },
      { id: 'child-2' }, // missing name
      { id: 'child-3', name: 'Another Valid' },
    ];

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mixedPayload,
    });

    const result = await accountMgr.fetchFamilyProfilesWithResilience(
      'https://safebrowse.porwal.online',
      'dev-1',
      'tok-1',
      { maxRetries: 1, fetchFn: mockFetch as any }
    );

    assert.strictEqual(result.profiles.length, 2);
    assert.strictEqual(result.profiles[0].id, 'child-1');
    assert.strictEqual(result.profiles[1].id, 'child-3');
  });

  // =========================================================================
  // 3. Secure Save & Transaction Tests
  // =========================================================================
  it('11. should validate input mappings array and reject non-array or missing fields', async () => {
    await assert.rejects(
      async () => {
        await accountMgr.saveProfileMappingsTransaction(null as any);
      },
      /Invalid mappings: expected an array/
    );

    await assert.rejects(
      async () => {
        await accountMgr.saveProfileMappingsTransaction([
          { windowsSid: '', windowsUsername: 'user1', childId: null, enabled: false },
        ]);
      },
      /missing a valid Windows SID/
    );

    await assert.rejects(
      async () => {
        await accountMgr.saveProfileMappingsTransaction([
          { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: '', childId: null, enabled: false },
        ]);
      },
      /missing a Windows username/
    );
  });

  it('12. should validate Windows SID format and reject malformed SIDs', async () => {
    await assert.rejects(
      async () => {
        await accountMgr.saveProfileMappingsTransaction([
          { windowsSid: 'INVALID-SID-STRING', windowsUsername: 'acer', childId: null, enabled: false },
        ]);
      },
      /Invalid Windows SID format/
    );
  });

  it('13. should reject duplicate Windows SIDs in mapping payload', async () => {
    const duplicates: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer2', childId: 'child-1', enabled: true },
    ];

    await assert.rejects(
      async () => {
        await accountMgr.saveProfileMappingsTransaction(duplicates);
      },
      /Duplicate mapping detected for Windows SID/
    );
  });

  it('14. should atomically persist valid mappings and verify reloaded content', async () => {
    const validMappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1000',
        windowsUsername: 'acer',
        childId: null,
        childName: null,
        enabled: false,
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1001',
        windowsUsername: 'Manjari',
        childId: 'child-m',
        childName: 'Manjari',
        enabled: true,
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1002',
        windowsUsername: 'Rahul',
        childId: 'child-r',
        childName: 'Rahul',
        enabled: true,
      },
    ];

    const res = await accountMgr.saveProfileMappingsTransaction(validMappings, 'dev-test-1', 'Family Laptop');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.mappings.length, 3);

    // Verify file exists and matches
    const reloaded = await accountMgr.loadProfileMappings();
    assert.strictEqual(reloaded.length, 3);
    assert.strictEqual(reloaded[0].windowsUsername, 'acer');
    assert.strictEqual(reloaded[0].childId, null);
    assert.strictEqual(reloaded[1].windowsUsername, 'Manjari');
    assert.strictEqual(reloaded[1].childId, 'child-m');
    assert.strictEqual(reloaded[2].windowsUsername, 'Rahul');
    assert.strictEqual(reloaded[2].childId, 'child-r');
  });

  it('15. should clean up temp file and not corrupt existing mappings on transaction failure', async () => {
    // Save good mappings first
    const goodMappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
    ];
    await accountMgr.saveProfileMappingsTransaction(goodMappings);

    // Attempt invalid save
    try {
      await accountMgr.saveProfileMappingsTransaction([
        { windowsSid: 'INVALID', windowsUsername: 'broken', childId: null, enabled: false },
      ]);
    } catch {}

    // Check that original file was not corrupted
    const reloaded = await accountMgr.loadProfileMappings();
    assert.strictEqual(reloaded.length, 1);
    assert.strictEqual(reloaded[0].windowsUsername, 'acer');

    // Check no dangling temp files
    const files = fs.readdirSync(tempDir);
    const tempFiles = files.filter((f) => f.includes('.tmp.'));
    assert.strictEqual(tempFiles.length, 0);
  });

  // =========================================================================
  // 4. GUI Server Integration Tests
  // =========================================================================
  it('16. GUI Server: GET /api/family-profiles returns profiles and fromCache status', async () => {
    // Configure device config
    const config: DeviceConfig = {
      deviceId: 'dev-gui-test',
      deviceToken: 'token-gui-test',
      childId: 'child-1',
      parentId: 'parent-1',
      deviceName: 'GUI Test Laptop',
      backendUrl: 'http://127.0.0.1:18899',
    };
    await testConfigMgr.saveDeviceConfig(config);

    // Seed cache
    await accountMgr.saveCachedFamilyProfiles([
      { id: 'c1', name: 'Manjari' },
      { id: 'c2', name: 'Rahul' },
    ]);

    const server = new GuiServer(testConfigMgr, accountMgr);
    const port = await server.start(0);

    try {
      // Since backend is not running at 18899, it should fallback to cached profiles
      const resp = await fetch(`http://127.0.0.1:${port}/api/family-profiles`);
      assert.strictEqual(resp.status, 200);

      const data: any = await resp.json();
      assert.strictEqual(Array.isArray(data.profiles), true);
      assert.strictEqual(data.profiles.length, 2);
      assert.strictEqual(data.fromCache, true);
    } finally {
      server.stop();
    }
  });

  it('17. GUI Server: POST /api/mappings saves mappings and reloads successfully', async () => {
    const server = new GuiServer(testConfigMgr, accountMgr);
    const port = await server.start(0);

    try {
      const payload = {
        mappings: [
          { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
          { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-1', childName: 'Manjari', enabled: true },
        ],
      };

      const resp = await fetch(`http://127.0.0.1:${port}/api/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(resp.status, 200);
      const resJson: any = await resp.json();
      assert.strictEqual(resJson.success, true);
    } finally {
      server.stop();
    }
  });

  it('18. GUI Server: GET /api/accounts identifies active console user cleanly and returns sorted accounts', async () => {
    accountMgr.setMockAccountsForTesting([
      { name: 'Rahul', sid: 'S-1-5-21-1000-1000-1000-1002', disabled: false },
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'DIC', sid: 'S-1-5-21-1000-1000-1000-1003', disabled: false },
    ]);
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1000-1000-1003'); // DIC is active console user

    const server = new GuiServer(testConfigMgr, accountMgr);
    const port = await server.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/accounts`);
      assert.strictEqual(resp.status, 200);
      const data: any = await resp.json();

      assert.strictEqual(data.accounts.length, 3);
      // Verify sorting: acer, DIC, Rahul
      assert.strictEqual(data.accounts[0].name, 'acer');
      assert.strictEqual(data.accounts[1].name, 'DIC');
      assert.strictEqual(data.accounts[2].name, 'Rahul');

      // Verify active user flag
      assert.strictEqual(data.accounts[0].isCurrentConsoleUser, false);
      assert.strictEqual(data.accounts[1].isCurrentConsoleUser, true); // DIC
      assert.strictEqual(data.accounts[2].isCurrentConsoleUser, false);
    } finally {
      server.stop();
    }
  });
});
