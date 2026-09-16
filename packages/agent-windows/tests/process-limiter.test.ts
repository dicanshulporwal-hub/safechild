import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WindowsProcessLimiter } from '../src/process-limiter';
import { Policy } from '@safebrowse/shared';

describe('SafeBrowse Windows Process Limiter & Hard Enforcer Tests', () => {
  const mockConfig = {
    deviceId: 'dev-win-test',
    deviceToken: 'tok-win-test',
    childId: 'child-test',
    parentId: 'parent-test',
    deviceName: "Rahul's Laptop",
    backendUrl: 'http://localhost:1002',
  };

  const createBasePolicy = (overrides: Partial<Policy> = {}): Policy => ({
    id: 'p-1',
    childId: 'child-test',
    familyId: 'fam-test',
    version: 1,
    isPaused: false,
    rules: [],
    usageBudgets: [
      {
        id: 'b-roblox',
        childId: 'child-test',
        targetType: 'APP',
        target: 'RobloxPlayerBeta.exe',
        dailyLimitSeconds: 2700, // 45 minutes
        bonusSeconds: 0,
        unlimitedToday: false,
        timezone: 'UTC',
        resetTime: '00:00',
        enabled: true,
        policyVersion: 1,
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'b-minecraft',
        childId: 'child-test',
        targetType: 'APP',
        target: 'Minecraft.exe',
        dailyLimitSeconds: 3600, // 60 minutes
        bonusSeconds: 900, // +15 min bonus
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
      startMinute: 30,
      endHour: 7,
      endMinute: 0,
      allowEducationalOnly: true,
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Policy);

  it('1. should allow unmonitored processes with NO_LIMIT_SET', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    const result = limiter.evaluateProcess('notepad.exe', policy);
    assert.strictEqual(result.action, 'ALLOW');
    assert.strictEqual(result.reason, 'NO_LIMIT_SET');
  });

  it('2. should track initial budget for Roblox (45 mins / 2700s remaining)', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(result.action, 'ALLOW');
    assert.strictEqual(result.remainingSeconds, 2700);
    assert.strictEqual(result.limitSeconds, 2700);
  });

  it('3. should emit 5-minute warning when consumed time leaves <= 300s', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    // Simulate 41 minutes (2460s) already consumed
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 2460,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: false,
      warned1Min: false,
    });

    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(result.action, 'WARN_5MIN');
    assert.strictEqual(result.reason, '5_MINUTES_REMAINING');
    assert.strictEqual(result.remainingSeconds, 240); // 4 minutes remaining
  });

  it('4. should emit 1-minute warning when consumed time leaves <= 60s', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    // Simulate 44.5 minutes (2670s) consumed
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 2670,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: false,
    });

    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(result.action, 'WARN_1MIN');
    assert.strictEqual(result.reason, '1_MINUTE_REMAINING');
    assert.strictEqual(result.remainingSeconds, 30);
  });

  it('5. should trigger TERMINATE when daily budget is exhausted', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    // Simulate 45 minutes (2700s) consumed
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 2700,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: true,
    });

    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(result.action, 'TERMINATE');
    assert.strictEqual(result.reason, 'DAILY_APP_TIME_EXHAUSTED');
    assert.strictEqual(result.remainingSeconds, 0);
  });

  it('6. should account for bonus time granted by parent (Minecraft 3600s + 900s = 4500s)', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    // Simulate 3600s consumed (normally exhausted, but bonus gives +900s)
    limiter.setUsageState('minecraft.exe', {
      processName: 'minecraft.exe',
      consumedSeconds: 3600,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: false,
      warned1Min: false,
    });

    const result = limiter.evaluateProcess('Minecraft.exe', policy);
    assert.strictEqual(result.action, 'ALLOW');
    assert.strictEqual(result.limitSeconds, 4500);
    assert.strictEqual(result.remainingSeconds, 900); // 15 mins remaining
  });

  it('7. should allow process unconditionally when unlimitedToday is granted', () => {
    let policy = createBasePolicy({
      usageBudgets: [
        {
          id: 'b-roblox-unlimited',
          childId: 'child-test',
          targetType: 'APP',
          target: 'RobloxPlayerBeta.exe',
          dailyLimitSeconds: 2700,
          bonusSeconds: 0,
          unlimitedToday: true,
          timezone: 'UTC',
          resetTime: '00:00',
          enabled: true,
          policyVersion: 1,
          updatedAt: new Date().toISOString(),
        } as any,
      ],
    });
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 99999,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: true,
    });

    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(result.action, 'ALLOW');
    assert.strictEqual(result.reason, 'UNLIMITED_TODAY_GRANTED');
  });

  it('8. should terminate game process immediately during Bedtime curfew (22:00)', () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    const nightTime = new Date('2026-09-15T22:00:00');
    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy, nightTime);
    assert.strictEqual(result.action, 'TERMINATE');
    assert.strictEqual(result.reason, 'BEDTIME_CURFEW_ACTIVE');
  });

  it('9. should terminate all monitored processes when global isPaused is true', () => {
    let policy = createBasePolicy({ isPaused: true });
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, { simulate: true });

    const result = limiter.evaluateProcess('RobloxPlayerBeta.exe', policy);
    assert.strictEqual(result.action, 'TERMINATE');
    assert.strictEqual(result.reason, 'GLOBAL_INTERNET_PAUSED');
  });

  it('10. should execute checkAndEnforce loop and remove exhausted process from mock list', async () => {
    let policy = createBasePolicy();
    const limiter = new WindowsProcessLimiter(mockConfig, () => policy, {
      simulate: true,
      checkIntervalMs: 100,
    });

    limiter.setMockProcesses(['chrome.exe', 'robloxplayerbeta.exe', 'spotify.exe']);

    // Set roblox as already exhausted
    limiter.setUsageState('robloxplayerbeta.exe', {
      processName: 'robloxplayerbeta.exe',
      consumedSeconds: 2700,
      lastDate: new Date().toISOString().slice(0, 10),
      warned5Min: true,
      warned1Min: true,
    });

    await limiter.checkAndEnforce();

    const remainingRunning = await limiter.getRunningProcessNames();
    assert.deepStrictEqual(remainingRunning, ['chrome.exe', 'spotify.exe']);
  });
});
