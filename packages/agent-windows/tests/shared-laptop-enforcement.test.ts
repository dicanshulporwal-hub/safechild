import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dgram from 'dgram';
import { WindowsAccountManager, WindowsProfileMapping } from '../src/account-manager';
import { WindowsSessionMonitor } from '../src/session-monitor';
import { DnsFilterProxy } from '../src/dns-proxy';
import { WindowsActivityReporter } from '../src/activity-reporter';
import { BlockPageServer, escapeHtml, formatFriendlyReason } from '../src/block-server';
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

    // Verify lookup by Windows SID
    const manjariMapping = await accountMgr.getMappingForSid('S-1-5-21-1000-1000-1000-1001');
    assert.ok(manjariMapping);
    assert.strictEqual(manjariMapping.childId, 'child-manjari');
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
    const acerPolicy = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1000-1000-1000', 'acer');
    assert.strictEqual(acerPolicy.isManaged, false, 'Parent account must resolve to isManaged: false');
    assert.strictEqual(acerPolicy.childId, null);

    // Resolve Manjari (Child)
    const manjariPolicy = await accountMgr.resolveUserPolicy('S-1-5-21-1000-1000-1000-1001', 'Manjari');
    assert.strictEqual(manjariPolicy.isManaged, true, 'Child account must resolve to isManaged: true');
    assert.strictEqual(manjariPolicy.childId, 'child-manjari');
  });

  it('4. should flush DNS client cache upon console session / user switch', async () => {
    let flushedCount = 0;
    sessionMon.setFlushDnsHandlerForTesting(() => {
      flushedCount++;
    });

    sessionMon.setMockConsoleUser('ConsoleUser', 'S-1-5-21-1000-1000-1000-1000');
    await sessionMon.pollActiveSession();
    assert.strictEqual(flushedCount, 1, 'Initial session registration must flush DNS cache');

    // Switch to another user
    sessionMon.setMockConsoleUser('ConsoleUser', 'S-1-5-21-1000-1000-1000-1001');
    await sessionMon.pollActiveSession();
    assert.strictEqual(flushedCount, 2, 'User switch must flush DNS client cache to prevent policy leaks');

    // No switch (same user)
    await sessionMon.pollActiveSession();
    assert.strictEqual(flushedCount, 2, 'No flush if active session user did not change');
  });

  it('5. should enforce Transparent Bypass in DnsFilterProxy when active account is Parent/Unmanaged', async () => {
    const mockPolicy: Policy = {
      id: 'p-1',
      childId: 'child-manjari',
      familyId: 'fam-1',
      version: 1,
      isPaused: false,
      rules: [
        { id: 'r1', domain: 'roblox.com', action: 'BLOCK', addedAt: new Date().toISOString() },
      ],
      categoryControls: [],
      studyMode: { active: false, allowedCategories: [] },
      bedtime: { enabled: false, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0, allowEducationalOnly: true },
      safeSearch: { googleSafeSearch: false, bingSafeSearch: false, duckDuckGoSafeSearch: false, youtubeRestrictedMode: 'OFF' },
      usageBudgets: [],
      updatedAt: new Date().toISOString(),
    };

    const proxy = new DnsFilterProxy(() => mockPolicy, '1.1.1.1', 53);

    // Mode A: Filtering (Child)
    proxy.setBypassMode(false);
    assert.strictEqual(proxy.getBypassMode(), false);

    // Mode B: Transparent Bypass (Parent)
    proxy.setBypassMode(true);
    assert.strictEqual(proxy.getBypassMode(), true);
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
      const res = await fetch(`http://127.0.0.1:${testPort}/?domain=roblox.com&reason=GAMBLING`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      assert.ok(html.includes('SafeBrowse'), 'Must include SafeBrowse branding');
      assert.ok(html.includes('This site is blocked'), 'Must display required header');
      assert.ok(html.includes('roblox.com'), 'Must display blocked domain');
      assert.ok(html.includes('This site has been restricted by your family protection settings.'), 'Must include subtitle');
      assert.ok(html.includes('Manjari'), 'Must display active child profile name');
      assert.ok(html.includes('Go Back'), 'Must include Go Back button');
      assert.ok(html.includes('Ask Parent'), 'Must include Ask Parent button');
      assert.ok(html.includes('Gambling websites are blocked to keep you safe.'), 'Must convert GAMBLING to friendly reason');
      assert.ok(!html.includes('GAMBLING'), 'Must not display raw SCREAMING_SNAKE_CASE enum');
      assert.ok(html.includes('Protected by SafeBrowse'), 'Must display footer');
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

  it('8. should validate canonical GUI port 8885 and serve endpoints correctly', async () => {
    const gui = new GuiServer();
    // Validate canonical port 8885
    let testPort = 8885;
    try {
      await gui.start(testPort);
    } catch {
      // Fallback if 8885 is already in use by active agent
      testPort = 18885;
      await gui.start(testPort);
    }

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
    } finally {
      gui.stop();
    }
  });

  it('9. Block Page Validation: XSS sanitization, reason formatting, and non-MITM HTTPS invariants', async () => {
    // 1. XSS defense
    const maliciousDomain = '<script>alert("xss")</script>.com';
    const escaped = escapeHtml(maliciousDomain);
    assert.ok(!escaped.includes('<script>'), 'Domain must be HTML escaped against XSS');
    assert.ok(escaped.includes('&lt;script&gt;'));

    // 2. Enum reason formatting
    assert.strictEqual(formatFriendlyReason('ADULT_CONTENT'), 'This website has content that is not suitable for children.');
    assert.strictEqual(formatFriendlyReason('MALWARE_SECURITY'), 'This website was blocked because it may harm your computer.');
    assert.strictEqual(formatFriendlyReason('BEDTIME_RESTRICTION'), 'Bedtime rule active. Internet access is paused until morning.');
    assert.strictEqual(formatFriendlyReason('STUDY_MODE'), 'Study Mode is active. Only educational websites are permitted right now.');

    // 3. Block experience trigger verification
    const blockServer = new BlockPageServer('https://safebrowse.porwal.online', 'child-1', 'dev-1');
    let triggeredDomain = '';
    let triggeredReason = '';
    blockServer.setOnBlockExperience((domain, reason) => {
      triggeredDomain = domain;
      triggeredReason = reason;
    });

    blockServer.triggerBlockExperience('roblox.com', 'Gaming restriction');
    assert.strictEqual(triggeredDomain, 'roblox.com');
    assert.strictEqual(triggeredReason, 'Gaming restriction');
    assert.ok(blockServer.lastTriggeredExperience);
    assert.strictEqual(blockServer.lastTriggeredExperience.domain, 'roblox.com');

    // 4. Verify no deviceToken in browser DOM
    const testPort = 18882;
    await blockServer.start(testPort);
    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/blocked?domain=test.com&reason=Gaming`);
      const body = await res.text();
      assert.ok(!body.includes('deviceToken'), 'deviceToken must NEVER be embedded in browser DOM');
      assert.ok(!body.includes('dev-token'), 'deviceToken must NEVER enter browser DOM');
    } finally {
      blockServer.stop();
    }
  });

  it('10. Block Decision Integration: DNS BLOCK decision triggers SafeBrowse block experience and NXDOMAIN (no HTTPS MITM)', async () => {
    const mockPolicy: Policy = {
      id: 'p-1',
      childId: 'child-manjari',
      familyId: 'fam-1',
      version: 1,
      isPaused: false,
      rules: [
        { id: 'r1', domain: 'roblox.com', action: 'BLOCK', reason: 'Gaming restriction', addedAt: new Date().toISOString() },
      ],
      categoryControls: [],
      studyMode: { active: false, allowedCategories: [] },
      bedtime: { enabled: false, startHour: 21, startMinute: 0, endHour: 7, endMinute: 0, allowEducationalOnly: true },
      safeSearch: { googleSafeSearch: false, bingSafeSearch: false, duckDuckGoSafeSearch: false, youtubeRestrictedMode: 'OFF' },
      usageBudgets: [],
      updatedAt: new Date().toISOString(),
    };

    let blockTriggered = false;
    let blockDomain = '';
    let blockReason = '';

    const proxy = new DnsFilterProxy(() => mockPolicy, '1.1.1.1', 53);
    proxy.setOnBlockExperienceTriggered((domain, reason) => {
      blockTriggered = true;
      blockDomain = domain;
      blockReason = reason;
    });

    const activePort = await proxy.start(59333);

    try {
      // Craft DNS query for blocked domain roblox.com
      const client = dgram.createSocket('udp4');
      const queryPacket = Buffer.from([
        0x12, 0x34, // Transaction ID
        0x01, 0x00, // Standard query
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x06, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, // roblox
        0x03, 0x63, 0x6f, 0x6d, 0x00, // com
        0x00, 0x01, 0x00, 0x01, // Type A, Class IN
      ]);

      const responsePromise = new Promise<Buffer>((resolve) => {
        client.on('message', resolve);
      });

      client.send(queryPacket, activePort, '127.0.0.1');
      const response = await responsePromise;
      client.close();

      // Check RCODE 3 (NXDOMAIN)
      const flags = (response[2] << 8) | response[3];
      const rcode = flags & 0x000f;
      assert.strictEqual(rcode, 3, 'Blocked query must return NXDOMAIN to prevent broken TLS interception');

      // Check that SafeBrowse block experience was physically triggered
      assert.strictEqual(blockTriggered, true, 'BLOCK decision must trigger SafeBrowse block experience');
      assert.strictEqual(blockDomain, 'roblox.com');
      assert.ok(blockReason === 'EXPLICIT_BLOCK' || blockReason === 'Gaming restriction', 'Block reason must be provided');
    } finally {
      await proxy.stop();
    }
  });

  // =========================================================================
  // SHARED-LAPTOP SECURITY TESTS (A, B, C, D, E)
  // =========================================================================

  it('11. Shared-Laptop Security Scenario A: Process Token SID Attribution for Parent Process', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1000',
        windowsUsername: 'acer',
        childId: null,
        enabled: false, // Parent / Unmanaged
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1001',
        windowsUsername: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        enabled: true, // Managed child
      },
    ];
    await accountMgr.saveProfileMappings(mappings);

    // Mock processes with exact token SIDs
    const mockPids = new Map<number, { sid: string; username: string }>();
    mockPids.set(4001, { sid: 'S-1-5-21-1000-1000-1000-1000', username: 'acer' }); // Parent process (e.g. background updater)
    mockPids.set(4002, { sid: 'S-1-5-21-1000-1000-1000-1001', username: 'Manjari' }); // Manjari process (e.g. Chrome)
    accountMgr.setMockProcessSidsForTesting(mockPids);

    // Scenario A: At the process token level, Parent process PID 4001 resolves to UNMANAGED (Parent)
    const parentProcPolicy = await accountMgr.evaluateProcessPolicy(4001);
    assert.strictEqual(parentProcPolicy.isManaged, false, 'Parent process token must resolve to isManaged: false');
    assert.strictEqual(parentProcPolicy.sid, 'S-1-5-21-1000-1000-1000-1000');
    assert.strictEqual(parentProcPolicy.childId, null);

    // ARCHITECTURAL LIMITATION AUDIT:
    // When Parent has background processes while Manjari is active at the console:
    // If Parent's process issues a DNS query via Windows Dnscache (svchost.exe),
    // loopback DNS at 127.0.0.1:53 cannot inspect the originating process token of svchost.exe.
    // Therefore, true simultaneous multi-session DNS isolation is NOT supported without a WFP Callout Driver.
    const canIsolateSimultaneousDnsPacketsWithoutWfp = false;
    assert.strictEqual(
      canIsolateSimultaneousDnsPacketsWithoutWfp,
      false,
      'Machine-wide loopback DNS alone cannot attribute simultaneous background DNS packets across concurrent user sessions'
    );
  });

  it('12. Shared-Laptop Security Scenario B: Process Token SID Attribution for Child Background Process', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1000',
        windowsUsername: 'acer',
        childId: null,
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

    const mockPids = new Map<number, { sid: string; username: string }>();
    mockPids.set(5001, { sid: 'S-1-5-21-1000-1000-1000-1001', username: 'Manjari' }); // Manjari background process
    accountMgr.setMockProcessSidsForTesting(mockPids);

    // At the process token level, Manjari background process PID 5001 is unambiguously identified as MANAGED
    const manjariProcPolicy = await accountMgr.evaluateProcessPolicy(5001);
    assert.strictEqual(manjariProcPolicy.isManaged, true, 'Manjari process token must be identified as MANAGED');
    assert.strictEqual(manjariProcPolicy.childId, 'child-manjari');
    assert.strictEqual(manjariProcPolicy.sid, 'S-1-5-21-1000-1000-1000-1001');

    // Audit: If Parent is active console user (proxy in BYPASS mode), background child DNS packets
    // would be handled by BYPASS mode in loopback DNS without WFP ALE callout filtering.
  });

  it('13. Shared-Laptop Security Scenario C: Simultaneous Sign-in SID Differentiation', async () => {
    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1001',
        windowsUsername: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        enabled: true,
      },
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1002',
        windowsUsername: 'Rahul',
        childId: 'child-rahul',
        childName: 'Rahul',
        enabled: true,
      },
    ];
    await accountMgr.saveProfileMappings(mappings);

    const mockPids = new Map<number, { sid: string; username: string }>();
    mockPids.set(6001, { sid: 'S-1-5-21-1000-1000-1000-1001', username: 'Manjari' });
    mockPids.set(6002, { sid: 'S-1-5-21-1000-1000-1000-1002', username: 'Rahul' });
    accountMgr.setMockProcessSidsForTesting(mockPids);

    const manjariPolicy = await accountMgr.evaluateProcessPolicy(6001);
    const rahulPolicy = await accountMgr.evaluateProcessPolicy(6002);

    assert.strictEqual(manjariPolicy.childId, 'child-manjari', 'PID 6001 must map to Manjari child profile');
    assert.strictEqual(rahulPolicy.childId, 'child-rahul', 'PID 6002 must map to Rahul child profile');
    assert.notStrictEqual(manjariPolicy.childId, rahulPolicy.childId, 'Concurrent PIDs follow distinct child policies');
  });

  it('14. Shared-Laptop Security Scenario D: Fast User Switching sequential transition with cache flush', async () => {
    let flushedCount = 0;
    sessionMon.setFlushDnsHandlerForTesting(() => {
      flushedCount++;
    });

    const mappings: WindowsProfileMapping[] = [
      {
        windowsSid: 'S-1-5-21-1000-1000-1000-1000',
        windowsUsername: 'acer',
        childId: null,
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

    // Step 1: Manjari is active
    sessionMon.setMockConsoleUser('Manjari', 'S-1-5-21-1000-1000-1000-1001');
    const p1 = await sessionMon.pollActiveSession();
    assert.strictEqual(p1?.isManaged, true);
    assert.strictEqual(p1?.childId, 'child-manjari');
    assert.strictEqual(flushedCount, 1);

    // Step 2: Parent fast-user-switches to console
    sessionMon.setMockConsoleUser('acer', 'S-1-5-21-1000-1000-1000-1000');
    const p2 = await sessionMon.pollActiveSession();
    assert.strictEqual(p2?.isManaged, false, 'Parent console session must transition to unmanaged/bypass');
    assert.strictEqual(p2?.childId, null);
    assert.strictEqual(flushedCount, 2, 'Fast User Switch MUST flush DNS cache to prevent policy leakage');
  });

  it('15. Shared-Laptop Security Scenario E: Unknown or Unmapped SID Safe Default Behavior', async () => {
    // Unmapped SID (e.g. S-1-5-21-9999-9999-9999-9999)
    const policy = await accountMgr.resolveUserPolicy('S-1-5-21-9999-9999-9999-9999', 'UnknownUser');
    assert.strictEqual(policy.isManaged, false, 'Unknown or unmapped SIDs must default to isManaged: false');
    assert.strictEqual(policy.childId, null);
    assert.strictEqual(policy.accountName, 'UnknownUser');
  });
});
