import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  WindowsProcessLimiter,
  isProtectedProcess,
  PROTECTED_SYSTEM_PROCESSES,
  ProcessInfo,
} from '../src/process-limiter';
import { formatFriendlyReason } from '../src/block-server';
import { Policy, evaluatePolicy } from '@safebrowse/shared';

describe('SafeBrowse Windows P0 Hotfix — Dinner Time & Bedtime Stability Test Suite', () => {
  const mockConfig = {
    deviceId: 'dev-stability-test',
    deviceToken: 'tok-stability-test',
    childId: 'child-manjari',
    parentId: 'parent-acer',
    deviceName: "Family Shared Laptop",
    backendUrl: 'http://localhost:1002',
  };

  const createBasePolicy = (overrides: Partial<Policy> = {}): Policy =>
    ({
      id: 'p-hotfix-1',
      childId: 'child-manjari',
      familyId: 'fam-test',
      version: 1,
      isPaused: false,
      rules: [
        {
          id: 'r-1',
          childId: 'child-manjari',
          domain: 'roblox.com',
          action: 'BLOCK',
          reason: 'Games not allowed during homework',
          category: 'GAMES',
          enabled: true,
          policyVersion: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      usageBudgets: [
        {
          id: 'b-game-app',
          childId: 'child-manjari',
          targetType: 'APP',
          target: 'RobloxPlayerBeta.exe',
          dailyLimitSeconds: 1800, // 30 minutes
          bonusSeconds: 0,
          unlimitedToday: false,
          timezone: 'UTC',
          resetTime: '00:00',
          enabled: true,
          policyVersion: 1,
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'b-web-quota',
          childId: 'child-manjari',
          targetType: 'DOMAIN',
          target: 'youtube.com',
          dailyLimitSeconds: 3600,
          bonusSeconds: 0,
          unlimitedToday: false,
          timezone: 'UTC',
          resetTime: '00:00',
          enabled: true,
          policyVersion: 1,
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'b-category-quota',
          childId: 'child-manjari',
          targetType: 'CATEGORY',
          target: 'GAMES',
          dailyLimitSeconds: 1200,
          bonusSeconds: 0,
          unlimitedToday: false,
          timezone: 'UTC',
          resetTime: '00:00',
          enabled: true,
          policyVersion: 1,
          updatedAt: new Date().toISOString(),
        },
      ] as any,
      bedtime: {
        enabled: true,
        startHour: 21,
        startMinute: 0,
        endHour: 7,
        endMinute: 0,
        allowEducationalOnly: true,
      },
      updatedAt: new Date().toISOString(),
      ...overrides,
    } as Policy);

  // Test A: Dinner Time isPaused=true -> 0 process terminations, DNS blocks as PAUSED_INTERNET
  it('Test A: Dinner Time (isPaused=true) causes ZERO process terminations while DNS blocks with PAUSED_INTERNET', async () => {
    const policy = createBasePolicy({ isPaused: true });
    let terminationCount = 0;

    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => false,
    });

    const mockProcs: ProcessInfo[] = [
      { pid: 101, imageName: 'chrome.exe', userName: 'Manjari', sessionId: 1 },
      { pid: 102, imageName: 'msedge.exe', userName: 'Manjari', sessionId: 1 },
      { pid: 103, imageName: 'winword.exe', userName: 'Manjari', sessionId: 1 },
      { pid: 104, imageName: 'RobloxPlayerBeta.exe', userName: 'Manjari', sessionId: 1 },
    ];
    limiter.setMockProcesses(mockProcs);

    // Overwrite terminateProcessByPid to record any attempted calls
    limiter.terminateProcessByPid = async () => {
      terminationCount++;
      return true;
    };

    await limiter.checkAndEnforce();

    assert.strictEqual(
      terminationCount,
      0,
      'Dinner Time must NEVER terminate any processes (strictly zero taskkill)'
    );

    // Verify DNS proxy policy evaluation returns BLOCK with PAUSED_INTERNET
    const dnsResult = evaluatePolicy(policy, 'wikipedia.org');
    assert.strictEqual(dnsResult.action, 'BLOCK');
    assert.strictEqual(dnsResult.reason, 'PAUSED_INTERNET');
  });

  // Test B: Dinner Time resume isPaused=false -> Internet allowed, 0 terminations
  it('Test B: Dinner Time resume (isPaused=false) allows internet and terminates 0 processes', async () => {
    const policy = createBasePolicy({ isPaused: false });
    let terminationCount = 0;

    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => false,
    });

    limiter.setMockProcesses([
      { pid: 201, imageName: 'chrome.exe', userName: 'Manjari', sessionId: 1 },
    ]);
    limiter.terminateProcessByPid = async () => {
      terminationCount++;
      return true;
    };

    await limiter.checkAndEnforce();
    assert.strictEqual(terminationCount, 0);

    const dnsResult = evaluatePolicy(policy, 'wikipedia.org');
    assert.strictEqual(dnsResult.action, 'ALLOW');
  });

  // Test C: Bedtime window -> 0 taskkills, DNS blocks as BEDTIME_ACTIVE
  it('Test C: Bedtime curfew causes ZERO process terminations while DNS blocks non-educational traffic', async () => {
    const policy = createBasePolicy({
      bedtime: {
        enabled: true,
        startHour: 21,
        startMinute: 0,
        endHour: 7,
        endMinute: 0,
        allowEducationalOnly: true,
      },
    });

    let terminationCount = 0;
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => false,
    });

    limiter.setMockProcesses([
      { pid: 301, imageName: 'chrome.exe', userName: 'Manjari', sessionId: 1 },
      { pid: 302, imageName: 'RobloxPlayerBeta.exe', userName: 'Manjari', sessionId: 1 },
    ]);
    limiter.terminateProcessByPid = async () => {
      terminationCount++;
      return true;
    };

    await limiter.checkAndEnforce();
    assert.strictEqual(
      terminationCount,
      0,
      'Bedtime curfew must NEVER terminate local application processes'
    );

    // Verify DNS evaluation at bedtime (e.g. 22:30 night)
    const night = new Date();
    night.setHours(22, 30, 0, 0);
    const dnsResult = evaluatePolicy(policy, 'youtube.com', night);
    assert.strictEqual(dnsResult.action, 'BLOCK');
    assert.strictEqual(dnsResult.reason, 'BEDTIME_ACTIVE');
  });

  // Test D: Protected OS processes -> direct termination rejected and logged as PROTECTED_PROCESS
  it('Test D: Protected Windows OS processes are unconditionally rejected from termination', async () => {
    const policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    const criticalOsProcesses = [
      'explorer.exe',
      'explorer',
      'svchost.exe',
      'dwm.exe',
      'lsass.exe',
      'csrss.exe',
      'services.exe',
      'winlogon.exe',
      'smss.exe',
      'RuntimeBroker.exe',
      'ApplicationFrameHost.exe',
      'ctfmon.exe',
      'taskhostw.exe',
      'SearchHost.exe',
      'System',
      'Registry',
    ];

    for (const procName of criticalOsProcesses) {
      assert.strictEqual(
        isProtectedProcess(procName),
        true,
        `${procName} must be marked as protected process`
      );

      // 1. evaluateProcess must return ALLOW with PROTECTED_PROCESS
      const evalRes = limiter.evaluateProcess(procName, policy);
      assert.strictEqual(evalRes.action, 'ALLOW');
      assert.strictEqual(evalRes.reason, 'PROTECTED_PROCESS');

      // 2. Direct termination attempt via terminateProcessByPid must fail-safe return false
      const termByPidRes = await limiter.terminateProcessByPid(999, procName, 'Manjari', 'Manjari');
      assert.strictEqual(
        termByPidRes,
        false,
        `Direct termination of protected process ${procName} must be refused`
      );

      // 3. Direct termination attempt via terminateProcess must fail-safe return false
      const termRes = await limiter.terminateProcess(procName);
      assert.strictEqual(termRes, false, `terminateProcess(${procName}) must be refused`);
    }
  });

  // Test E: SafeBrowse self-protection -> rejected
  it('Test E: SafeBrowse agent and service binaries are protected from self-termination', async () => {
    const policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    const safeBrowseBinaries = [
      'SafeBrowseChild-Pilot.exe',
      'SafeBrowseServiceHost.exe',
      'SafeBrowseChildService.exe',
      'SafeBrowseChildService',
      'node.exe',
    ];

    for (const binName of safeBrowseBinaries) {
      assert.strictEqual(
        isProtectedProcess(binName),
        true,
        `${binName} must be protected from termination`
      );
      const res = await limiter.terminateProcessByPid(555, binName, 'Manjari', 'Manjari');
      assert.strictEqual(res, false, `Termination of ${binName} must be rejected`);
    }
  });

  // Test F: Parent / Unmanaged account -> no app termination even if child policy is paused or budget exhausted
  it('Test F: Parent/Unmanaged active console session completely bypasses process termination', async () => {
    const policy = createBasePolicy({ isPaused: true });
    let terminationCount = 0;

    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: false, // Parent / Unmanaged
        accountName: 'acer',
        childId: null,
        childName: null,
        sid: 'S-1-5-21-1000',
      }),
      hasMultipleSessions: () => false,
    });

    limiter.setMockProcesses([
      { pid: 401, imageName: 'RobloxPlayerBeta.exe', userName: 'acer', sessionId: 1 },
    ]);
    // Force Roblox usage to exhausted
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 99999,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: true,
    });

    limiter.terminateProcessByPid = async () => {
      terminationCount++;
      return true;
    };

    await limiter.checkAndEnforce();
    assert.strictEqual(
      terminationCount,
      0,
      'Parent/Unmanaged user sessions must NEVER have processes terminated'
    );
  });

  // Test G, H, I: Quota isolation: only targetType=APP reaches limiter; DOMAIN and CATEGORY never reach limiter
  it('Test G, H, I: Quota isolation ensures DOMAIN and CATEGORY budgets never terminate processes', () => {
    const policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    // Test G: targetType === 'APP' matches and evaluates limits
    const appRes = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(appRes.limitSeconds, 1800);

    // Test H: targetType === 'DOMAIN' (youtube.com) does NOT match chrome.exe or youtube.com as an executable
    const domainProcRes = limiter.evaluateProcess('youtube.com', policy);
    assert.strictEqual(domainProcRes.action, 'ALLOW');
    assert.strictEqual(domainProcRes.reason, 'NO_LIMIT_SET');

    // Test I: targetType === 'CATEGORY' (GAMES) does NOT match any process
    const catProcRes = limiter.evaluateProcess('GAMES', policy);
    assert.strictEqual(catProcRes.action, 'ALLOW');
    assert.strictEqual(catProcRes.reason, 'NO_LIMIT_SET');
  });

  // Test J: PID ownership verification: unknown/parent PID spared, only child's explicit app PID considered
  it('Test J: PID ownership verification ensures mismatched process owner is NOT terminated', async () => {
    const policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => false,
    });

    // Exhaust roblox budget
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 1800,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: true,
    });

    const terminatedPids: number[] = [];
    limiter.terminateProcessByPid = async (pid, img, procUser, expectedUser) => {
      if (procUser !== expectedUser) {
        return false;
      }
      terminatedPids.push(pid);
      return true;
    };

    limiter.setMockProcesses([
      // PID 501 belongs to Parent (acer)
      { pid: 501, imageName: 'RobloxPlayerBeta.exe', userName: 'acer', sessionId: 1 },
      // PID 502 belongs to Child (Manjari)
      { pid: 502, imageName: 'RobloxPlayerBeta.exe', userName: 'Manjari', sessionId: 1 },
    ]);

    await limiter.checkAndEnforce();

    assert.deepStrictEqual(
      terminatedPids,
      [502],
      'Only child PID 502 should be terminated; parent PID 501 must be spared'
    );
  });

  // Test K: Parent PID running same image name as child app -> Parent PID is NOT terminated
  it('Test K: Domain-qualified usernames (LAPTOP\\acer vs LAPTOP\\Manjari) correctly protect parent processes', async () => {
    const policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => false,
    });

    // Direct attempt to terminate parent process with domain prefix
    const parentKilled = await limiter.terminateProcessByPid(
      601,
      'RobloxPlayerBeta.exe',
      'DESKTOP-ABC\\acer',
      'DESKTOP-ABC\\Manjari'
    );
    assert.strictEqual(parentKilled, false, 'Parent process with domain prefix must NOT be terminated');

    // Attempt with matching child
    const childKilled = await limiter.terminateProcessByPid(
      602,
      'RobloxPlayerBeta.exe',
      'DESKTOP-ABC\\Manjari',
      'DESKTOP-ABC\\Manjari'
    );
    assert.strictEqual(childKilled, true, 'Child process must be permitted for termination');
  });

  // Test L: PID <= 4 rejected
  it('Test L: PID <= 4 (e.g. System PID 4 or Idle PID 0) is strictly refused', async () => {
    const policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    assert.strictEqual(await limiter.terminateProcessByPid(0, 'System Idle Process'), false);
    assert.strictEqual(await limiter.terminateProcessByPid(4, 'System'), false);
  });

  // Test M: Multiple sessions (Fast User Switching) -> fail-safe, no termination
  it('Test M: Concurrent interactive sessions (Fast User Switching) suspend all process termination', async () => {
    const policy = createBasePolicy();
    let terminationCount = 0;

    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => true, // MULTI-SESSION ACTIVE
    });

    limiter.setMockProcesses([
      { pid: 701, imageName: 'RobloxPlayerBeta.exe', userName: 'Manjari', sessionId: 1 },
    ]);
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 99999,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: true,
    });

    limiter.terminateProcessByPid = async () => {
      terminationCount++;
      return true;
    };

    await limiter.checkAndEnforce();

    assert.strictEqual(
      terminationCount,
      0,
      'Multi-session state must completely suspend process termination for safety'
    );
  });

  // Test N: Rapid Dinner Time toggle (25 cycles ON/OFF) -> stability, 0 taskkills, DNS toggles correctly
  it('Test N: Rapid Dinner Time toggle (25 cycles ON/OFF) maintains 100% stability and zero process kills', async () => {
    let isPausedState = false;
    let terminationAttempts = 0;

    const limiter = new WindowsProcessLimiter(mockConfig, () => createBasePolicy({ isPaused: isPausedState }), {
      simulate: true,
      getActiveUserPolicy: () => ({
        isManaged: true,
        accountName: 'Manjari',
        childId: 'child-manjari',
        childName: 'Manjari',
        sid: 'S-1-5-21-1001',
      }),
      hasMultipleSessions: () => false,
    });

    limiter.setMockProcesses([
      { pid: 801, imageName: 'chrome.exe', userName: 'Manjari', sessionId: 1 },
      { pid: 802, imageName: 'explorer.exe', userName: 'Manjari', sessionId: 1 },
      { pid: 803, imageName: 'RobloxPlayerBeta.exe', userName: 'Manjari', sessionId: 1 },
    ]);

    limiter.terminateProcessByPid = async () => {
      terminationAttempts++;
      return true;
    };

    for (let cycle = 0; cycle < 25; cycle++) {
      // Toggle ON (Dinner Time active)
      isPausedState = true;
      const policyOn = createBasePolicy({ isPaused: true });
      await limiter.checkAndEnforce();
      const dnsOn = evaluatePolicy(policyOn, 'wikipedia.org');
      assert.strictEqual(dnsOn.action, 'BLOCK');
      assert.strictEqual(dnsOn.reason, 'PAUSED_INTERNET');

      // Toggle OFF (Dinner Time resumed)
      isPausedState = false;
      const policyOff = createBasePolicy({ isPaused: false });
      await limiter.checkAndEnforce();
      const dnsOff = evaluatePolicy(policyOff, 'wikipedia.org');
      assert.strictEqual(dnsOff.action, 'ALLOW');
    }

    assert.strictEqual(
      terminationAttempts,
      0,
      '25 rapid toggle cycles must result in exactly 0 process termination attempts'
    );
  });

  // Test O: Static/Architectural guard ensuring isPaused and bedtime cannot return TERMINATE
  it('Test O: Architectural invariant: isPaused and bedtime in evaluateProcess NEVER return TERMINATE', () => {
    const limiter = new WindowsProcessLimiter(mockConfig, () => createBasePolicy(), { simulate: true });

    // 1. Policy with isPaused=true
    const pausedPolicy = createBasePolicy({ isPaused: true });
    const resPaused = limiter.evaluateProcess('RobloxPlayerBeta.exe', pausedPolicy);
    assert.notStrictEqual(resPaused.action, 'TERMINATE', 'isPaused must not produce TERMINATE action');

    // 2. Policy with Bedtime enabled at night
    const bedtimePolicy = createBasePolicy({
      bedtime: {
        enabled: true,
        startHour: 20,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        allowEducationalOnly: false,
      },
    });
    const midnight = new Date('2026-10-01T23:59:00');
    const resBedtime = limiter.evaluateProcess('RobloxPlayerBeta.exe', bedtimePolicy, midnight);
    assert.notStrictEqual(resBedtime.action, 'TERMINATE', 'bedtime must not produce TERMINATE action');

    // 3. Both isPaused=true and bedtime enabled
    const combinedPolicy = createBasePolicy({
      isPaused: true,
      bedtime: {
        enabled: true,
        startHour: 20,
        startMinute: 0,
        endHour: 8,
        endMinute: 0,
        allowEducationalOnly: false,
      },
    });
    const resCombined = limiter.evaluateProcess('RobloxPlayerBeta.exe', combinedPolicy, midnight);
    assert.notStrictEqual(resCombined.action, 'TERMINATE', 'combined pause+bedtime must not produce TERMINATE action');
  });

  // Test P: Block page user-friendly messages for Dinner Time and Bedtime without browser disruption
  it('Test P: Block page user-friendly message formatting for Dinner Time and Bedtime', () => {
    assert.strictEqual(
      formatFriendlyReason('PAUSED_INTERNET'),
      'Internet is paused for family time.'
    );
    assert.strictEqual(
      formatFriendlyReason('DINNER_TIME'),
      'Internet is paused for family time.'
    );
    assert.strictEqual(
      formatFriendlyReason('GLOBAL_INTERNET_PAUSED'),
      'Internet is paused for family time.'
    );
    assert.strictEqual(
      formatFriendlyReason('BEDTIME_ACTIVE'),
      'Bedtime restrictions are active.'
    );
    assert.strictEqual(
      formatFriendlyReason('BEDTIME_RESTRICTION'),
      'Bedtime rule active. Internet access is paused until morning.'
    );
    assert.strictEqual(
      formatFriendlyReason('BEDTIME_CURFEW'),
      'Bedtime restrictions are active.'
    );
  });
});
