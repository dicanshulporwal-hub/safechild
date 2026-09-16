import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { app, bootstrap } from '../src/server';
import { prisma } from '../src/db/prisma';
import { nanoid } from 'nanoid';
import {
  validateTestDatabaseUrl,
  assertLiveTestDatabaseMarker,
} from '../src/utils/test-db-guard';
import { authService } from '../src/services/auth.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { policyService } from '../src/services/policy.service';
import type { PolicySyncClient as PolicySyncClientType } from '../../agent-windows/dist/sync-client';
const { PolicySyncClient } = require(path.resolve(__dirname, '../../../agent-windows/dist/sync-client')) as {
  PolicySyncClient: typeof PolicySyncClientType;
};

describe('SafeBrowse Stage 11 Step 4: Windows Device Policy Authentication & Sync Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  const testPassword = 'StrongDeviceAuth2026!';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;

  let otherChildId: string;
  let otherDeviceId: string;
  let otherDeviceToken: string;

  const tempCacheDir = path.join(process.cwd(), 'temp-test-cache-' + nanoid(6));

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
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://safebrowse:safebrowse_dev_password@127.0.0.1:5432/safebrowse_test';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    // Clean test tables
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "UserSession", "MfaChallenge", "AccessRequest", "ChildUsageRecord", 
      "ActivityEvent", "Policy", "PairingCode", "Device", "Child", "FamilyInvitation", 
      "FamilyAuditLog", "FamilyMember", "Family", "User" CASCADE;
    `);

    // Bootstrap Express server
    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    if (!fs.existsSync(tempCacheDir)) {
      fs.mkdirSync(tempCacheDir, { recursive: true });
    }

    // Setup Primary Parent, Family, Child, Device
    parentEmail = `parent-devauth-${nanoid(6).toLowerCase()}@safebrowse.io`;
    const reg = await authService.register(parentEmail, testPassword, 'Device Auth Parent');
    parentUserId = reg.user.id;
    await authService.activateAccount(reg.activationToken!);
    const login = await authService.login(parentEmail, testPassword);
    parentToken = login.token!;

    const family = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = family.id;

    const childRes = await childService.createChild(parentUserId, 'Test Child', 12, undefined, familyId);
    childId = childRes.child.id;

    const pairing = await deviceService.generatePairingCode(parentUserId, childId);
    const paired = await deviceService.pairDevice(pairing.code, 'Test Windows PC', 'windows');
    deviceId = paired.device.id;
    deviceToken = paired.device.deviceToken;

    // Create a second child and device in another family for tenancy/cross-fetch isolation testing
    const otherParentEmail = `other-parent-${nanoid(6).toLowerCase()}@safebrowse.io`;
    const otherReg = await authService.register(otherParentEmail, testPassword, 'Other Parent');
    await authService.activateAccount(otherReg.activationToken!);
    const otherFamily = await familyService.getOrCreateUserFamily(otherReg.user.id);
    const otherChildRes = await childService.createChild(otherReg.user.id, 'Other Child', 14, undefined, otherFamily.id);
    otherChildId = otherChildRes.child.id;

    const otherPairing = await deviceService.generatePairingCode(otherReg.user.id, otherChildId);
    const otherPaired = await deviceService.pairDevice(otherPairing.code, 'Other Windows PC', 'windows');
    otherDeviceId = otherPaired.device.id;
    otherDeviceToken = otherPaired.device.deviceToken;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(tempCacheDir)) {
      try {
        fs.rmSync(tempCacheDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  it('1. should include correct x-device-id and x-device-token headers in policy requests', async () => {
    const res = await api('GET', `/api/policies/device/${encodeURIComponent(deviceId)}`, {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.policy);
    assert.strictEqual(res.data.policy.childId, childId);
  });

  it('2. should return and cache the current device policy with valid credentials via PolicySyncClient', async () => {
    const client = new PolicySyncClient(
      {
        deviceId,
        deviceToken,
        childId,
        parentId: parentUserId,
        deviceName: 'Test Windows PC',
        backendUrl: baseUrl,
      },
      tempCacheDir
    );

    const policy = await client.fetchLatestPolicy();
    assert.ok(policy);
    assert.strictEqual(policy.childId, childId);
    assert.strictEqual(typeof policy.version, 'number');

    const cachedPolicy = client.getActivePolicy();
    assert.ok(cachedPolicy);
    assert.strictEqual(cachedPolicy.id, policy.id);

    const cacheFile = path.join(tempCacheDir, `policy-${deviceId}.json`);
    assert.ok(fs.existsSync(cacheFile));
    const diskPolicy = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    assert.strictEqual(diskPolicy.id, policy.id);
  });

  it('3. should reject policy request with HTTP 401 when token is missing', async () => {
    const res = await api('GET', `/api/policies/device/${encodeURIComponent(deviceId)}`, {
      'x-device-id': deviceId,
    });

    assert.strictEqual(res.status, 401);
    assert.match(res.data.error, /deviceToken is required/i);
  });

  it('4. should reject policy request with HTTP 401 when token is incorrect', async () => {
    const res = await api('GET', `/api/policies/device/${encodeURIComponent(deviceId)}`, {
      'x-device-id': deviceId,
      'x-device-token': 'dtk_invalid_wrong_token_12345',
    });

    assert.strictEqual(res.status, 401);
    assert.match(res.data.error, /Invalid device token/i);
  });

  it('5. should reject Parent JWT token on device policy route with HTTP 401', async () => {
    const res = await api('GET', `/api/policies/device/${encodeURIComponent(deviceId)}`, {
      Authorization: `Bearer ${parentToken}`,
    });

    assert.strictEqual(res.status, 401);
    assert.match(res.data.error, /Parent tokens are not accepted for device endpoints/i);
  });

  it('6. should reject cross-device / cross-family policy fetch (Device A token fetching Device B)', async () => {
    const forgedHeaderRes = await api('GET', `/api/policies/device/${encodeURIComponent(otherDeviceId)}`, {
      'x-device-id': otherDeviceId,
      'x-device-token': deviceToken, // Device A's token with Device B's ID
    });

    assert.strictEqual(forgedHeaderRes.status, 401);
    assert.match(forgedHeaderRes.data.error, /Invalid device token/i);
  });

  it('7. should not overwrite or replace cached policy when policy fetch returns 401 or 403', async () => {
    const client = new PolicySyncClient(
      {
        deviceId,
        deviceToken: 'dtk_tampered_invalid_token',
        childId,
        parentId: parentUserId,
        deviceName: 'Test Windows PC',
        backendUrl: baseUrl,
      },
      tempCacheDir
    );

    // Initial cache should already exist from Test 2
    const initialCached = client.getActivePolicy();
    assert.ok(initialCached, 'Pre-existing cached policy should be present');

    // Attempt fetch with invalid token
    const result = await client.fetchLatestPolicy();

    // Active policy must remain intact and not nullified/overwritten
    assert.ok(result);
    assert.strictEqual(result.id, initialCached.id);
    assert.strictEqual(client.getActivePolicy()?.id, initialCached.id);
  });

  it('8. should authenticate correctly during heartbeat-triggered refresh when policyChanged is true', async () => {
    // Update child policy to trigger version bump
    await policyService.addRule(childId, 'gambling-block-test.com', 'BLOCK', 'Heartbeat Test Rule');

    const client = new PolicySyncClient(
      {
        deviceId,
        deviceToken,
        childId,
        parentId: parentUserId,
        deviceName: 'Test Windows PC',
        backendUrl: baseUrl,
      },
      tempCacheDir
    );

    // Send heartbeat with older version (version 1)
    const hbRes = await client.sendHeartbeat(true);
    assert.ok(hbRes);
    assert.strictEqual(hbRes.policyChanged, true);

    // Client should have automatically called fetchLatestPolicy and updated active policy
    const updatedPolicy = client.getActivePolicy();
    assert.ok(updatedPolicy);
    const hasBlockedDomain = updatedPolicy.rules.some((r) => r.domain === 'gambling-block-test.com');
    assert.strictEqual(hasBlockedDomain, true);
  });

  it('9. should never expose deviceToken in console logs or error outputs', async () => {
    const loggedMessages: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: any[]) => {
      loggedMessages.push(args.map((a) => String(a)).join(' '));
      origLog.apply(console, args);
    };
    console.warn = (...args: any[]) => {
      loggedMessages.push(args.map((a) => String(a)).join(' '));
      origWarn.apply(console, args);
    };
    console.error = (...args: any[]) => {
      loggedMessages.push(args.map((a) => String(a)).join(' '));
      origError.apply(console, args);
    };

    try {
      const client = new PolicySyncClient(
        {
          deviceId,
          deviceToken,
          childId,
          parentId: parentUserId,
          deviceName: 'Test Windows PC',
          backendUrl: baseUrl,
        },
        tempCacheDir
      );

      await client.fetchLatestPolicy();
      await client.sendHeartbeat(true);

      // Trigger a failure
      const badClient = new PolicySyncClient(
        {
          deviceId: 'non-existent-device',
          deviceToken: 'dtk_secret_never_leak_this_token_12345',
          childId,
          parentId: parentUserId,
          deviceName: 'Bad PC',
          backendUrl: baseUrl,
        },
        tempCacheDir
      );
      await badClient.fetchLatestPolicy();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    const secretLeak = loggedMessages.some(
      (msg) => msg.includes(deviceToken) || msg.includes('dtk_secret_never_leak_this_token_12345')
    );
    assert.strictEqual(secretLeak, false, 'deviceToken was leaked in console logs');
  });

  it('10. should pair and immediately fetch initial policy with no HTTP 401', async () => {
    // Generate new pairing code
    const pairing = await deviceService.generatePairingCode(parentUserId, childId);

    // Simulate agent pairing flow
    const pairRes = await api('POST', '/api/devices/pair', undefined, {
      code: pairing.code,
      deviceName: 'Fresh Paired Windows Laptop',
      platform: 'windows',
    });

    assert.strictEqual(pairRes.status, 200);
    assert.ok(pairRes.data.device?.id);
    assert.ok(pairRes.data.device?.deviceToken);

    const freshDeviceId = pairRes.data.device.id;
    const freshDeviceToken = pairRes.data.device.deviceToken;

    // Immediately fetch initial policy using returned credentials
    const freshClient = new PolicySyncClient(
      {
        deviceId: freshDeviceId,
        deviceToken: freshDeviceToken,
        childId,
        parentId: parentUserId,
        deviceName: 'Fresh Paired Windows Laptop',
        backendUrl: baseUrl,
      },
      tempCacheDir
    );

    const initialPolicy = await freshClient.fetchLatestPolicy();
    assert.ok(initialPolicy, 'Initial policy should be returned without 401');
    assert.strictEqual(initialPolicy.childId, childId);
  });
});
