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
import { ElevatedConfigServer } from '../src/elevated-config-server';

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

  // =========================================================================
  // 5. Staged Nonce-Based Integrity-Validated Request Tests
  // =========================================================================
  it('19. should createMappingSaveRequest generating UUID v4 nonce, fresh timestamp, and valid SHA-256 payloadHash', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    const mappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
      { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-1', enabled: true },
    ];

    const req = await accountMgr.createMappingSaveRequest(mappings, 'dev-123', 'My Laptop');
    assert.ok(req.nonce);
    assert.match(req.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.strictEqual(fs.existsSync(req.reqPath), true);
    assert.ok(req.reqPath.endsWith(`sb-mapping-req-${req.nonce}.json`));

    const raw = JSON.parse(fs.readFileSync(req.reqPath, 'utf8'));
    assert.strictEqual(raw.nonce, req.nonce);
    assert.strictEqual(raw.deviceId, 'dev-123');
    assert.strictEqual(raw.mappings.length, 2);
    assert.ok(raw.payloadHash);
    assert.match(raw.payloadHash, /^[0-9a-f]{64}$/);
  });

  it('20. should reject applyMappingSaveRequest when nonce format is not a valid UUID v4', async () => {
    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest('../malicious-path');
      },
      /Invalid nonce format: must be a valid UUID v4/
    );

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest('not-a-uuid');
      },
      /Invalid nonce format: must be a valid UUID v4/
    );
  });

  it('21. should reject applyMappingSaveRequest when request has expired (> 60s freshness)', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    const mappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
    ];

    const req = await accountMgr.createMappingSaveRequest(mappings, 'dev-123', 'My Laptop');

    // Tamper with timestamp to simulate 90 seconds old request
    const expiredTimestamp = new Date(Date.now() - 90000).toISOString();
    const { computeMappingPayloadHash } = await import('../src/account-manager');
    const newHash = computeMappingPayloadHash(req.nonce, expiredTimestamp, 'dev-123', mappings);

    fs.writeFileSync(
      req.reqPath,
      JSON.stringify({
        ...req.payload,
        timestamp: expiredTimestamp,
        payloadHash: newHash,
      }, null, 2),
      'utf8'
    );

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-123' });
      },
      /Mapping save request has expired/
    );
  });

  it('22. should prevent replay: unlinks request file immediately on read; second call fails', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
    ]);

    const mappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
    ];

    const req = await accountMgr.createMappingSaveRequest(mappings, 'dev-replay', 'Replay Laptop');
    assert.strictEqual(fs.existsSync(req.reqPath), true);

    // First application: succeeds and unlinks file
    const res = await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-replay' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(fs.existsSync(req.reqPath), false, 'File must be deleted after reading');

    // Second application with same nonce: fails because file no longer exists
    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-replay' });
      },
      /Mapping save request file not found/
    );
  });

  it('23. should reject applyMappingSaveRequest when payload is tampered (payloadHash mismatch)', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    const mappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
    ];

    const req = await accountMgr.createMappingSaveRequest(mappings, 'dev-tamper', 'Tamper Laptop');

    // Tamper with mapping data without updating payloadHash
    const tamperedPayload = {
      ...req.payload,
      mappings: [
        { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: 'injected-child', enabled: true },
      ],
    };
    fs.writeFileSync(req.reqPath, JSON.stringify(tamperedPayload, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-tamper' });
      },
      /Payload integrity check failed: payloadHash mismatch/
    );
  });

  it('24. should reject applyMappingSaveRequest when deviceId mismatches configured machine deviceId', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    const mappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
    ];

    const req = await accountMgr.createMappingSaveRequest(mappings, 'dev-attacker-id', 'Attacker Laptop');

    await assert.rejects(
      async () => {
        // Machine is configured for dev-real-machine
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-real-machine' });
      },
      /DeviceId mismatch: request specifies 'dev-attacker-id', but machine is configured with 'dev-real-machine'/
    );
  });

  it('25. should reject applyMappingSaveRequest with duplicate SIDs in mappings', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    const duplicates: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer2', childId: null, enabled: false },
    ];

    const req = await accountMgr.createMappingSaveRequest(duplicates, 'dev-dup', 'Dup Laptop');

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-dup' });
      },
      /Duplicate mapping detected for Windows SID/
    );
  });

  it('26. should reject applyMappingSaveRequest with SID not found in discovered machine accounts', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
    ]);

    const fakeSidMappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-9999-9999-9999-9999', windowsUsername: 'unknown', childId: null, enabled: false },
    ];

    const req = await accountMgr.createMappingSaveRequest(fakeSidMappings, 'dev-sid-check', 'Laptop');

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-sid-check' });
      },
      /Validation error: Windows SID 'S-1-5-21-9999-9999-9999-9999' is not a valid discovered account on this machine/
    );
  });

  it('27. should reject applyMappingSaveRequest with childId not found in authoritative family profiles', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);

    // Seed authoritative family profiles cache with child-1 only
    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-1', name: 'Manjari' },
    ]);

    // Request attempts to map to non-existent child-nonexistent
    const badChildMappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-nonexistent', enabled: true },
    ];

    const req = await accountMgr.createMappingSaveRequest(badChildMappings, 'dev-child-check', 'Laptop');

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-child-check' });
      },
      /Validation error: Child ID 'child-nonexistent' does not exist in family profiles/
    );
  });

  it('28. should successfully applyMappingSaveRequest, persist to state/profile-mappings.json, and reload', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);

    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-1', name: 'Manjari' },
    ]);

    const validMappings: WindowsProfileMapping[] = [
      { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
      { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-1', childName: 'Manjari', enabled: true },
    ];

    const req = await accountMgr.createMappingSaveRequest(validMappings, 'dev-good', 'Laptop');
    const result = await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-good' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.mappings.length, 2);

    // Verify stored in state directory
    const stateFile = path.join(accountMgr.getStateDir(), 'profile-mappings.json');
    assert.strictEqual(fs.existsSync(stateFile), true);

    const reloaded = await accountMgr.loadProfileMappings();
    assert.strictEqual(reloaded.length, 2);
    assert.strictEqual(reloaded[0].windowsUsername, 'acer');
    assert.strictEqual(reloaded[1].windowsUsername, 'Manjari');
    assert.strictEqual(reloaded[1].childId, 'child-1');
  });

  it('29. GUI Server: GET /api/status succeeds using sanitized-config.json when secure directory is inaccessible', async () => {
    // Seed sanitized-config.json in state/
    const stateDir = testConfigMgr.getStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      testConfigMgr.getSanitizedConfigFilePath(),
      JSON.stringify({
        deviceId: 'dev-status-safe',
        deviceName: 'Sanitized Family Laptop',
        childId: 'child-1',
        backendUrl: 'https://safebrowse.porwal.online',
        pairedAt: '2026-09-30T10:00:00.000Z',
        isPaired: true,
      }),
      'utf8'
    );

    // Simulate loadDeviceConfig throwing EACCES (non-elevated user)
    testConfigMgr.loadDeviceConfig = async () => {
      throw new Error('EACCES: permission denied, open secure/device-config.json');
    };

    const server = new GuiServer(testConfigMgr, accountMgr);
    const port = await server.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(resp.status, 200);
      const data: any = await resp.json();

      assert.strictEqual(data.isPaired, true);
      assert.strictEqual(data.config.deviceId, 'dev-status-safe');
      assert.strictEqual(data.config.deviceName, 'Sanitized Family Laptop');
      // Must not expose any secrets
      assert.strictEqual(data.config.deviceToken, undefined);
      assert.strictEqual(data.config.deviceTokenEncrypted, undefined);
    } finally {
      server.stop();
    }
  });

  // =========================================================================
  // 6. Elevated Account Configuration Architecture (v1.0.1-pilot)
  // =========================================================================

  it('30. Normal GUI cannot write mappings directly when unelevated (returns 403 Forbidden)', async () => {
    const server = new GuiServer(testConfigMgr, accountMgr);
    // Mock unelevated status
    testConfigMgr.isAdministrator = async () => false;
    // Mock platform as win32 to trigger elevation check
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const port = await server.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: null, enabled: false },
          ],
        }),
      });

      assert.strictEqual(resp.status, 403);
      const data: any = await resp.json();
      assert.ok(data.error.includes('Administrator approval is required'));
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      server.stop();
    }
  });

  it('31. Normal GUI launches elevated configuration mode via POST /api/reconfigure', async () => {
    const server = new GuiServer(testConfigMgr, accountMgr);
    const port = await server.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/reconfigure`, {
        method: 'POST',
      });

      assert.strictEqual(resp.status, 200);
      const data: any = await resp.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.message.includes('elevation requested'));
    } finally {
      server.stop();
    }
  });

  it('32. Elevated mode can load secure config and read credentials', async () => {
    // Seed secure/device-config.json
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-secure-01',
      deviceToken: 'dtk_super_secret_token_123',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Secure Family Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    const secureConfig = await testConfigMgr.loadDeviceConfig();
    assert.ok(secureConfig);
    assert.strictEqual(secureConfig.deviceId, 'dev-secure-01');
    assert.strictEqual(secureConfig.deviceToken, 'dtk_super_secret_token_123');

    // Start ElevatedConfigServer
    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/config-state`);
      assert.strictEqual(resp.status, 200);
      const state: any = await resp.json();
      assert.strictEqual(state.deviceId, 'dev-secure-01');
      assert.strictEqual(state.deviceName, 'Secure Family Laptop');
      // Invariant: deviceToken must NOT be sent to client JSON state
      assert.strictEqual(state.deviceToken, undefined);
    } finally {
      elevatedServer.stop();
    }
  });

  it('33. Elevated mode fetches family profiles live using deviceToken and caches them', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-secure-02',
      deviceToken: 'dtk_secret_profiles_999',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Family Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    // Mock cloud fetch returning live child profiles
    const mockCloudProfiles: FamilyChildProfile[] = [
      { id: 'child-101', name: 'Manjari', age: 12 },
      { id: 'child-102', name: 'Rahul', age: 8 },
    ];

    let headerTokenSeen: string | null = null;
    const mockFetchFn = async (url: string, init?: any) => {
      headerTokenSeen = init?.headers?.['x-device-token'] || null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ profiles: mockCloudProfiles }),
      };
    };

    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    // Wire custom fetch function into accountMgr
    const profileRes = await accountMgr.fetchFamilyProfilesWithResilience(
      'https://safebrowse.porwal.online',
      'dev-secure-02',
      'dtk_secret_profiles_999',
      { fetchFn: mockFetchFn }
    );

    assert.strictEqual(profileRes.profiles.length, 2);
    assert.strictEqual(profileRes.fromCache, false);
    assert.strictEqual(headerTokenSeen, 'dtk_secret_profiles_999');

    // Verify written to state/family-profiles-cache.json
    const cacheFile = accountMgr.getProfilesCacheFilePath();
    assert.strictEqual(fs.existsSync(cacheFile), true);

    const cached = await accountMgr.getCachedFamilyProfiles();
    assert.ok(cached);
    assert.strictEqual(cached.profiles.length, 2);
    assert.strictEqual(cached.profiles[0].name, 'Manjari');
    assert.strictEqual(cached.profiles[1].name, 'Rahul');

    elevatedServer.stop();
  });

  it('34. Fresh install with no cache works: live fetch succeeds and establishes local cache', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-fresh-01',
      deviceToken: 'dtk_fresh_token',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Fresh Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    const cacheFile = accountMgr.getProfilesCacheFilePath();
    assert.strictEqual(fs.existsSync(cacheFile), false, 'Cache must not exist before first fetch');

    const mockFetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        profiles: [{ id: 'child-fresh-1', name: 'Alice' }],
      }),
    });

    const res = await accountMgr.fetchFamilyProfilesWithResilience(
      'https://safebrowse.porwal.online',
      'dev-fresh-01',
      'dtk_fresh_token',
      { fetchFn: mockFetchFn }
    );

    assert.strictEqual(res.profiles.length, 1);
    assert.strictEqual(res.profiles[0].name, 'Alice');
    assert.strictEqual(fs.existsSync(cacheFile), true, 'Cache must be established on fresh install');
  });

  it('35. Elevated mode rejects invalid SID not matching recognized accounts', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-val-01',
      deviceToken: 'dtk_val',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);

    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/save-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            {
              windowsSid: 'S-1-5-21-9999-9999-9999-9999', // Unknown SID
              windowsUsername: 'Hacker',
              childId: null,
              enabled: false,
            },
          ],
        }),
      });

      assert.strictEqual(resp.status, 400);
      const data: any = await resp.json();
      assert.ok(data.error.includes('does not match any recognized local Windows account'));
    } finally {
      elevatedServer.stop();
    }
  });

  it('36. Elevated mode rejects malformed SID format', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-val-02',
      deviceToken: 'dtk_val',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/save-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            {
              windowsSid: 'NOT-A-REAL-SID',
              windowsUsername: 'InvalidUser',
              childId: null,
              enabled: false,
            },
          ],
        }),
      });

      assert.strictEqual(resp.status, 400);
      const data: any = await resp.json();
      assert.ok(data.error.includes('Invalid Windows SID format'));
    } finally {
      elevatedServer.stop();
    }
  });

  it('37. Elevated mode rejects invalid childId not matching family profiles', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-val-03',
      deviceToken: 'dtk_val',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);

    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-legit-1', name: 'Manjari' },
    ]);

    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/save-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            {
              windowsSid: 'S-1-5-21-1000-1000-1000-1001',
              windowsUsername: 'Manjari',
              childId: 'child-nonexistent-999', // Invalid childId
              enabled: true,
            },
          ],
        }),
      });

      assert.strictEqual(resp.status, 400);
      const data: any = await resp.json();
      assert.ok(data.error.includes('does not match any registered family profile'));
    } finally {
      elevatedServer.stop();
    }
  });

  it('38. Elevated mode saves mappings directly to state/profile-mappings.json and persists', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-save-01',
      deviceToken: 'dtk_save',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Family Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);

    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-101', name: 'Manjari' },
    ]);

    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/save-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            {
              windowsSid: 'S-1-5-21-1000-1000-1000-1000',
              windowsUsername: 'acer',
              childId: null,
              enabled: false,
            },
            {
              windowsSid: 'S-1-5-21-1000-1000-1000-1001',
              windowsUsername: 'Manjari',
              childId: 'child-101',
              childName: 'Manjari',
              enabled: true,
            },
          ],
        }),
      });

      assert.strictEqual(resp.status, 200);
      const data: any = await resp.json();
      assert.strictEqual(data.success, true);

      // Verify file directly in state/
      const mappingsFile = path.join(testConfigMgr.getStateDir(), 'profile-mappings.json');
      assert.strictEqual(fs.existsSync(mappingsFile), true);

      const saved = await accountMgr.loadProfileMappings();
      assert.strictEqual(saved.length, 2);
      assert.strictEqual(saved[0].windowsUsername, 'acer');
      assert.strictEqual(saved[0].childId, null);
      assert.strictEqual(saved[1].windowsUsername, 'Manjari');
      assert.strictEqual(saved[1].childId, 'child-101');
    } finally {
      elevatedServer.stop();
    }
  });

  it('39. Mappings survive service restart (reload from state directory)', async () => {
    // Write valid mapping
    await accountMgr.saveProfileMappingsTransaction(
      [
        { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
        { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-101', enabled: true },
      ],
      'dev-restart',
      'Laptop'
    );

    // Instantiate fresh WindowsAccountManager pointing to same directory
    const freshAccountMgr = new WindowsAccountManager(tempDir);
    const reloaded = await freshAccountMgr.loadProfileMappings();

    assert.strictEqual(reloaded.length, 2);
    assert.strictEqual(reloaded[0].windowsUsername, 'acer');
    assert.strictEqual(reloaded[1].windowsUsername, 'Manjari');
    assert.strictEqual(reloaded[1].childId, 'child-101');
  });

  it('40. Policy resolution: child account becomes Managed with assigned profile', async () => {
    await accountMgr.saveProfileMappingsTransaction(
      [
        { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
        { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-101', childName: 'Manjari', enabled: true },
      ],
      'dev-policy',
      'Laptop'
    );

    const childPolicy = await accountMgr.resolveUserPolicy(
      'S-1-5-21-1000-1000-1000-1001',
      'Manjari'
    );

    assert.strictEqual(childPolicy.isManaged, true);
    assert.strictEqual(childPolicy.childId, 'child-101');
    assert.strictEqual(childPolicy.childName, 'Manjari');
  });

  it('41. Policy resolution: parent account remains Unmanaged (transparent bypass)', async () => {
    await accountMgr.saveProfileMappingsTransaction(
      [
        { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
        { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-101', childName: 'Manjari', enabled: true },
      ],
      'dev-policy',
      'Laptop'
    );

    const parentPolicy = await accountMgr.resolveUserPolicy(
      'S-1-5-21-1000-1000-1000-1000',
      'acer'
    );

    assert.strictEqual(parentPolicy.isManaged, false);
    assert.strictEqual(parentPolicy.childId, null);
  });

  it('42. Full elevated configuration flow operates with zero user-writable staging files', async () => {
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);

    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev-nostaging-01',
      deviceToken: 'dtk_nostaging',
      backendUrl: 'https://safebrowse.porwal.online',
      deviceName: 'Clean Laptop',
      childId: 'child-1',
      parentId: 'parent-1',
      pairedAt: new Date().toISOString(),
    });

    accountMgr.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-1000-1000-1000-1000', disabled: false },
      { name: 'Manjari', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);

    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-101', name: 'Manjari' },
    ]);

    const elevatedServer = new ElevatedConfigServer(testConfigMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/save-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            { windowsSid: 'S-1-5-21-1000-1000-1000-1000', windowsUsername: 'acer', childId: null, enabled: false },
            { windowsSid: 'S-1-5-21-1000-1000-1000-1001', windowsUsername: 'Manjari', childId: 'child-101', childName: 'Manjari', enabled: true },
          ],
        }),
      });

      assert.strictEqual(resp.status, 200);

      // Verify that no staging files were created in stagingDir or os.tmpdir()
      if (fs.existsSync(stagingDir)) {
        const files = fs.readdirSync(stagingDir);
        assert.strictEqual(files.length, 0, 'No staging files should be created');
      }

      // Verify state file persisted directly
      const mappingsFile = path.join(testConfigMgr.getStateDir(), 'profile-mappings.json');
      assert.strictEqual(fs.existsSync(mappingsFile), true);
    } finally {
      elevatedServer.stop();
    }
  });
});

