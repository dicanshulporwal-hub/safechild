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
import { mailService } from '../src/services/mail.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { policyService } from '../src/services/policy.service';
import { wsManager } from '../src/services/websocket.service';
import { WebSocket } from 'ws';
import type { PolicySyncClient as PolicySyncClientType } from '../../agent-windows/dist/sync-client';
const { PolicySyncClient } = require(path.resolve(__dirname, '../../../agent-windows/dist/sync-client')) as {
  PolicySyncClient: typeof PolicySyncClientType;
};

describe('SafeBrowse Stage 11 Step 4: Windows Device Policy Authentication & Sync Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  function getActivationToken(email: string): string {
    const mail = mailService.getOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase().trim()).pop();
    if (!mail || !mail.token) {
      throw new Error(`No activation token found in outbox for ${email}`);
    }
    return mail.token;
  }

  const testPassword = 'StrongPassword123!WindowsSync';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;

  let otherParentToken: string;
  let otherChildId: string;
  let otherDeviceId: string;
  let otherDeviceToken: string;

  const tempCacheDir = path.resolve(__dirname, '../temp-sync-cache');

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
    await authService.activateAccount(getActivationToken(parentEmail));
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
    await authService.activateAccount(getActivationToken(otherParentEmail));
    const otherLogin = await authService.login(otherParentEmail, testPassword);
    otherParentToken = otherLogin.token!;
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

  it('11. should strictly isolate child profiles within the same family (Rahul vs Priya)', async () => {
    // 1. Create second child (Priya) in the same family as Rahul (childId)
    const priyaRes = await childService.createChild(parentUserId, 'Priya', 10, undefined, familyId);
    const priyaChildId = priyaRes.child.id;
    assert.ok(priyaChildId);
    assert.notStrictEqual(priyaChildId, childId, 'Priya must have a distinct child ID from Rahul');

    // 2. Generate pairing code for Priya
    const priyaPairing = await deviceService.generatePairingCode(parentUserId, priyaChildId);
    assert.strictEqual(priyaPairing.childId, priyaChildId);
    assert.strictEqual(priyaPairing.familyId, familyId);

    // 3. Pair device specifically for Priya
    const priyaPairRes = await api('POST', '/api/devices/pair', undefined, {
      code: priyaPairing.code,
      deviceName: "Priya's Windows Laptop",
      platform: 'windows',
    });
    assert.strictEqual(priyaPairRes.status, 200);
    const priyaDeviceId = priyaPairRes.data.device.id;
    const priyaDeviceToken = priyaPairRes.data.device.deviceToken;
    assert.strictEqual(priyaPairRes.data.device.childId, priyaChildId);

    // 4. Add independent policies to Rahul and Priya
    await policyService.addRule(childId, 'roblox-for-rahul-only.com', 'BLOCK', 'Rule for Rahul');
    await policyService.addRule(priyaChildId, 'minecraft-for-priya-only.com', 'BLOCK', 'Rule for Priya');

    // 5. Fetch Rahul's policy via Rahul's device credentials
    const rahulPolicyRes = await api('GET', `/api/policies/device/${encodeURIComponent(deviceId)}`, {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    });
    assert.strictEqual(rahulPolicyRes.status, 200);
    const rahulRules = rahulPolicyRes.data.policy.rules.map((r: any) => r.domain);
    assert.ok(rahulRules.includes('roblox-for-rahul-only.com'), "Rahul's policy must include Rahul's rule");
    assert.strictEqual(
      rahulRules.includes('minecraft-for-priya-only.com'),
      false,
      "Rahul's policy must NOT include Priya's rule"
    );

    // 6. Fetch Priya's policy via Priya's device credentials
    const priyaPolicyRes = await api('GET', `/api/policies/device/${encodeURIComponent(priyaDeviceId)}`, {
      'x-device-id': priyaDeviceId,
      'x-device-token': priyaDeviceToken,
    });
    assert.strictEqual(priyaPolicyRes.status, 200);
    const priyaRules = priyaPolicyRes.data.policy.rules.map((r: any) => r.domain);
    assert.ok(priyaRules.includes('minecraft-for-priya-only.com'), "Priya's policy must include Priya's rule");
    assert.strictEqual(
      priyaRules.includes('roblox-for-rahul-only.com'),
      false,
      "Priya's policy must NOT include Rahul's rule"
    );

    // 7. Sibling credential cross-fetch: Rahul's device token querying Priya's device endpoint -> 401
    const siblingCrossFetch = await api('GET', `/api/policies/device/${encodeURIComponent(priyaDeviceId)}`, {
      'x-device-id': priyaDeviceId,
      'x-device-token': deviceToken, // Rahul's token with Priya's device ID
    });
    assert.strictEqual(siblingCrossFetch.status, 401);

    // 8. Stale UI / unauthorized childId substitution: Unrelated parent attempts to generate pairing code for Rahul
    const unauthorizedPairingRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${otherParentToken}`, 'Content-Type': 'application/json' },
      { childId }
    );
    assert.strictEqual(unauthorizedPairingRes.status, 403, 'Cross-family pairing code generation must return 403');

    // 9. Unauthorized policy mutation: Unrelated parent attempts to add rule to Rahul
    const unauthorizedPolicyRes = await api(
      'POST',
      `/api/policies/child/${childId}/rules`,
      { Authorization: `Bearer ${otherParentToken}`, 'Content-Type': 'application/json' },
      { domain: 'unauthorized-attack.com', action: 'BLOCK' }
    );
    assert.strictEqual(unauthorizedPolicyRes.status, 403, 'Cross-family policy mutation must return 403');
  });

  it('12. should authenticate device connection via AUTH_DEVICE message payload without query parameters', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'AUTH_DEVICE',
          deviceId,
          deviceToken,
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          assert.strictEqual(msg.type, 'AUTH_SUCCESS');
          assert.strictEqual(msg.deviceId, deviceId);
          ws.close();
          resolve();
        } catch (e) {
          ws.close();
          reject(e);
        }
      });

      ws.on('error', reject);
    });
  });

  it('13. should authenticate parent connection via AUTH_PARENT message payload without query parameters', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'AUTH_PARENT',
          token: parentToken,
          childId,
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          assert.strictEqual(msg.type, 'AUTH_SUCCESS');
          assert.strictEqual(msg.parentId, parentUserId);
          ws.close();
          resolve();
        } catch (e) {
          ws.close();
          reject(e);
        }
      });

      ws.on('error', reject);
    });
  });

  it('14. should strictly prevent unauthenticated WebSocket connections from receiving protected broadcasts', async () => {
    const unauthWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const authedParentWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const authedDeviceWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const unauthMessages: any[] = [];
    const parentMessages: any[] = [];
    const deviceMessages: any[] = [];

    // Setup message collectors
    unauthWs.on('message', (d) => unauthMessages.push(JSON.parse(d.toString())));
    authedParentWs.on('message', (d) => parentMessages.push(JSON.parse(d.toString())));
    authedDeviceWs.on('message', (d) => deviceMessages.push(JSON.parse(d.toString())));

    // Authenticate parent and device
    await Promise.all([
      new Promise<void>((resolve) => {
        authedParentWs.on('open', () => {
          authedParentWs.send(JSON.stringify({ type: 'AUTH_PARENT', token: parentToken, childId }));
          const check = setInterval(() => {
            if (parentMessages.some((m) => m.type === 'AUTH_SUCCESS')) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
      }),
      new Promise<void>((resolve) => {
        authedDeviceWs.on('open', () => {
          authedDeviceWs.send(JSON.stringify({ type: 'AUTH_DEVICE', deviceId, deviceToken }));
          const check = setInterval(() => {
            if (deviceMessages.some((m) => m.type === 'AUTH_SUCCESS')) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
      }),
      new Promise<void>((resolve) => {
        unauthWs.on('open', () => resolve());
      }),
    ]);

    // Clear initial auth handshake messages
    parentMessages.length = 0;
    deviceMessages.length = 0;
    unauthMessages.length = 0;

    // Broadcast protected events
    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: { version: 99, rules: [] },
      childId,
    });

    wsManager.broadcast({
      type: 'ACCESS_REQUEST_CREATED',
      payload: { domain: 'secret-request.com' },
      parentId: parentUserId,
      childId,
    });

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: { healthState: 'PROTECTED' },
      parentId: parentUserId,
      childId,
    });

    // Allow broadcast delivery
    await new Promise((r) => setTimeout(r, 200));

    // Verify authenticated parent and device received broadcasts
    assert.ok(parentMessages.length >= 2, 'Parent socket should receive notifications and health changes');
    assert.ok(deviceMessages.some((m) => m.type === 'POLICY_UPDATED'), 'Device socket should receive policy updates');

    // CRITICAL SECURITY ASSERTION: Unauthenticated connection MUST receive 0 protected broadcasts
    assert.strictEqual(
      unauthMessages.length,
      0,
      'Unauthenticated socket must not receive any protected broadcast'
    );

    unauthWs.close();
    authedParentWs.close();
    authedDeviceWs.close();
  });

  it('15. should reject invalid device credentials via AUTH_DEVICE and return generic AUTH_ERROR', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'AUTH_DEVICE',
          deviceId: 'non-existent-device-id',
          deviceToken: 'fake-token-12345',
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          assert.strictEqual(msg.type, 'AUTH_ERROR');
          assert.strictEqual(msg.message, 'Authentication failed');
          ws.close();
          resolve();
        } catch (e) {
          ws.close();
          reject(e);
        }
      });

      ws.on('error', reject);
    });
  });

  it('16. should reject invalid parent token via AUTH_PARENT and return generic AUTH_ERROR', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'AUTH_PARENT',
          token: 'invalid.forged.jwt.token',
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          assert.strictEqual(msg.type, 'AUTH_ERROR');
          assert.strictEqual(msg.message, 'Authentication failed');
          ws.close();
          resolve();
        } catch (e) {
          ws.close();
          reject(e);
        }
      });

      ws.on('error', reject);
    });
  });

  it('17. should verify zero live client WebSocket credential-query usage in source files', async () => {
    const appTsxPath = path.resolve(__dirname, '../../../parent-web/src/App.tsx');
    const notifCenterPath = path.resolve(__dirname, '../../../parent-web/src/components/NotificationCenter.tsx');
    const syncClientPath = path.resolve(__dirname, '../../../agent-windows/src/sync-client.ts');

    const appTsx = fs.readFileSync(appTsxPath, 'utf8');
    const notifCenter = fs.readFileSync(notifCenterPath, 'utf8');
    const syncClient = fs.readFileSync(syncClientPath, 'utf8');

    // Windows agent checks
    assert.strictEqual(syncClient.includes('/ws?'), false, 'agent-windows must not use /ws?');
    assert.strictEqual(syncClient.includes('deviceToken='), false, 'agent-windows must not put deviceToken in URL');
    assert.strictEqual(syncClient.includes('deviceId='), false, 'agent-windows must not put deviceId in URL');

    // Parent web checks
    assert.strictEqual(appTsx.includes('/ws?'), false, 'App.tsx must not use /ws?');
    assert.strictEqual(appTsx.includes('/ws?token='), false, 'App.tsx must not put token in WS URL');
    assert.strictEqual(notifCenter.includes('/ws?'), false, 'NotificationCenter.tsx must not use /ws?');
    assert.strictEqual(notifCenter.includes('?token='), false, 'NotificationCenter.tsx must not put token in WS URL');
  });

  it('18. should verify existing REST device authentication endpoints remain fully intact', async () => {
    // 1. GET device policy with valid headers
    const policyRes = await api('GET', `/api/policies/device/${encodeURIComponent(deviceId)}`, {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    });
    assert.strictEqual(policyRes.status, 200);
    assert.ok(policyRes.data.policy);

    // 2. POST device heartbeat
    const hbRes = await api('POST', '/api/devices/heartbeat', undefined, {
      deviceId,
      deviceToken,
      activePolicyVersion: policyRes.data.policy.version,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.0',
    });
    assert.strictEqual(hbRes.status, 200);
    assert.strictEqual(hbRes.data.status, 'ok');
  });
});
