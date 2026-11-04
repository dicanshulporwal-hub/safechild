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
} from '../src/account-manager';
import { ConfigManager, DeviceConfig } from '../src/config-manager';
import { WindowsSessionMonitor } from '../src/session-monitor';
import { ParentPinManager } from '../src/parent-pin-manager';
import { GuiServer } from '../src/gui-server';
import { ElevatedConfigServer } from '../src/elevated-config-server';

describe('SafeBrowse Windows Pilot — Account Roles & Identification Suite', () => {
  let tempDir: string;
  let accountMgr: WindowsAccountManager;
  let configMgr: ConfigManager;
  let pinMgr: ParentPinManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acc-roles-test-'));
    configMgr = new ConfigManager(tempDir);
    accountMgr = new WindowsAccountManager(tempDir);
    pinMgr = new ParentPinManager(configMgr);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // 1. Mapped Child Account
  // =========================================================================
  it('1. Mapped Child Account: authoritative role is CHILD, marked as protected or bypassed', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1001',
        windowsUsername: 'Manjari',
        childId: 'child-manjari-uuid',
        childName: 'Manjari',
        enabled: true,
        accountType: 'CHILD',
      },
    ];

    await accountMgr.saveProfileMappingsTransaction(mappings, 'dev-laptop-1', 'Family Laptop', {
      isElevated: true,
    });

    // Authoritative resolveUserPolicy
    const resolved = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1001', 'Manjari');
    assert.strictEqual(resolved.accountType, 'CHILD');
    assert.strictEqual(resolved.isMapped, true);
    assert.strictEqual(resolved.isManaged, true);
    assert.strictEqual(resolved.childName, 'Manjari');
    assert.strictEqual(resolved.childId, 'child-manjari-uuid');

    // deriveAccountRole helper
    assert.strictEqual(accountMgr.deriveAccountRole(mappings[0]), 'CHILD');

    // If protection is disabled (temporarily bypassed), role MUST remain CHILD (not mislabeled as Parent)
    const bypassedChild: WindowsProfileMapping = {
      ...mappings[0],
      enabled: false,
    };
    await accountMgr.saveProfileMappingsTransaction([bypassedChild], 'dev-laptop-1', 'Family Laptop', {
      isElevated: true,
    });
    const resolvedBypassed = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1001', 'Manjari');
    assert.strictEqual(resolvedBypassed.accountType, 'CHILD', 'Bypassed child account must retain CHILD accountType');
    assert.strictEqual(resolvedBypassed.isManaged, false, 'isManaged should be false when enabled is false');
    assert.strictEqual(resolvedBypassed.isMapped, true);
  });

  // =========================================================================
  // 2. Mapped Parent Account
  // =========================================================================
  it('2. Mapped Parent Account: authoritative role is PARENT, unmanaged with bypass protection', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1002',
        windowsUsername: 'Anshul',
        childId: null,
        childName: null,
        enabled: false,
        accountType: 'PARENT',
      },
    ];

    await accountMgr.saveProfileMappingsTransaction(mappings, 'dev-laptop-1', 'Family Laptop', {
      isElevated: true,
    });

    const resolved = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1002', 'Anshul');
    assert.strictEqual(resolved.accountType, 'PARENT');
    assert.strictEqual(resolved.isMapped, true);
    assert.strictEqual(resolved.isManaged, false);
    assert.strictEqual(resolved.childId, null);
    assert.strictEqual(resolved.childName, null);

    // deriveAccountRole helper
    assert.strictEqual(accountMgr.deriveAccountRole(mappings[0]), 'PARENT');
  });

  // =========================================================================
  // 3. Unmapped Windows Account
  // =========================================================================
  it('3. Unmapped Windows Account: authoritative role is NOT_ASSIGNED, not guessed as Parent or Child', async () => {
    // Zero mappings saved
    const resolved = await accountMgr.resolveUserPolicy('S-1-5-21-1000-9999', 'GuestUser');
    assert.strictEqual(resolved.accountType, 'NOT_ASSIGNED', 'Unmapped account must be NOT_ASSIGNED');
    assert.strictEqual(resolved.isMapped, false);
    assert.strictEqual(resolved.isManaged, false);

    // deriveAccountRole with undefined/null
    assert.strictEqual(accountMgr.deriveAccountRole(null), 'NOT_ASSIGNED');
    assert.strictEqual(accountMgr.deriveAccountRole(undefined), 'NOT_ASSIGNED');
  });

  // =========================================================================
  // 4. Offline Startup Using Cached Mapping
  // =========================================================================
  it('4. Offline startup using cached mapping loads authoritative roles without cloud', async () => {
    // Pre-populate profile-mappings.json in the state directory
    const stateDir = configMgr.getStateDir();
    fs.mkdirSync(stateDir, { recursive: true });

    const cachedData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-laptop-offline',
      deviceName: 'Offline Laptop',
      mappings: [
        {
          windowsSid: 'S-1-5-21-1000-2001',
          windowsUsername: 'ManjariChild',
          childId: 'child-123',
          childName: 'Manjari',
          enabled: true,
          accountType: 'CHILD',
        },
        {
          windowsSid: 'S-1-5-21-1000-2002',
          windowsUsername: 'AnshulParent',
          childId: null,
          childName: null,
          enabled: false,
          accountType: 'PARENT',
        },
      ],
    };

    fs.writeFileSync(path.join(stateDir, 'profile-mappings.json'), JSON.stringify(cachedData, null, 2), 'utf8');

    // Fresh account manager reading from same directory without any cloud calls
    const offlineAccountMgr = new WindowsAccountManager(tempDir);
    const loadedMappings = await offlineAccountMgr.loadProfileMappings();

    assert.strictEqual(loadedMappings.length, 2);
    assert.strictEqual(loadedMappings[0].accountType, 'CHILD');
    assert.strictEqual(loadedMappings[0].childName, 'Manjari');
    assert.strictEqual(loadedMappings[1].accountType, 'PARENT');
    assert.strictEqual(loadedMappings[1].childId, null);

    // Policy resolution from offline cache
    const childPolicy = await offlineAccountMgr.resolveUserPolicy('S-1-5-21-1000-2001', 'ManjariChild');
    assert.strictEqual(childPolicy.accountType, 'CHILD');
    assert.strictEqual(childPolicy.isManaged, true);

    const parentPolicy = await offlineAccountMgr.resolveUserPolicy('S-1-5-21-1000-2002', 'AnshulParent');
    assert.strictEqual(parentPolicy.accountType, 'PARENT');
    assert.strictEqual(parentPolicy.isManaged, false);

    const unmappedPolicy = await offlineAccountMgr.resolveUserPolicy('S-1-5-21-1000-2099', 'Stranger');
    assert.strictEqual(unmappedPolicy.accountType, 'NOT_ASSIGNED');
    assert.strictEqual(unmappedPolicy.isMapped, false);
  });

  // =========================================================================
  // 5. Mapping Refresh After Synchronization
  // =========================================================================
  it('5. Mapping refresh after synchronization updates policy dynamically without restart', async () => {
    // Initial mapping: UserA is Parent, UserB is Child
    const initialMappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-3001',
        windowsUsername: 'UserA',
        childId: null,
        childName: null,
        enabled: false,
        accountType: 'PARENT',
      },
      {
        windowsSid: 'S-1-5-21-1000-3002',
        windowsUsername: 'UserB',
        childId: 'child-b',
        childName: 'Child B',
        enabled: true,
        accountType: 'CHILD',
      },
    ];

    await accountMgr.saveProfileMappingsTransaction(initialMappings, 'dev-laptop-1', 'Family Laptop', {
      isElevated: true,
    });

    let polA = await accountMgr.resolveUserPolicy('S-1-5-21-1000-3001', 'UserA');
    let polB = await accountMgr.resolveUserPolicy('S-1-5-21-1000-3002', 'UserB');
    assert.strictEqual(polA.accountType, 'PARENT');
    assert.strictEqual(polB.accountType, 'CHILD');

    // Synchronization updates: UserA becomes Child, UserB becomes Parent
    const updatedMappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-3001',
        windowsUsername: 'UserA',
        childId: 'child-a',
        childName: 'Child A',
        enabled: true,
        accountType: 'CHILD',
      },
      {
        windowsSid: 'S-1-5-21-1000-3002',
        windowsUsername: 'UserB',
        childId: null,
        childName: null,
        enabled: false,
        accountType: 'PARENT',
      },
    ];

    await accountMgr.saveProfileMappingsTransaction(updatedMappings, 'dev-laptop-1', 'Family Laptop', {
      isElevated: true,
    });

    polA = await accountMgr.resolveUserPolicy('S-1-5-21-1000-3001', 'UserA');
    polB = await accountMgr.resolveUserPolicy('S-1-5-21-1000-3002', 'UserB');
    assert.strictEqual(polA.accountType, 'CHILD');
    assert.strictEqual(polA.isManaged, true);
    assert.strictEqual(polB.accountType, 'PARENT');
    assert.strictEqual(polB.isManaged, false);
  });

  // =========================================================================
  // 6. Switching Between Parent and Child Windows Sessions
  // =========================================================================
  it('6. Switching between Parent and Child Windows sessions triggers userChanged and updates policy', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-4001',
        windowsUsername: 'ParentUser',
        childId: null,
        childName: null,
        enabled: false,
        accountType: 'PARENT',
      },
      {
        windowsSid: 'S-1-5-21-1000-4002',
        windowsUsername: 'ChildUser',
        childId: 'child-c',
        childName: 'Child C',
        enabled: true,
        accountType: 'CHILD',
      },
    ];

    await accountMgr.saveProfileMappingsTransaction(mappings, 'dev-laptop-1', 'Family Laptop', {
      isElevated: true,
    });

    // Initialize session monitor with 100ms interval
    const sessionMonitor = new WindowsSessionMonitor(100, accountMgr);

    // Initial check establishes baseline as ParentUser
    sessionMonitor.setMockConsoleUser('ParentUser', 'S-1-5-21-1000-4001');
    const p1 = await sessionMonitor.pollActiveSession();
    assert.strictEqual(p1?.accountType, 'PARENT');
    assert.strictEqual(p1?.isManaged, false);

    // Switch to Child user
    sessionMonitor.setMockConsoleUser('ChildUser', 'S-1-5-21-1000-4002');
    const p2 = await sessionMonitor.pollActiveSession();
    assert.strictEqual(p2?.accountType, 'CHILD');
    assert.strictEqual(p2?.isManaged, true);
    assert.strictEqual(p2?.childName, 'Child C');

    // Switch back to Parent user
    sessionMonitor.setMockConsoleUser('ParentUser', 'S-1-5-21-1000-4001');
    const p3 = await sessionMonitor.pollActiveSession();
    assert.strictEqual(p3?.accountType, 'PARENT');
    assert.strictEqual(p3?.isManaged, false);

    sessionMonitor.stop();
  });

  // =========================================================================
  // 7. Loading / Sync Hygiene & UI Badges in GuiServer
  // =========================================================================
  it('7. Loading & sync hygiene: initial DOM displays Checking account... and never wrong role', async () => {
    const gui = new GuiServer();
    const html = (gui as any).renderHtml();

    // Verify initial HTML DOM values for active user
    assert.ok(
      html.includes('id="statUser">Checking account...</div>'),
      'DOM #statUser must initialize to "Checking account..."'
    );
    assert.ok(
      html.includes('id="statUserSid">Checking account...</div>'),
      'DOM #statUserSid must initialize to "Checking account..."'
    );

    // Verify CSS role badge classes exist in HTML
    assert.ok(html.includes('.badge-role'));
    assert.ok(html.includes('.badge-child'));
    assert.ok(html.includes('.badge-parent'));
    assert.ok(html.includes('.badge-unassigned'));

    // Verify Account Role table headers exist
    assert.ok(html.includes('<th>Account Role</th>') || html.includes('<th style="padding: 10px 16px;">Account Role</th>'));
  });

  // =========================================================================
  // 8. GuiServer GET /api/status and GET /api/accounts End-to-End Roles
  // =========================================================================
  it('8. GuiServer GET /api/status and GET /api/accounts expose authoritative roles and mappings', async () => {
    // Configure device
    const testConfig: DeviceConfig = {
      deviceId: 'dev-laptop-test-1',
      deviceName: 'Family Laptop',
      parentId: 'parent-1',
      childId: 'child-1',
      deviceToken: 'token-abc',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
    };
    await configMgr.saveDeviceConfig(testConfig);

    // Save mappings: Account 1 is Child, Account 2 is Parent
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-5001',
        windowsUsername: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        enabled: true,
        accountType: 'CHILD',
      },
      {
        windowsSid: 'S-1-5-21-1000-5002',
        windowsUsername: 'Anshul',
        childId: null,
        childName: null,
        enabled: false,
        accountType: 'PARENT',
      },
    ];
    await accountMgr.saveProfileMappingsTransaction(mappings, 'dev-laptop-test-1', 'Family Laptop', {
      isElevated: true,
    });

    // Set active session as Child
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-5001', 'Manjari');
    accountMgr.setMockAccountsForTesting([
      { name: 'Manjari', sid: 'S-1-5-21-1000-5001', disabled: false },
      { name: 'Anshul', sid: 'S-1-5-21-1000-5002', disabled: false },
      { name: 'UnassignedVisitor', sid: 'S-1-5-21-1000-5099', disabled: false },
    ]);

    const gui = new GuiServer(configMgr, accountMgr, undefined, pinMgr);
    const port = await gui.start(0);

    try {
      // 1. GET /api/status
      const statRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(statRes.status, 200);
      const statData = await statRes.json() as any;

      assert.strictEqual(statData.activeSession.username, 'Manjari');
      assert.strictEqual(statData.activeSession.accountType, 'CHILD');
      assert.strictEqual(statData.activeSession.isManaged, true);
      assert.strictEqual(statData.activeSession.isMapped, true);

      // Verify mappings in /api/status contain accountType
      const m1 = statData.mappings.find((m: any) => m.windowsUsername === 'Manjari');
      const m2 = statData.mappings.find((m: any) => m.windowsUsername === 'Anshul');
      assert.strictEqual(m1.accountType, 'CHILD');
      assert.strictEqual(m2.accountType, 'PARENT');

      // 2. GET /api/accounts
      const accRes = await fetch(`http://127.0.0.1:${port}/api/accounts`);
      assert.strictEqual(accRes.status, 200);
      const accData = await accRes.json() as any;

      const accChild = accData.accounts.find((a: any) => a.name === 'Manjari');
      const accParent = accData.accounts.find((a: any) => a.name === 'Anshul');
      const accUnassigned = accData.accounts.find((a: any) => a.name === 'UnassignedVisitor');

      assert.strictEqual(accChild.accountType, 'CHILD');
      assert.strictEqual(accChild.isMapped, true);
      assert.strictEqual(accChild.isProtected, true);

      assert.strictEqual(accParent.accountType, 'PARENT');
      assert.strictEqual(accParent.isMapped, true);
      assert.strictEqual(accParent.isProtected, false);

      assert.strictEqual(accUnassigned.accountType, 'NOT_ASSIGNED');
      assert.strictEqual(accUnassigned.isMapped, false);
      assert.strictEqual(accUnassigned.isProtected, false);
    } finally {
      gui.stop();
    }
  });

  // =========================================================================
  // 9. ElevatedConfigServer GET /api/config-state and Role Badges
  // =========================================================================
  it('9. ElevatedConfigServer GET /api/config-state provides accountType and isMapped for all accounts', async () => {
    const testConfig: DeviceConfig = {
      deviceId: 'dev-laptop-elevated',
      deviceName: 'Family Laptop',
      parentId: 'parent-1',
      childId: 'child-1',
      deviceToken: 'token-elevated',
      backendUrl: 'https://safebrowse.porwal.online',
      pairedAt: new Date().toISOString(),
    };
    await configMgr.saveDeviceConfig(testConfig);

    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-6001',
        windowsUsername: 'Manjari',
        childId: 'child-1',
        childName: 'Manjari',
        enabled: true,
        accountType: 'CHILD',
      },
    ];
    await accountMgr.saveProfileMappingsTransaction(mappings, 'dev-laptop-elevated', 'Family Laptop', {
      isElevated: true,
    });

    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-6001', 'Manjari');
    accountMgr.setMockAccountsForTesting([
      { name: 'Manjari', sid: 'S-1-5-21-1000-6001', disabled: false },
      { name: 'UnassignedVisitor', sid: 'S-1-5-21-1000-6099', disabled: false },
    ]);

    const elevatedServer = new ElevatedConfigServer(configMgr, accountMgr);
    const port = await elevatedServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config-state`);
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;

      const accChild = data.accounts.find((a: any) => a.name === 'Manjari');
      const accUnassigned = data.accounts.find((a: any) => a.name === 'UnassignedVisitor');

      assert.strictEqual(accChild.accountType, 'CHILD');
      assert.strictEqual(accChild.isMapped, true);

      assert.strictEqual(accUnassigned.accountType, 'NOT_ASSIGNED');
      assert.strictEqual(accUnassigned.isMapped, false);

      // Verify HTML template contains badge styles and Account Role header
      const html = (elevatedServer as any).renderHtml();
      assert.ok(html.includes('.badge-role'));
      assert.ok(html.includes('.badge-child'));
      assert.ok(html.includes('.badge-parent'));
      assert.ok(html.includes('.badge-unassigned'));
      assert.ok(html.includes('<th style="padding: 10px 16px;">Account Role</th>'));
    } finally {
      elevatedServer.stop();
    }
  });
});
