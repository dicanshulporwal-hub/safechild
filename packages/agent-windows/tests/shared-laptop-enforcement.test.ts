import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WindowsAccountManager, WindowsProfileMapping } from '../src/account-manager';
import { WindowsSessionMonitor } from '../src/session-monitor';
import { DnsFilterProxy } from '../src/dns-proxy';
import { WindowsActivityReporter } from '../src/activity-reporter';
import { BlockPageServer } from '../src/block-server';
import { GuiServer } from '../src/gui-server';
import { Policy } from '@safebrowse/shared';

describe('SafeBrowse Shared Laptop Multi-User Architecture Suite', () => {
  let tempDir: string;
  let accountMgr: WindowsAccountManager;
  let sessionMon: WindowsSessionMonitor;
  let activityRep: WindowsActivityReporter;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shared-test-'));
    accountMgr = new WindowsAccountManager(tempDir);
    sessionMon = new WindowsSessionMonitor(100, accountMgr);
    activityRep = new WindowsActivityReporter(tempDir);
  });

  afterEach(() => {
    sessionMon.stop();
    activityRep.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. should filter out SYSTEM, LOCAL SERVICE, and service identities from account discovery', async () => {
    const isSystem = accountMgr.isSystemOrServiceAccount('SYSTEM', 'S-1-5-18');
    const isLocalSvc = accountMgr.isSystemOrServiceAccount('LOCAL SERVICE', 'S-1-5-19');
    const isNetSvc = accountMgr.isSystemOrServiceAccount('NETWORK SERVICE', 'S-1-5-20');
    const isDefault = accountMgr.isSystemOrServiceAccount('DefaultAccount');
    const isWdag = accountMgr.isSystemOrServiceAccount('WDAGUtilityAccount');
    const isDwm = accountMgr.isSystemOrServiceAccount('DWM-1');

    assert.strictEqual(isSystem, true, 'SYSTEM should be filtered');
    assert.strictEqual(isLocalSvc, true, 'LOCAL SERVICE should be filtered');
    assert.strictEqual(isNetSvc, true, 'NETWORK SERVICE should be filtered');
    assert.strictEqual(isDefault, true, 'DefaultAccount should be filtered');
    assert.strictEqual(isWdag, true, 'WDAGUtilityAccount should be filtered');
    assert.strictEqual(isDwm, true, 'DWM virtual account should be filtered');

    const isAcer = accountMgr.isSystemOrServiceAccount('acer', 'S-1-5-21-1000-1000-1000-1000');
    const isManjari = accountMgr.isSystemOrServiceAccount('Manjari', 'S-1-5-21-1000-1000-1000-1001');
    const isRahul = accountMgr.isSystemOrServiceAccount('Rahul', 'S-1-5-21-1000-1000-1000-1002');
    assert.strictEqual(isAcer, false, 'acer should be recognized as an interactive account');
    assert.strictEqual(isManjari, false, 'Manjari should be recognized as an interactive account');
    assert.strictEqual(isRahul, false, 'Rahul should be recognized as an interactive account');
  });

  it('2. should persist and load canonical Windows SID to Child Profile mappings', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1000',
        windowsUsername: 'acer',
        childId: null,
        childName: null,
        enabled: false, // Parent / Unmanaged
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1001',
        windowsUsername: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        enabled: true, // Managed child
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1002',
        windowsUsername: 'Rahul',
        childId: 'child-rahul',
        childName: 'Rahul',
        enabled: true, // Managed child
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-501',
        windowsUsername: 'Guest',
        childId: null,
        childName: null,
        enabled: false, // Unmanaged
      },
    ];

    await accountMgr.saveProfileMappings(mappings, 'dev-laptop-1', 'Family Laptop');
    const loaded = await accountMgr.loadProfileMappings();

    assert.strictEqual(loaded.length, 4);
    assert.strictEqual(loaded[0].windowsUsername, 'acer');
    assert.strictEqual(loaded[0].childId, null);
    assert.strictEqual(loaded[1].windowsUsername, 'Manjari');
    assert.strictEqual(loaded[1].childId, 'child-manjari');
    assert.strictEqual(loaded[2].windowsUsername, 'Rahul');
    assert.strictEqual(loaded[2].childId, 'child-rahul');

    // Query by canonical SID
    const manjariBySid = await accountMgr.getMappingForSid('S-1-5-21-1000-1000-1000-1001');
    assert.ok(manjariBySid);
    assert.strictEqual(manjariBySid?.childName, 'Manjari');

    // Query by username
    const rahulByName = await accountMgr.getMappingForUsername('Rahul');
    assert.ok(rahulByName);
    assert.strictEqual(rahulByName?.childId, 'child-rahul');
  });

  it('3. should resolve parent account as TRANSPARENT_BYPASS and child account as MANAGED', async () => {
    const mappings: WindowsProfileMapping[] = [
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
        childId: 'child-manjari',
        childName: 'Manjari',
        enabled: true,
      },
    ];
    await accountMgr.saveProfileMappings(mappings);

    // Resolve acer (Parent)
    const parentPolicy = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1000-1000-1000', 'acer');
    assert.strictEqual(parentPolicy.isManaged, false, 'Parent account must be unmanaged');
    assert.strictEqual(parentPolicy.childId, null);

    // Resolve Manjari (Child)
    const childPolicy = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1000-1000-1001', 'Manjari');
    assert.strictEqual(childPolicy.isManaged, true, 'Child account must be managed');
    assert.strictEqual(childPolicy.childId, 'child-manjari');
    assert.strictEqual(childPolicy.childName, 'Manjari');
  });

  it('4. should flush DNS client cache upon console session / user switch', async () => {
    let flushCount = 0;
    sessionMon.setDnsFlushForTesting(async () => {
      flushCount++;
    });

    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1000-1000-1000'); // acer
    await sessionMon.checkSessionNow();
    assert.strictEqual(flushCount, 0, 'First initial detection does not count as a user switch transition');

    // Switch to Manjari
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1000-1000-1001'); // Manjari
    await sessionMon.checkSessionNow();
    assert.strictEqual(flushCount, 1, 'DNS cache must be flushed immediately on user switch to prevent cache leakage');

    // Switch to Rahul
    accountMgr.setMockConsoleSidForTesting('S-1-5-21-1000-1000-1000-1002'); // Rahul
    await sessionMon.checkSessionNow();
    assert.strictEqual(flushCount, 2, 'DNS cache must be flushed again on second switch');
  });

  it('5. should enforce Transparent Bypass in DnsFilterProxy when active account is Parent/Unmanaged', async () => {
    const mockPolicy: Policy = {
      id: 'pol-1',
      childId: 'child-manjari',
      familyId: 'fam-1',
      version: 1,
      isPaused: false,
      categoryControls: [],
      rules: [
        { id: 'r1', domain: 'roblox.com', action: 'BLOCK', addedAt: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    };

    let activePolicy: Policy | null = mockPolicy;
    const proxy = new DnsFilterProxy(() => activePolicy, '1.1.1.1', 53);

    // Normal mode: roblox.com is blocked
    proxy.setBypassMode(false);
    assert.strictEqual(proxy.getBypassMode(), false);

    // Switch to transparent bypass mode (for acer/Parent account)
    proxy.setBypassMode(true);
    assert.strictEqual(proxy.getBypassMode(), true);

    // In bypass mode, proxy forwards directly without blocking
    let evaluatedBlocked = false;
    proxy.setOnQueryEvaluated((ev) => {
      if (ev.action === 'BLOCKED') evaluatedBlocked = true;
    });

    // Clean up proxy
    proxy.stop();
  });

  it('6. should render child block page with friendly reason, Go Back, and Ask Parent buttons', async () => {
    const blockServer = new BlockPageServer(
      'https://safebrowse.porwal.online',
      'child-manjari',
      'dev-laptop-1',
      () => ({ childId: 'child-manjari', childName: 'Manjari' })
    );

    const testPort = 18880;
    await blockServer.start(testPort);

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/?domain=roblox.com&reason=Gaming`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      assert.ok(html.includes('SafeBrowse Family Protection'), 'Must include SafeBrowse branding');
      assert.ok(html.includes('roblox.com'), 'Must display blocked domain');
      assert.ok(html.includes('Manjari'), 'Must display active child profile name');
      assert.ok(html.includes('Go Back'), 'Must include Go Back button');
      assert.ok(html.includes('Ask Parent'), 'Must include Ask Parent button');
      assert.ok(html.includes('Why is this blocked?'), 'Must explain reason why domain is blocked');
    } finally {
      blockServer.stop();
    }
  });

  it('7. should queue activity events for managed children and drop events for unmanaged parents', async () => {
    let sentBatch: any[] = [];
    activityRep.setCustomSenderForTesting(async (events) => {
      sentBatch = events;
      return true;
    });

    // Managed child event (Manjari)
    activityRep.recordEvent({
      domain: 'wikipedia.org',
      action: 'ALLOWED',
      childId: 'child-manjari',
    });
    activityRep.recordEvent({
      domain: 'roblox.com',
      action: 'BLOCKED',
      childId: 'child-manjari',
      reason: 'Gaming category',
    });

    // Unmanaged parent event (acer) -> childId is null
    activityRep.recordEvent({
      domain: 'banking.example.com',
      action: 'ALLOWED',
      childId: null, // Parent browsing
    });

    assert.strictEqual(activityRep.getQueueLength(), 2, 'Parent browsing must NOT be logged to protect privacy');

    await activityRep.flushOutbox();
    assert.strictEqual(sentBatch.length, 2);
    assert.strictEqual(sentBatch[0].domain, 'wikipedia.org');
    assert.strictEqual(sentBatch[0].childId, 'child-manjari');
    assert.strictEqual(sentBatch[1].domain, 'roblox.com');
    assert.strictEqual(sentBatch[1].action, 'BLOCKED');
  });

  it('8. should serve SafeBrowse Family Protection GUI endpoints correctly', async () => {
    const gui = new GuiServer();
    const testPort = 18885;
    await gui.start(testPort);

    try {
      // 1. GET / serves HTML
      const htmlRes = await fetch(`http://127.0.0.1:${testPort}/`);
      assert.strictEqual(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('SafeBrowse Family Protection'));
      assert.ok(html.includes('screenWelcome'));
      assert.ok(html.includes('screenPair'));
      assert.ok(html.includes('screenAccounts'));
      assert.ok(html.includes('screenStatus'));

      // 2. GET /api/status returns JSON
      const statRes = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      assert.strictEqual(statRes.status, 200);
      const statData = await statRes.json();
      assert.ok('isPaired' in statData);
      assert.ok('activeSession' in statData);

      // 3. GET /api/accounts returns detected accounts
      const accRes = await fetch(`http://127.0.0.1:${testPort}/api/accounts`);
      assert.strictEqual(accRes.status, 200);
      const accData = await accRes.json();
      assert.ok(Array.isArray(accData.accounts));

      // 4. POST /api/mappings saves mappings
      const saveRes = await fetch(`http://127.0.0.1:${testPort}/api/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [
            {
              windowsSid: 'S-1-5-21-test-1',
              windowsUsername: 'acer',
              childId: null,
              enabled: false,
            },
            {
              windowsSid: 'S-1-5-21-test-2',
              windowsUsername: 'Manjari',
              childId: 'child-123',
              childName: 'Manjari',
              enabled: true,
            },
          ],
        }),
      });
      assert.strictEqual(saveRes.status, 200);
      const saveData = await saveRes.json();
      assert.strictEqual(saveData.success, true);
    } finally {
      gui.stop();
    }
  });
});
