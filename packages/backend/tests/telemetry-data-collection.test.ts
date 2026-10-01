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
import { deviceService } from '../src/services/device.service';
import { policyService } from '../src/services/policy.service';

describe('SafeBrowse Stage A: Telemetry, Activity & Usage Data Collection Verification Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  const testPassword = 'StrongPassword123!Telemetry';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;

  // Family A Children
  let childAId: string;
  let childBId: string;

  // Family A Devices
  let androidDeviceId: string;
  let androidDeviceToken: string;
  let windowsDeviceId: string;
  let windowsDeviceToken: string;

  // Family B (Cross-family negative tenancy tests)
  let familyBId: string;
  let childBFamilyBId: string;
  let deviceFamilyBId: string;
  let deviceTokenFamilyB: string;

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
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://safebrowse:safebrowse_dev_password@127.0.0.1:55432/safebrowse_test';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    // Bootstrap Express server
    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Clean test tables
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "UserSession", "MfaChallenge", "AccessRequest", "ChildUsageRecord", 
      "ActivityEvent", "Policy", "PairingCode", "Device", "Child", "FamilyInvitation", 
      "FamilyAuditLog", "FamilyMember", "Family", "User" CASCADE;
    `);

    // 1. Create and verify Parent A
    parentEmail = `parent.telemetry.${nanoid(6)}@example.com`;
    const regRes = await authService.register(parentEmail, testPassword, 'Parent Telemetry');
    parentUserId = regRes.user.id;
    const tokenA = getActivationToken(parentEmail);
    await authService.activateAccount(tokenA);
    const loginA = await authService.login(parentEmail, testPassword);
    parentToken = loginA.token!;

    // Get family A
    const fam = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = fam.id;

    // 2. Create Child A (Manjari) and Child B (Rahul) in Family A
    const cARes = await childService.createChild(parentUserId, 'Manjari', 12, undefined, familyId);
    childAId = cARes.child.id;
    const cBRes = await childService.createChild(parentUserId, 'Rahul', 9, undefined, familyId);
    childBId = cBRes.child.id;

    // 3. Pair Android Phone to Child A
    const codeAndroid = await deviceService.generatePairingCode(parentUserId, childAId);
    const pairAndroid = await deviceService.pairDevice(codeAndroid.code, "Rahul's Android Phone", 'android', '1.0.3-pilot');
    androidDeviceId = pairAndroid.device.id;
    androidDeviceToken = pairAndroid.device.deviceToken;

    // 4. Pair Windows Laptop to Child A initially (shared laptop)
    const codeWin = await deviceService.generatePairingCode(parentUserId, childAId);
    const pairWin = await deviceService.pairDevice(codeWin.code, "Family Laptop", 'windows', '1.0.3-pilot');
    windowsDeviceId = pairWin.device.id;
    windowsDeviceToken = pairWin.device.deviceToken;

    // 5. Create Family B with separate parent, child, and device
    const parentBEmail = `parent.familyb.${nanoid(6)}@example.com`;
    const regB = await authService.register(parentBEmail, testPassword, 'Parent B');
    const tokenB = getActivationToken(parentBEmail);
    await authService.activateAccount(tokenB);
    const famB = await familyService.getOrCreateUserFamily(regB.user.id);
    familyBId = famB.id;

    const cBfamBRes = await childService.createChild(regB.user.id, 'OtherChild', 10, undefined, familyBId);
    childBFamilyBId = cBfamBRes.child.id;

    const codeB = await deviceService.generatePairingCode(regB.user.id, childBFamilyBId);
    const pairB = await deviceService.pairDevice(codeB.code, "Other's Device", 'android', '1.0.3-pilot');
    deviceFamilyBId = pairB.device.id;
    deviceTokenFamilyB = pairB.device.deviceToken;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ==========================================
  // SECTION 3: ANDROID POLICY FETCH AUTHENTICATION
  // ==========================================
  describe('1. Android Policy Fetch Authentication (GET /api/policies/device/:deviceId)', () => {
    it('should successfully return policy when valid x-device-id and x-device-token are provided', async () => {
      const res = await api('GET', `/api/policies/device/${androidDeviceId}`, {
        'x-device-id': androidDeviceId,
        'x-device-token': androidDeviceToken,
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.data.policy);
      assert.strictEqual(res.data.policy.childId, childAId);
      assert.strictEqual(typeof res.data.policy.version, 'number');
    });

    it('should reject policy fetch when x-device-token is missing (401)', async () => {
      const res = await api('GET', `/api/policies/device/${androidDeviceId}`, {
        'x-device-id': androidDeviceId,
      });

      assert.strictEqual(res.status, 401);
      assert.ok(res.data.error.includes('deviceToken is required'));
    });

    it('should reject policy fetch when x-device-token is invalid (401)', async () => {
      const res = await api('GET', `/api/policies/device/${androidDeviceId}`, {
        'x-device-id': androidDeviceId,
        'x-device-token': 'dtk_invalid_tampered_token',
      });

      assert.strictEqual(res.status, 401);
      assert.ok(res.data.error.includes('Invalid device token'));
    });

    it('should reject policy fetch when deviceId does not exist (401)', async () => {
      const res = await api('GET', `/api/policies/device/dev_nonexistent`, {
        'x-device-id': 'dev_nonexistent',
        'x-device-token': androidDeviceToken,
      });

      assert.strictEqual(res.status, 401);
      assert.ok(res.data.error.includes('Device not found'));
    });
  });

  // ==========================================
  // SECTION 6: ASK PARENT REGRESSION
  // ==========================================
  describe('2. Ask Parent Regression (POST /api/requests)', () => {
    it('should successfully create access request from authenticated device', async () => {
      const res = await api(
        'POST',
        '/api/requests',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childAId,
          domain: 'khanacademy.org',
          reason: 'Need for homework research',
        }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.domain, 'khanacademy.org');
      assert.strictEqual(res.data.status, 'PENDING');
      assert.strictEqual(res.data.childId, childAId);
      assert.strictEqual(res.data.deviceId, androidDeviceId);

      // Verify deviceToken is NEVER returned in response
      assert.strictEqual((res.data as any).deviceToken, undefined);
    });

    it('should reject access request when device token is invalid (401)', async () => {
      const res = await api(
        'POST',
        '/api/requests',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': 'dtk_wrong_token',
        },
        {
          childId: childAId,
          domain: 'roblox.com',
          reason: 'Please approve',
        }
      );

      assert.strictEqual(res.status, 401);
    });

    it('should reject access request when child belongs to a different family (403)', async () => {
      // Android device belongs to Family A, but requests access for child in Family B
      const res = await api(
        'POST',
        '/api/requests',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childBFamilyBId, // Family B child!
          domain: 'games.com',
          reason: 'Cross family attempt',
        }
      );

      assert.strictEqual(res.status, 403);
      assert.ok(res.data.error.includes('Forbidden'));
    });

    it('should allow parent to view pending access requests in Parent Portal', async () => {
      const res = await api('GET', '/api/requests/pending', {
        Authorization: `Bearer ${parentToken}`,
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data));
      const found = res.data.find((r: any) => r.domain === 'khanacademy.org' && r.childId === childAId);
      assert.ok(found, 'Created request must appear in parent pending list');
      assert.strictEqual(found.status, 'PENDING');
    });
  });

  // ==========================================
  // SECTION 7: WINDOWS USAGE DELTA REGRESSION
  // ==========================================
  describe('3. Windows Usage Delta Regression (POST /api/usage/session & /api/usage/sync)', () => {
    it('should increment by delta only: 30 + 30 + 30 = 90 sec, never cumulative 180 sec', async () => {
      const appName = 'RobloxPlayerBeta.exe';

      // 1st sync: 30 sec delta
      const res1 = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childAId,
          appName,
          durationSeconds: 30,
          clientWallIso: new Date().toISOString(),
        }
      );
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.data.consumedSeconds, 30, '1st sync: consumed should be 30');

      // 2nd sync: 30 sec delta
      const res2 = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childAId,
          appName,
          durationSeconds: 30,
          clientWallIso: new Date().toISOString(),
        }
      );
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.data.consumedSeconds, 60, '2nd sync: consumed should be 60 (30 + 30)');

      // 3rd sync: 30 sec delta
      const res3 = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childAId,
          appName,
          durationSeconds: 30,
          clientWallIso: new Date().toISOString(),
        }
      );
      assert.strictEqual(res3.status, 200);
      assert.strictEqual(res3.data.consumedSeconds, 90, '3rd sync: consumed should be 90 (60 + 30)');
      assert.notStrictEqual(res3.data.consumedSeconds, 180, 'Must NOT double-count cumulative totals (180s)');
    });

    it('should reject non-positive or excessive usage increments (400)', async () => {
      const resZero = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childAId,
          appName: 'RobloxPlayerBeta.exe',
          durationSeconds: 0,
        }
      );
      assert.strictEqual(resZero.status, 400);

      const resExcessive = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childAId,
          appName: 'RobloxPlayerBeta.exe',
          durationSeconds: 5000, // Exceeds 3600 limit
        }
      );
      assert.strictEqual(resExcessive.status, 400);
      assert.ok(resExcessive.data.error.includes('between 1 and 3600'));
    });
  });

  // ==========================================
  // SECTION 8: SHARED LAPTOP CHILD ATTRIBUTION
  // ==========================================
  describe('4. Shared Laptop Child Attribution', () => {
    it('should attribute usage to active child profile (Child B / Rahul) rather than default paired child', async () => {
      // Windows laptop was paired under Child A, but Rahul is active console user
      const res = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childBId, // Rahul!
          appName: 'Minecraft.exe',
          durationSeconds: 45,
          clientWallIso: new Date().toISOString(),
        }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.consumedSeconds, 45);

      // Verify in DB that usage is attributed to Child B
      const record = await prisma.childUsageRecord.findFirst({
        where: {
          childId: childBId,
          target: 'minecraft.exe',
        },
      });
      assert.ok(record, 'Child B record must exist');
      assert.strictEqual(record.consumedSeconds, 45);

      // Verify Child A did NOT receive Rahul's usage
      const recordA = await prisma.childUsageRecord.findFirst({
        where: {
          childId: childAId,
          target: 'minecraft.exe',
        },
      });
      assert.strictEqual(recordA, null, "Child A must not receive Rahul's Minecraft usage");
    });

    it('should attribute DNS activity to active child profile (Child B / Rahul)', async () => {
      const res = await api(
        'POST',
        '/api/activity',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childBId, // Rahul
          domain: 'scratch.mit.edu',
          action: 'ALLOWED',
          category: 'EDUCATION',
          reason: 'Learning programming',
        }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.childId, childBId);
      assert.strictEqual(res.data.domain, 'scratch.mit.edu');

      // Verify activity in DB
      const dbAct = await prisma.activityEvent.findFirst({
        where: {
          childId: childBId,
          domain: 'scratch.mit.edu',
        },
      });
      assert.ok(dbAct, 'Activity must be persisted for Child B');
      assert.strictEqual(dbAct.childId, childBId);
    });
  });

  // ==========================================
  // SECTION 9: BACKEND TELEMETRY VALIDATION
  // ==========================================
  describe('5. Backend Telemetry Validation Hardening', () => {
    it('POST /api/activity: enforces family tenancy, rejecting cross-family child (403)', async () => {
      const res = await api(
        'POST',
        '/api/activity',
        {
          'x-device-id': androidDeviceId, // Family A device
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childBFamilyBId, // Family B child!
          domain: 'crossfamily.com',
          action: 'BLOCKED',
        }
      );

      assert.strictEqual(res.status, 403);
      assert.ok(res.data.error.includes('Forbidden'));
    });

    it('POST /api/activity: rejects invalid activity actions (400)', async () => {
      const res = await api(
        'POST',
        '/api/activity',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childAId,
          domain: 'somewebsite.com',
          action: 'INVALID_UNKNOWN_ACTION',
        }
      );

      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('Unsupported activity action'));
    });

    it('POST /api/activity: rejects invalid timestamps outside 30-day window (400)', async () => {
      // 60 days in past
      const pastDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const res = await api(
        'POST',
        '/api/activity',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childAId,
          domain: 'oldactivity.com',
          action: 'ALLOWED',
          timestamp: pastDate,
        }
      );

      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('Invalid activity timestamp'));
    });

    it('POST /api/activity: batch mode accepts valid events and rejects invalid ones', async () => {
      const now = new Date().toISOString();
      const ancientDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

      const res = await api(
        'POST',
        '/api/activity',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          events: [
            {
              domain: 'valid1.com',
              action: 'ALLOWED',
              childId: childAId,
              timestamp: now,
            },
            {
              domain: 'valid2.com',
              action: 'BLOCKED',
              childId: childAId,
              timestamp: now,
            },
            {
              domain: 'invalid-action.com',
              action: 'NOT_REAL',
              childId: childAId,
              timestamp: now,
            },
            {
              domain: 'ancient.com',
              action: 'ALLOWED',
              childId: childAId,
              timestamp: ancientDate, // Invalid timestamp
            },
          ],
        }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.count, 2, '2 valid events should be accepted');
      assert.strictEqual(res.data.rejected, 2, '2 invalid events should be rejected');
      assert.strictEqual(res.data.success, false);
    });

    it('POST /api/usage/sync: rejects cross-family child (403)', async () => {
      const res = await api(
        'POST',
        '/api/usage/sync',
        {
          'x-device-id': androidDeviceId, // Family A device
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childBFamilyBId, // Family B child!
          target: 'youtube.com',
          targetType: 'DOMAIN',
          secondsIncrement: 30,
        }
      );

      assert.strictEqual(res.status, 403);
      assert.ok(res.data.error.includes('Forbidden'));
    });

    it('POST /api/usage/sync: rejects unsupported targetType (400)', async () => {
      const res = await api(
        'POST',
        '/api/usage/sync',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childAId,
          target: 'youtube.com',
          targetType: 'UNSUPPORTED_TARGET',
          secondsIncrement: 30,
        }
      );

      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('Unsupported targetType'));
    });

    it('POST /api/usage/sync: rejects invalid clientWallIso (400)', async () => {
      const res = await api(
        'POST',
        '/api/usage/sync',
        {
          'x-device-id': androidDeviceId,
          'x-device-token': androidDeviceToken,
        },
        {
          childId: childAId,
          target: 'youtube.com',
          targetType: 'DOMAIN',
          secondsIncrement: 30,
          clientWallIso: 'not-a-valid-date-string',
        }
      );

      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('Invalid clientWallIso'));
    });

    it('POST /api/usage/session: rejects cross-family child (403)', async () => {
      const res = await api(
        'POST',
        '/api/usage/session',
        {
          'x-device-id': windowsDeviceId,
          'x-device-token': windowsDeviceToken,
        },
        {
          childId: childBFamilyBId, // Family B child!
          appName: 'Game.exe',
          durationSeconds: 30,
        }
      );

      assert.strictEqual(res.status, 403);
      assert.ok(res.data.error.includes('Forbidden'));
    });
  });
});
