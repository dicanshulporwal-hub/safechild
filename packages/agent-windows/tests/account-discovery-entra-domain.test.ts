import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

process.env.NODE_ENV = 'test';
import {
  WindowsAccountManager,
  WindowsProfileMapping,
  WindowsAccount,
  FamilyChildProfile,
} from '../src/account-manager';
import { ConfigManager } from '../src/config-manager';

describe('SafeBrowse Windows Pilot — Stage C.3.2 Azure AD / Entra & Domain Account Discovery', () => {
  let tempDir: string;
  let accountMgr: WindowsAccountManager;
  let configMgr: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-entra-test-'));
    accountMgr = new WindowsAccountManager(tempDir);
    configMgr = new ConfigManager(tempDir);
    const stagingDir = path.join(tempDir, 'staging');
    accountMgr.setStagingDirForTesting(stagingDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Scenario 1: Local account discovery works
  it('1. Local account discovery works and discovers local users', async () => {
    accountMgr.setMockAccountsForTesting([
      { name: 'LocalAdmin', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
      { name: 'LocalKid', sid: 'S-1-5-21-1000-1000-1000-1002', disabled: false },
    ]);
    const accounts = await accountMgr.discoverAccounts();
    assert.strictEqual(accounts.length, 2);
    assert.ok(accounts.some(a => a.name === 'LocalAdmin'));
    assert.ok(accounts.some(a => a.name === 'LocalKid'));
  });

  // Scenario 2: AzureAD active console identity (AzureAD\AnshulPorwal + S-1-12-1-...) appears in discovery
  it('2. AzureAD active console identity (AzureAD\\AnshulPorwal with S-1-12-1-...) appears in discovery', async () => {
    accountMgr.setMockAccountsForTesting([
      { name: 'LocalUser', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);
    const azureAdSid = 'S-1-12-1-3984729102-1293847583-2938475839-1029384758';
    accountMgr.setMockConsoleSessionForTesting(azureAdSid, 'AzureAD\\AnshulPorwal');

    const accounts = await accountMgr.discoverAccounts();
    const azureAdAccount = accounts.find(a => a.sid === azureAdSid);
    assert.ok(azureAdAccount, 'AzureAD account must be discovered');
    assert.strictEqual(azureAdAccount?.name, 'AzureAD\\AnshulPorwal');
    assert.strictEqual(azureAdAccount?.isCurrentConsoleUser, true);
  });

  // Scenario 3: DOMAIN\User appears with domain prefix intact
  it('3. Domain account (CORP\\Alice) appears in discovery with domain intact', async () => {
    accountMgr.setMockAccountsForTesting([
      { name: 'CORP\\Alice', sid: 'S-1-5-21-5000-5000-5000-1001', disabled: false },
    ]);
    const accounts = await accountMgr.discoverAccounts();
    const domainAccount = accounts.find(a => a.name === 'CORP\\Alice');
    assert.ok(domainAccount, 'Domain account must be present');
    assert.strictEqual(domainAccount?.name, 'CORP\\Alice');
    assert.strictEqual(domainAccount?.sid, 'S-1-5-21-5000-5000-5000-1001');
  });

  // Scenario 4: Active interactive identity appears even when Win32_UserAccount returns none
  it('4. Active interactive identity appears even when Win32_UserAccount returns none', async () => {
    // Physical reproduction: local account list is empty on Entra-only laptop
    accountMgr.setMockAccountsForTesting([]);
    const azureAdSid = 'S-1-12-1-8888888888-7777777777-6666666666-5555555555';
    accountMgr.setMockConsoleSessionForTesting(azureAdSid, 'AzureAD\\AnshulPorwal');

    const accounts = await accountMgr.discoverAccounts();
    assert.strictEqual(accounts.length, 1, 'Should discover the active console identity');
    assert.strictEqual(accounts[0].sid, azureAdSid);
    assert.strictEqual(accounts[0].name, 'AzureAD\\AnshulPorwal');
    assert.strictEqual(accounts[0].isCurrentConsoleUser, true);
  });

  // Scenario 5: Duplicate SID from multiple sources is returned once
  it('5. Duplicate SID across multiple discovery sources is deduplicated and marked correctly', async () => {
    const commonSid = 'S-1-12-1-3984729102-1293847583-2938475839-1029384758';
    // Base discovery returned non-qualified name
    accountMgr.setMockAccountsForTesting([
      { name: 'AnshulPorwal', sid: commonSid, disabled: false },
    ]);
    // Console session has fully qualified name
    accountMgr.setMockConsoleSessionForTesting(commonSid, 'AzureAD\\AnshulPorwal');

    const accounts = await accountMgr.discoverAccounts();
    assert.strictEqual(accounts.length, 1, 'Should deduplicate account with identical SID');
    assert.strictEqual(accounts[0].sid, commonSid);
    assert.strictEqual(accounts[0].name, 'AzureAD\\AnshulPorwal', 'Should prefer qualified domain name');
    assert.strictEqual(accounts[0].isCurrentConsoleUser, true);
  });

  // Scenario 6: SYSTEM and service identities are excluded
  it('6. SYSTEM and service identities are strictly excluded from discovery and classification', async () => {
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('SYSTEM', 'S-1-5-18'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('LOCAL SERVICE', 'S-1-5-19'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('NETWORK SERVICE', 'S-1-5-20'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('AppPoolIdentity', 'S-1-5-82-12345'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('NT SERVICE\\TrustedInstaller'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('NT AUTHORITY\\SYSTEM'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('DefaultAccount', 'S-1-5-21-1000-1000-1000-503'), true);
    assert.strictEqual(accountMgr.isSystemOrServiceAccount('Administrator', 'S-1-5-21-1000-1000-1000-500'), true);

    // AzureAD SIDs and accounts must NEVER be filtered as service account
    assert.strictEqual(
      accountMgr.isSystemOrServiceAccount('AzureAD\\AnshulPorwal', 'S-1-12-1-3984729102-1293847583-2938475839-1029384758'),
      false
    );

    // Verify discovery excludes them
    accountMgr.setMockAccountsForTesting([
      { name: 'SYSTEM', sid: 'S-1-5-18', disabled: false },
      { name: 'LOCAL SERVICE', sid: 'S-1-5-19', disabled: false },
      { name: 'AzureAD\\AnshulPorwal', sid: 'S-1-12-1-3984729102-1293847583-2938475839-1029384758', disabled: false },
    ]);
    const accounts = await accountMgr.discoverAccounts();
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].name, 'AzureAD\\AnshulPorwal');
  });

  // Scenario 7: AzureAD SID is accepted by mapping validation
  it('7. AzureAD SID is accepted by mapping validation and persists correctly', async () => {
    const azureAdSid = 'S-1-12-1-3984729102-1293847583-2938475839-1029384758';
    accountMgr.setMockAccountsForTesting([
      { name: 'AzureAD\\AnshulPorwal', sid: azureAdSid, disabled: false },
    ]);
    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-manjari-id', name: 'Manjari' },
    ]);

    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: azureAdSid,
        windowsUsername: 'AzureAD\\AnshulPorwal',
        childId: 'child-manjari-id',
        childName: 'Manjari',
        enabled: true,
      },
    ];

    const req = await accountMgr.createMappingSaveRequest(mappings, 'dev-laptop', 'Laptop');
    const result = await accountMgr.applyMappingSaveRequest(req.nonce, { expectedDeviceId: 'dev-laptop' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.mappings.length, 1);
    assert.strictEqual(result.mappings[0].windowsSid, azureAdSid);
    assert.strictEqual(result.mappings[0].childName, 'Manjari');

    const reloaded = await accountMgr.loadProfileMappings();
    assert.strictEqual(reloaded.length, 1);
    assert.strictEqual(reloaded[0].windowsSid, azureAdSid);
  });

  // Scenario 8: Persisted AzureAD mapping resolves as managed child in resolveUserPolicy()
  it('8. Persisted AzureAD mapping resolves as managed child in resolveUserPolicy()', async () => {
    const azureAdSid = 'S-1-12-1-3984729102-1293847583-2938475839-1029384758';
    await accountMgr.saveProfileMappingsTransaction([
      {
        windowsSid: azureAdSid,
        windowsUsername: 'AzureAD\\AnshulPorwal',
        childId: 'child-manjari-id',
        childName: 'Manjari',
        enabled: true,
      },
    ]);

    // Test resolution by SID
    const policyBySid = await accountMgr.resolveUserPolicy(azureAdSid);
    assert.strictEqual(policyBySid.isManaged, true);
    assert.strictEqual(policyBySid.childId, 'child-manjari-id');
    assert.strictEqual(policyBySid.childName, 'Manjari');

    // Test resolution by fully qualified username
    const policyByFullName = await accountMgr.resolveUserPolicy(null, 'AzureAD\\AnshulPorwal');
    assert.strictEqual(policyByFullName.isManaged, true);
    assert.strictEqual(policyByFullName.childId, 'child-manjari-id');
    assert.strictEqual(policyByFullName.childName, 'Manjari');

    // Test resolution by unqualified username (bidirectional match)
    const policyByShortName = await accountMgr.resolveUserPolicy(null, 'AnshulPorwal');
    assert.strictEqual(policyByShortName.isManaged, true);
    assert.strictEqual(policyByShortName.childId, 'child-manjari-id');
    assert.strictEqual(policyByShortName.childName, 'Manjari');
  });

  // Scenario 9: Parent/unmanaged AzureAD account remains unmanaged when mapped accordingly
  it('9. Parent or unmanaged AzureAD account remains unmanaged when mapped accordingly', async () => {
    const parentSid = 'S-1-12-1-1111111111-2222222222-3333333333-4444444444';
    await accountMgr.saveProfileMappingsTransaction([
      {
        windowsSid: parentSid,
        windowsUsername: 'AzureAD\\ParentUser',
        childId: null,
        enabled: false,
      },
    ]);

    const policy = await accountMgr.resolveUserPolicy(parentSid, 'AzureAD\\ParentUser');
    assert.strictEqual(policy.isManaged, false);
    assert.strictEqual(policy.childId, null);
    assert.strictEqual(policy.childName, null);
    assert.strictEqual(policy.accountName, 'AzureAD\\ParentUser');
  });

  // Scenario 10: Existing shared-laptop and privilege invariants remain intact
  it('10. Existing security and privilege protection invariants remain intact', async () => {
    // 1. Nonce validation
    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest('invalid-nonce-uuid');
      },
      /Invalid nonce format/
    );

    // 2. Undiscovered SID is rejected during apply
    accountMgr.setMockAccountsForTesting([
      { name: 'KnownUser', sid: 'S-1-5-21-1000-1000-1000-1001', disabled: false },
    ]);
    await accountMgr.saveCachedFamilyProfiles([
      { id: 'child-1', name: 'Kid' },
    ]);
    const rogueReq = await accountMgr.createMappingSaveRequest([
      {
        windowsSid: 'S-1-5-21-9999-9999-9999-9999',
        windowsUsername: 'UnknownUser',
        childId: 'child-1',
        enabled: true,
      },
    ], 'dev-test', 'Laptop');

    await assert.rejects(
      async () => {
        await accountMgr.applyMappingSaveRequest(rogueReq.nonce, { expectedDeviceId: 'dev-test' });
      },
      /is not a valid discovered account on this machine/
    );
  });
});
