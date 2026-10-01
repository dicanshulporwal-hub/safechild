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

describe('SafeBrowse Stage B.1: Final Data-Integrity & Telemetry Truthfulness Cleanup', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  const testPassword = 'StageB1Password123!Secure';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;

  function getActivationToken(email: string): string {
    const mail = mailService
      .getOutbox()
      .filter((m) => m.to.toLowerCase() === email.toLowerCase().trim())
      .pop();
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
      TRUNCATE TABLE "UsageSyncReceipt", "UserSession", "MfaChallenge", "AccessRequest", "ChildUsageRecord", 
      "ActivityEvent", "TimelineEvent", "Policy", "PairingCode", "Device", "Child", "FamilyInvitation", 
      "FamilyAuditLog", "FamilyMember", "Family", "User" CASCADE;
    `);

    // Register & verify parent
    parentEmail = `parent.b1.${nanoid(6)}@example.com`;
    const regRes = await authService.register(parentEmail, testPassword, 'Stage B.1 Parent');
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
    const child = await childService.createChild(parentUserId, 'Aarav', 12, '🧒', familyId);
    childId = child.child.id;

    // Pair a device
    const deviceSvc = new DeviceService();
    const pairing = await deviceSvc.generatePairingCode(parentUserId, childId);
    const pairRes = await deviceSvc.pairDevice(pairing.code, 'Aarav-Laptop', 'windows', '1.0.3-pilot');
    deviceId = pairRes.device.id;
    deviceToken = pairRes.device.deviceToken || '';
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // TEST A: Family timezone controls new budget reset (Asia/Kolkata and America/New_York)
  it('Test A: Family timezone controls new budget reset', async () => {
    const usageSvc = new UsageService();

    // 1. Set family timezone to Asia/Kolkata
    await prisma.family.update({
      where: { id: familyId },
      data: { timezone: 'Asia/Kolkata' },
    });

    // Create budget
    const budgetKol = await usageSvc.setUsageBudget(childId, 'youtube.com', 'DOMAIN', 60, parentUserId);
    assert.strictEqual(budgetKol.timezone, 'Asia/Kolkata');

    const kolDate = usageSvc.getTodayDateString('Asia/Kolkata');
    const effectiveKolTz = usageSvc.resolveEffectiveTimezone(budgetKol, 'Asia/Kolkata');
    assert.strictEqual(effectiveKolTz, 'Asia/Kolkata');
    assert.strictEqual(usageSvc.getTodayDateString(effectiveKolTz), kolDate);

    // 2. Set family timezone to America/New_York
    await prisma.family.update({
      where: { id: familyId },
      data: { timezone: 'America/New_York' },
    });

    // Create another budget
    const budgetNy = await usageSvc.setUsageBudget(childId, 'roblox.com', 'DOMAIN', 30, parentUserId);
    assert.strictEqual(budgetNy.timezone, 'America/New_York');

    const nyDate = usageSvc.getTodayDateString('America/New_York');
    const effectiveNyTz = usageSvc.resolveEffectiveTimezone(budgetNy, 'America/New_York');
    assert.strictEqual(effectiveNyTz, 'America/New_York');
    assert.strictEqual(usageSvc.getTodayDateString(effectiveNyTz), nyDate);
  });

  // TEST B: Usage retry out of order (sync-A -> sync-B -> retry sync-A)
  it('Test B: Usage retry out of order does not double increment', async () => {
    const usageSvc = new UsageService();
    const target = 'minecraft.net';

    // sync-A
    const resA = await usageSvc.recordUsageSync(childId, deviceId, target, 'DOMAIN', 60, undefined, 'sync-A');
    assert.strictEqual(resA.consumedSeconds, 60);

    // sync-B
    const resB = await usageSvc.recordUsageSync(childId, deviceId, target, 'DOMAIN', 45, undefined, 'sync-B');
    assert.strictEqual(resB.consumedSeconds, 105);

    // retry sync-A (out of order retry after sync-B was accepted)
    const retryA = await usageSvc.recordUsageSync(childId, deviceId, target, 'DOMAIN', 60, undefined, 'sync-A');
    // Must remain 105, NOT 165
    assert.strictEqual(retryA.consumedSeconds, 105);

    // Verify receipts in DB
    const receipts = await prisma.usageSyncReceipt.findMany({
      where: { deviceId, target: target.toLowerCase() },
    });
    assert.strictEqual(receipts.length, 2);
    const syncIds = receipts.map((r) => r.syncId).sort();
    assert.deepStrictEqual(syncIds, ['sync-A', 'sync-B']);
  });

  // TEST C: Concurrent usage duplicate
  it('Test C: Concurrent usage duplicate increments exactly once', async () => {
    const usageSvc = new UsageService();
    const target = 'khanacademy.org';
    const concurrentSyncId = `sync-concurrent-${nanoid(8)}`;

    // Send two simultaneous requests with the same syncId
    const [res1, res2] = await Promise.all([
      usageSvc.recordUsageSync(childId, deviceId, target, 'DOMAIN', 120, undefined, concurrentSyncId),
      usageSvc.recordUsageSync(childId, deviceId, target, 'DOMAIN', 120, undefined, concurrentSyncId),
    ]);

    // Both should report 120 (not 240)
    assert.strictEqual(res1.consumedSeconds, 120);
    assert.strictEqual(res2.consumedSeconds, 120);

    // Database record must have exactly 120 seconds
    const familyTz = await usageSvc.getFamilyTimezone(familyId);
    const todayDate = usageSvc.getTodayDateString(familyTz);
    const rec = await prisma.childUsageRecord.findUnique({
      where: {
        childId_targetType_target_date: {
          childId,
          targetType: 'DOMAIN',
          target: target.toLowerCase(),
          date: todayDate,
        },
      },
    });
    assert.ok(rec);
    assert.strictEqual(rec.consumedSeconds, 120);

    const receiptCount = await prisma.usageSyncReceipt.count({
      where: { deviceId, syncId: concurrentSyncId },
    });
    assert.strictEqual(receiptCount, 1);
  });

  // TEST D: Concurrent activity duplicate
  it('Test D: Concurrent activity duplicate creates exactly one DB row', async () => {
    const actSvc = new ActivityService();
    const clientEventId = `client-evt-${nanoid(8)}`;

    // Send two simultaneous logActivity calls with the same clientEventId
    const [evt1, evt2] = await Promise.all([
      actSvc.logActivity(childId, deviceId, 'discord.com', 'BLOCKED', {
        category: 'CHAT',
        reason: 'Social policy',
        clientEventId,
      }),
      actSvc.logActivity(childId, deviceId, 'discord.com', 'BLOCKED', {
        category: 'CHAT',
        reason: 'Social policy',
        clientEventId,
      }),
    ]);

    // Both return valid event with the same ID
    assert.ok(evt1.id);
    assert.ok(evt2.id);
    assert.strictEqual(evt1.id, evt2.id);

    const dbCount = await prisma.activityEvent.count({
      where: { childId, clientEventId },
    });
    assert.strictEqual(dbCount, 1);
  });

  // TEST E, F, G: Diagnostics UNKNOWN when not directly measured
  it('Test E, F, G: Diagnostics report UNKNOWN for unmeasured checks and DNS does not assume PASS from enforcementActive', async () => {
    const deviceSvc = new DeviceService();

    const currentPol = await prisma.policy.findUnique({ where: { childId } });
    await deviceSvc.processHeartbeat({
      deviceId,
      deviceToken,
      activePolicyVersion: currentPol?.version || 1,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.3-pilot',
    });

    const diag = await api('POST', `/api/devices/${deviceId}/diagnostics`, {
      Authorization: `Bearer ${parentToken}`,
    });

    assert.strictEqual(diag.status, 200);

    // E. Backend API Reachable must be UNKNOWN
    const apiCheck = diag.data.checks.find((c: any) => c.name === 'Backend API Reachable');
    assert.ok(apiCheck);
    assert.strictEqual(apiCheck.status, 'unknown');
    assert.strictEqual(apiCheck.pass, null);

    // F. WebSocket must be UNKNOWN when no authenticated socket is connected
    const wsCheck = diag.data.checks.find((c: any) => c.name === 'Real-time WebSocket Live');
    assert.ok(wsCheck);
    assert.strictEqual(wsCheck.status, 'unknown');
    assert.strictEqual(wsCheck.pass, null);

    // G. DNS Interception must NOT be PASS solely from enforcementActive
    const dnsCheck = diag.data.checks.find((c: any) => c.name === 'DNS / Network Interception Engine');
    assert.ok(dnsCheck);
    assert.strictEqual(dnsCheck.status, 'unknown');
    assert.strictEqual(dnsCheck.pass, null);

    // Overall verdict must be UNKNOWN (UNKNOWN does NOT count as PASS)
    assert.strictEqual(diag.data.verdict, 'UNKNOWN');
  });

  // TEST H & J: Public status API does not invent OPERATIONAL and Active Incidents is not shown as 0
  it('Test H & J: Public status API does not invent OPERATIONAL and activeIncidents is not 0 without datasource', async () => {
    const res = await api('GET', '/api/operations/status');
    assert.strictEqual(res.status, 200);

    // Unmonitored services must be UNKNOWN
    const dnsSvc = res.data.services.find((s: any) => s.name === 'DNS Filtering Engine');
    assert.ok(dnsSvc);
    assert.strictEqual(dnsSvc.status, 'UNKNOWN');

    const coreEngine = res.data.services.find((s: any) => s.name === 'Core Policy Evaluation Engine');
    assert.ok(coreEngine);
    assert.strictEqual(coreEngine.status, 'UNKNOWN');

    // Overall status is UNKNOWN (not fake OPERATIONAL)
    assert.strictEqual(res.data.status, 'UNKNOWN');
    assert.strictEqual(res.data.dataAvailable, false);

    // Active incidents must be null / Not Available, never fabricated 0
    assert.strictEqual(res.data.activeIncidents, null);
    assert.strictEqual(res.data.activeIncidentsAvailable, false);
  });

  // TEST I: Frontend contract verification for unavailable status
  it('Test I: Status contract exposes dataAvailable=false so frontend shows unavailable', async () => {
    const res = await api('GET', '/api/operations/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.dataAvailable, false);
    assert.strictEqual(res.data.uptime, null);
    assert.strictEqual(res.data.uptimeAvailable, false);
  });

  // TEST K: Timeline schema fidelity does not fabricate policyVersion
  it('Test K: Timeline persists category and policyVersion and does not fabricate policyVersion=1', async () => {
    const tl = new TimelineService();

    // Event 1: Without policyVersion
    const ev1 = await tl.logEvent({
      childId,
      eventType: 'PROTECTION_RESTARTED',
      decision: 'ALLOWED',
      reason: 'Agent reboot',
    });
    assert.strictEqual(ev1.policyVersion, undefined);

    // Event 2: With policyVersion and category
    const ev2 = await tl.logEvent({
      childId,
      eventType: 'BLOCKED',
      decision: 'BLOCKED',
      domain: 'gambling.com',
      category: 'GAMBLING',
      reason: 'Blocked by category rule',
      policyVersion: 5,
    });
    assert.strictEqual(ev2.policyVersion, 5);
    assert.strictEqual(ev2.category, 'GAMBLING');

    // Read from DB
    const list = await tl.getEventsForChild(childId);
    const dbEv1 = list.find((e) => e.id === ev1.id);
    const dbEv2 = list.find((e) => e.id === ev2.id);

    assert.ok(dbEv1);
    assert.strictEqual(dbEv1.policyVersion, undefined); // NOT fabricated 1

    assert.ok(dbEv2);
    assert.strictEqual(dbEv2.policyVersion, 5);
    assert.strictEqual(dbEv2.category, 'GAMBLING');
  });

  // TEST L: Timezone default and migration compatibility
  it('Test L: Timezone default is UTC and legacy UTC budgets follow family timezone', async () => {
    const usageSvc = new UsageService();

    // 1. Generic new family defaults to UTC in schema
    const newFam = await prisma.$transaction(async (tx) => {
      const fam = await tx.family.create({
        data: {
          id: `fam-test-tz-${nanoid(6)}`,
          name: 'Timezone Test Family',
          ownerUserId: parentUserId,
        },
      });
      await tx.familyMember.create({
        data: {
          id: `fm-${nanoid(6)}`,
          familyId: fam.id,
          userId: parentUserId,
          role: 'OWNER',
        },
      });
      return fam;
    });
    assert.strictEqual(newFam.timezone, 'UTC');

    // 2. Legacy budget with timezone='UTC' without isCustomTimezone follows family timezone
    const legacyBudget: any = {
      id: 'ub-legacy',
      target: 'youtube.com',
      targetType: 'DOMAIN',
      dailyLimitSeconds: 3600,
      timezone: 'UTC', // Legacy artifact
      isCustomTimezone: false,
    };
    const resolvedKol = usageSvc.resolveEffectiveTimezone(legacyBudget, 'Asia/Kolkata');
    assert.strictEqual(resolvedKol, 'Asia/Kolkata');

    const resolvedNy = usageSvc.resolveEffectiveTimezone(legacyBudget, 'America/New_York');
    assert.strictEqual(resolvedNy, 'America/New_York');

    // 3. Intentionally configured custom budget timezone is preserved
    const customBudget: any = {
      id: 'ub-custom',
      target: 'bbc.com',
      targetType: 'DOMAIN',
      dailyLimitSeconds: 1800,
      timezone: 'Europe/London',
      isCustomTimezone: true,
    };
    const resolvedCustom = usageSvc.resolveEffectiveTimezone(customBudget, 'Asia/Kolkata');
    assert.strictEqual(resolvedCustom, 'Europe/London');
  });
});
