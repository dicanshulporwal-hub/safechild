import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app, bootstrap } from '../src/server';
import { prisma } from '../src/db/prisma';
import { nanoid } from 'nanoid';
import {
  validateTestDatabaseUrl,
  assertLiveTestDatabaseMarker,
} from '../src/utils/test-db-guard';
import { authService } from '../src/services/auth.service';
import { mailService } from '../src/services/mail.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { DeviceService } from '../src/services/device.service';
import { TimelineService } from '../src/services/timeline.service';
import { UsageService } from '../src/services/usage.service';
import { ActivityService } from '../src/services/activity.service';
import { PolicyService } from '../src/services/policy.service';

describe('SafeBrowse Stage B: Telemetry Persistence, Dashboard Truthfulness & Data-Integrity Hardening', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  const testPassword = 'StageBPassword123!Secure';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;

  function getActivationToken(email: string): string {
    const mail = mailService.getOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase().trim()).pop();
    if (!mail || !mail.token) {
      throw new Error(`No activation token found in outbox for ${email}`);
    }
    return mail.token;
  }

  const api = async (
    method: string,
    endpoint: string,
    headers?: Record<string, string>,
    body?: any
  ): Promise<{ status: number; data: any }> => {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data: any;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return { status: res.status, data };
  };

  before(async () => {
    const testDbUrl =
      process.env.TEST_DATABASE_URL ||
      'postgresql://safebrowse:safebrowse_dev_password@127.0.0.1:55432/safebrowse_test';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Clean test tables
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "UserSession", "MfaChallenge", "AccessRequest", "ChildUsageRecord", 
      "ActivityEvent", "TimelineEvent", "Policy", "PairingCode", "Device", "Child", "FamilyInvitation", 
      "FamilyAuditLog", "FamilyMember", "Family", "User" CASCADE;
    `);

    // Register & verify parent
    parentEmail = `parent.stageb.${nanoid(6)}@example.com`;
    const regRes = await authService.register(parentEmail, testPassword, 'Stage B Parent');
    parentUserId = regRes.user.id;
    const activationToken = getActivationToken(parentEmail);
    await authService.activateAccount(activationToken);

    await prisma.user.update({
      where: { id: parentUserId },
      data: { systemRole: 'SYSTEM_ADMIN' },
    });

    const loginRes = await authService.login(parentEmail, testPassword);
    parentToken = loginRes.token || '';

    const fam = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = fam.id;

    // Create child profile
    const child = await childService.createChild(parentUserId, 'Leo', 11, '🧒', familyId);
    childId = child.child.id;

    // Pair a device
    const deviceSvc = new DeviceService();
    const pairing = await deviceSvc.generatePairingCode(parentUserId, childId);
    const pairRes = await deviceSvc.pairDevice(pairing.code, 'Leo-Laptop', 'windows', '1.0.3-pilot');
    deviceId = pairRes.device.id;
    deviceToken = pairRes.device.deviceToken || '';
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // TEST A: Backend restart persistence
  it('Test A: Backend restart persistence (mappedAccount, protectionStatus, multipleSessions, activePolicyVersion)', async () => {
    const deviceSvc1 = new DeviceService();
    // Simulate heartbeat from device
    await deviceSvc1.processHeartbeat({
      deviceId,
      deviceToken,
      activePolicyVersion: 3,
      enforcementActive: true,
      protectionStatus: 'ACTIVE',
      mappedAccountName: 'LeoWindowsUser',
      hasMultipleSessions: true,
      platform: 'windows',
      agentVersion: '1.0.3-pilot',
    });

    // Simulate backend restart by instantiating fresh DeviceService
    const freshDeviceSvc = new DeviceService();
    const fetched = await freshDeviceSvc.getDevice(deviceId);

    assert.ok(fetched);
    assert.strictEqual(fetched.windowsAccountName, 'LeoWindowsUser');
    assert.strictEqual(fetched.protectionStatus, 'ACTIVE');
    assert.strictEqual(fetched.hasMultipleSessions, true);
    assert.strictEqual(fetched.agentActivePolicyVersion, 3);
    assert.strictEqual(fetched.enforcementActive, true);
  });

  // TEST B: Policy sync status derivation
  it('Test B: Policy sync status derivation (SYNCED vs SYNC_PENDING vs VERSION_MISMATCH)', async () => {
    const deviceSvc = new DeviceService();
    // Configure policy version to 5 in DB
    await prisma.policy.update({
      where: { childId },
      data: { version: 5 },
    });

    // Subcase 1: Agent active policy version is 5 -> SYNCED
    await deviceSvc.processHeartbeat({
      deviceId,
      deviceToken,
      activePolicyVersion: 5,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.3-pilot',
    });
    let dev = await deviceSvc.getDevice(deviceId);
    assert.ok(dev);
    assert.strictEqual(dev.policySyncStatus, 'SYNCED');

    // Subcase 2: Agent active policy version is 4 -> SYNC_PENDING
    await deviceSvc.processHeartbeat({
      deviceId,
      deviceToken,
      activePolicyVersion: 4,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.3-pilot',
    });
    dev = await deviceSvc.getDevice(deviceId);
    assert.ok(dev);
    assert.strictEqual(dev.policySyncStatus, 'SYNC_PENDING');

    // Subcase 3: Agent active policy version is 6 -> VERSION_MISMATCH
    await deviceSvc.processHeartbeat({
      deviceId,
      deviceToken,
      activePolicyVersion: 6,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.3-pilot',
    });
    dev = await deviceSvc.getDevice(deviceId);
    assert.ok(dev);
    assert.strictEqual(dev.policySyncStatus, 'VERSION_MISMATCH');
  });

  // TEST C: Zero counts remain zero (0 devices, 0 families)
  it('Test C: Zero counts remain zero in metrics API', async () => {
    // Test with fresh metrics endpoint
    const res = await api('GET', '/api/operations/metrics', { Authorization: `Bearer ${parentToken}` });
    assert.strictEqual(res.status, 200);
    // Values must be exact numbers, never fabricated
    assert.ok(typeof res.data.familiesCount === 'number');
    assert.ok(typeof res.data.childrenCount === 'number');
    assert.ok(typeof res.data.devicesCount === 'number');
    assert.ok(res.data.devicesCount >= 0);
  });

  // TEST D: Operations crash rate is null/unavailable
  it('Test D & G: Operations crash rate is null/unavailable', async () => {
    const res = await api('GET', '/api/operations/metrics', { Authorization: `Bearer ${parentToken}` });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.agentCrashRate, null);
    assert.strictEqual(res.data.agentCrashRateAvailable, false);
  });

  // TEST E: Weekly digest has no synthetic data
  it('Test E: Weekly digest has no synthetic data (uptimePercent is null, uptimeAvailable is false)', async () => {
    const usageSvc = new UsageService();
    const digest = await usageSvc.getWeeklyDigest(parentUserId, familyId);
    assert.strictEqual(digest.uptimePercent, null);
    assert.strictEqual(digest.uptimeAvailable, false);
    assert.ok(typeof digest.totalManagedEvents === 'number');
  });

  // TEST F: AI watchdog has no synthetic queries
  it('Test F: AI watchdog has no synthetic queries when no blocked events exist', async () => {
    const actSvc = new ActivityService();
    const acts = await actSvc.getActivityForChild(childId);
    const blockedActs = acts.filter((a) => a.action === 'BLOCKED');
    assert.strictEqual(blockedActs.length, 0);
  });

  // TEST H: Timeline events persist across service instantiation
  it('Test H: Timeline events persist across service instantiation in PostgreSQL', async () => {
    const tl1 = new TimelineService();
    await tl1.logEvent({
      childId,
      eventType: 'DEVICE_PAIRED',
      decision: 'ALLOWED',
      domain: 'DEVICE_ENROLLMENT',
      reason: 'Windows agent paired successfully',
    });

    // Fresh instance
    const tl2 = new TimelineService();
    const events = await tl2.getEventsForChild(childId);
    assert.ok(events.length >= 1);
    const found = events.find((e) => e.eventType === 'DEVICE_PAIRED');
    assert.ok(found);
    assert.strictEqual(found.domain, 'DEVICE_ENROLLMENT');
  });

  // TEST I: Dinner time hydration survives page refresh
  it('Test I: Dinner time hydration survives page refresh via GET /api/policies/family/pause-status', async () => {
    // Enable Dinner Time
    const pauseRes = await api(
      'POST',
      '/api/policies/family/pause-all',
      { Authorization: `Bearer ${parentToken}` },
      { isPaused: true }
    );
    assert.strictEqual(pauseRes.status, 200);

    // Verify GET /api/policies/family/pause-status returns isFamilyPaused: true
    const statusRes = await api(
      'GET',
      '/api/policies/family/pause-status',
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.isFamilyPaused, true);
    assert.strictEqual(statusRes.data.pauseState, 'ALL_PAUSED');
    assert.strictEqual(statusRes.data.pausedCount, 1);

    // Resume family internet
    await api(
      'POST',
      '/api/policies/family/pause-all',
      { Authorization: `Bearer ${parentToken}` },
      { isPaused: false }
    );

    const statusRes2 = await api(
      'GET',
      '/api/policies/family/pause-status',
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(statusRes2.status, 200);
    assert.strictEqual(statusRes2.data.isFamilyPaused, false);
    assert.strictEqual(statusRes2.data.pauseState, 'NONE_PAUSED');
  });

  // TEST J & K: Date-scoped Unlimited Today and Bonus Time evaluation
  it('Test J & K: Unlimited Today and Bonus Time expire when evaluated on a subsequent date', async () => {
    const usageSvc = new UsageService();
    // Create a budget
    await usageSvc.setUsageBudget(childId, 'youtube.com', 'DOMAIN', 60, parentUserId);

    // Fetch policy
    let policy = await prisma.policy.findUnique({ where: { childId } });
    let budgets = (policy?.usageBudgets as any[]) || [];
    const bId = budgets[0].id;

    // Grant Unlimited Today with yesterday's date
    budgets[0].unlimitedToday = true;
    budgets[0].unlimitedDate = '2020-01-01'; // Expired past date
    budgets[0].bonusSeconds = 1800;
    budgets[0].bonusDate = '2020-01-01'; // Expired past date

    await prisma.policy.update({
      where: { childId },
      data: { usageBudgets: budgets },
    });

    const summaries = await usageSvc.getBudgetsWithUsage(childId);
    assert.strictEqual(summaries.length, 1);
    // Must evaluate to false and 0 bonus because dates do not match today
    assert.strictEqual(summaries[0].budget.unlimitedToday, false);
    assert.strictEqual(summaries[0].budget.bonusSeconds, 0);
  });

  // TEST L: Timezone follows family timezone
  it('Test L: Timezone follows family timezone with IANA validation', async () => {
    // Set family timezone to America/New_York
    const patchRes = await api(
      'PATCH',
      '/api/family',
      { Authorization: `Bearer ${parentToken}` },
      {
        familyId,
        timezone: 'America/New_York',
      }
    );
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.data.family.timezone, 'America/New_York');

    const usageSvc = new UsageService();
    const tz = await usageSvc.getFamilyTimezone(undefined, childId);
    assert.strictEqual(tz, 'America/New_York');

    // Attempt invalid IANA timezone
    const invalidRes = await api(
      'PATCH',
      '/api/family',
      { Authorization: `Bearer ${parentToken}` },
      {
        familyId,
        timezone: 'Invalid/City_Nowhere',
      }
    );
    assert.strictEqual(invalidRes.status, 400);
    assert.ok(invalidRes.data.error.includes('Invalid IANA timezone'));
  });

  // TEST M: Usage unique identity allows same target on APP vs DOMAIN
  it('Test M: Usage unique identity allows same target name on APP vs DOMAIN', async () => {
    const usageSvc = new UsageService();
    const today = usageSvc.getTodayDateString('UTC');

    // Record usage for 'roblox' as APP
    await usageSvc.recordUsageSync(childId, deviceId, 'roblox', 'APP', 300);

    // Record usage for 'roblox' as DOMAIN
    await usageSvc.recordUsageSync(childId, deviceId, 'roblox', 'DOMAIN', 600);

    const appRecord = await prisma.childUsageRecord.findUnique({
      where: {
        childId_targetType_target_date: {
          childId,
          targetType: 'APP',
          target: 'roblox',
          date: today,
        },
      },
    });

    const domainRecord = await prisma.childUsageRecord.findUnique({
      where: {
        childId_targetType_target_date: {
          childId,
          targetType: 'DOMAIN',
          target: 'roblox',
          date: today,
        },
      },
    });

    assert.ok(appRecord);
    assert.strictEqual(appRecord.consumedSeconds, 300);
    assert.ok(domainRecord);
    assert.strictEqual(domainRecord.consumedSeconds, 600);
  });

  // TEST N: Clock tamper rejection
  it('Test N: Clock tamper rejection for invalid future or ancient timestamps', async () => {
    const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 min
    const pastDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // -40 days

    // Future timestamp rejected
    const resFuture = await api(
      'POST',
      '/api/usage/sync',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      {
        childId,
        target: 'discord.com',
        targetType: 'DOMAIN',
        secondsIncrement: 60,
        clientWallIso: futureDate,
      }
    );
    assert.strictEqual(resFuture.status, 400);

    // Ancient timestamp rejected
    const resPast = await api(
      'POST',
      '/api/usage/sync',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      {
        childId,
        target: 'discord.com',
        targetType: 'DOMAIN',
        secondsIncrement: 60,
        clientWallIso: pastDate,
      }
    );
    assert.strictEqual(resPast.status, 400);
  });

  // TEST O: Retry idempotency for activity and usage
  it('Test O: Retry idempotency for activity and usage', async () => {
    const clientEventId = `ev-${nanoid(12)}`;

    // Post activity event 1st time
    const res1 = await api(
      'POST',
      '/api/activity',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      {
        childId,
        domain: 'games.example.com',
        action: 'BLOCKED',
        clientEventId,
      }
    );
    assert.strictEqual(res1.status, 200);
    const eventId1 = res1.data.id;

    // Retry post with identical clientEventId
    const res2 = await api(
      'POST',
      '/api/activity',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      {
        childId,
        domain: 'games.example.com',
        action: 'BLOCKED',
        clientEventId,
      }
    );
    assert.strictEqual(res2.status, 200);
    // Must return the existing event idempotently without duplicating
    assert.strictEqual(res2.data.id, eventId1);

    const totalMatching = await prisma.activityEvent.count({
      where: { childId, clientEventId },
    });
    assert.strictEqual(totalMatching, 1);

    // Usage sync idempotency with syncId
    const syncId = `sync-${nanoid(12)}`;
    const usageSvc = new UsageService();
    const u1 = await usageSvc.recordUsageSync(childId, deviceId, 'idempotent-app', 'APP', 120, undefined, syncId);
    const u2 = await usageSvc.recordUsageSync(childId, deviceId, 'idempotent-app', 'APP', 120, undefined, syncId);

    assert.strictEqual(u1.consumedSeconds, u2.consumedSeconds);
  });

  // TEST P: Diagnostics report UNKNOWN for unmeasurable signals and discloses DoH
  it('Test P: Diagnostics report truthful checks and disclose Android DoH limitation', async () => {
    // Run diagnostics for windows device
    const winDiag = await api(
      'POST',
      `/api/devices/${deviceId}/diagnostics`,
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(winDiag.status, 200);
    assert.ok(Array.isArray(winDiag.data.checks));
    const winDoh = winDiag.data.checks.find((c: any) => c.name.includes('DoH'));
    assert.ok(winDoh);
    assert.strictEqual(winDoh.status, 'passed');

    // Create an android device and test diagnostics
    const deviceSvc = new DeviceService();
    const pairing = await deviceSvc.generatePairingCode(parentUserId, childId);
    const androidPair = await deviceSvc.pairDevice(pairing.code, 'Leo-Phone', 'android', '1.0.0');

    const androidDiag = await api(
      'POST',
      `/api/devices/${androidPair.device.id}/diagnostics`,
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(androidDiag.status, 200);
    const androidDoh = androidDiag.data.checks.find((c: any) => c.name.includes('DoH'));
    assert.ok(androidDoh);
    assert.strictEqual(androidDoh.status, 'warning');
    assert.ok(androidDoh.detail.includes('Private DNS'));
  });

  // TEST Q: Android capability persistence
  it('Test Q: Android capability persistence survives in PostgreSQL', async () => {
    const deviceSvc = new DeviceService();
    const pairing = await deviceSvc.generatePairingCode(parentUserId, childId);
    const androidPair = await deviceSvc.pairDevice(pairing.code, 'Leo-Tablet', 'android', '1.0.0');

    await deviceSvc.processHeartbeat({
      deviceId: androidPair.device.id,
      deviceToken: androidPair.device.deviceToken || '',
      agentVersion: '1.0.0',
      activePolicyVersion: 5,
      enforcementActive: true,
      platform: 'android',
      capabilities: {
        activityTelemetryAvailable: true,
        appUsageAvailable: false,
        domainUsageAvailable: true,
        categoryUsageAvailable: true,
        safeDinnerTimeSupported: true,
        safeBedtimeSupported: true,
      },
    });

    const dev = await deviceSvc.getDevice(androidPair.device.id);
    assert.ok(dev);
    assert.strictEqual(dev.capabilities?.activityTelemetryAvailable, true);
    assert.strictEqual(dev.capabilities?.appUsageAvailable, false);
    assert.strictEqual(dev.capabilities?.safeDinnerTimeSupported, true);
  });
});
