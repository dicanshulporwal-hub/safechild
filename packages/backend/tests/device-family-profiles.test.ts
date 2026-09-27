import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';
import { bootstrap } from '../src/bootstrap';
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
import { WebSocket } from 'ws';

describe('SafeBrowse Shared Laptop Device Profiles & Multi-Child Telemetry Suite', () => {
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

  const testPassword = 'StrongPassword123!SharedLaptop';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let manjariChildId: string;
  let rahulChildId: string;
  let deviceId: string;
  let deviceToken: string;

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
    const text = await res.text();
    let data: any;
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

    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Register and activate parent
    parentEmail = `parent-shared-${nanoid(6).toLowerCase()}@example.com`;
    const reg = await authService.register(parentEmail, testPassword, 'Family Parent');
    parentUserId = reg.user.id;
    const actToken = getActivationToken(parentEmail);
    await authService.activateAccount(actToken);
    const login = await authService.login(parentEmail, testPassword);
    parentToken = login.token!;

    const family = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = family.id;

    // 2. Create two children: Manjari and Rahul
    const manjariRes = await childService.createChild(parentUserId, 'Manjari', 11, undefined, familyId);
    manjariChildId = manjariRes.child.id;
    const rahulRes = await childService.createChild(parentUserId, 'Rahul', 8, undefined, familyId);
    rahulChildId = rahulRes.child.id;

    // Add specific block rule to Manjari's policy (roblox.com)
    await policyService.addRule(manjariChildId, 'roblox.com', 'BLOCK', 'Parent blocked roblox');

    // Add specific block rule to Rahul's policy (youtube.com)
    await policyService.addRule(rahulChildId, 'youtube.com', 'BLOCK', 'Bedtime restriction');

    // 3. Pair device to family (initially associated with Manjari)
    const codeObj = await deviceService.generatePairingCode(parentUserId, manjariChildId);
    const pairResult = await deviceService.pairDevice(codeObj.code, 'Shared Family Laptop', 'windows', '1.0.0');
    deviceId = pairResult.device.id;
    deviceToken = pairResult.device.deviceToken;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. should return all family child profiles to an authenticated device via /api/devices/family-profiles', async () => {
    const res = await api('GET', '/api/devices/family-profiles', {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    });

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.strictEqual(res.data.length >= 2, true);

    const names = res.data.map((c: any) => c.name);
    assert.ok(names.includes('Manjari'), 'Should include Manjari profile');
    assert.ok(names.includes('Rahul'), 'Should include Rahul profile');
  });

  it('2. should fetch policy for specific child in the family via /api/policies/device/:id?childId=...', async () => {
    // Fetch Manjari's policy
    const manjariRes = await api('GET', `/api/policies/device/${deviceId}?childId=${manjariChildId}`, {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    });
    assert.strictEqual(manjariRes.status, 200);
    assert.strictEqual(manjariRes.data.policy.childId, manjariChildId);
    const manjariDomains = (manjariRes.data.policy.rules || []).map((r: any) => r.domain);
    assert.ok(manjariDomains.includes('roblox.com'), 'Manjari policy must contain roblox.com block');

    // Fetch Rahul's policy from the same device
    const rahulRes = await api('GET', `/api/policies/device/${deviceId}?childId=${rahulChildId}`, {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    });
    assert.strictEqual(rahulRes.status, 200);
    assert.strictEqual(rahulRes.data.policy.childId, rahulChildId);
    const rahulDomains = (rahulRes.data.policy.rules || []).map((r: any) => r.domain);
    assert.ok(rahulDomains.includes('youtube.com'), 'Rahul policy must contain youtube.com block');
    assert.ok(!rahulDomains.includes('roblox.com'), 'Rahul policy must NOT contain Manjari rules');
  });

  it('3. should batch activity telemetry events attributed to different children via POST /api/activity', async () => {
    const batchEvents = [
      {
        domain: 'khanacademy.org',
        action: 'ALLOW',
        childId: manjariChildId,
      },
      {
        domain: 'roblox.com',
        action: 'BLOCK',
        childId: manjariChildId,
      },
      {
        domain: 'pbskids.org',
        action: 'ALLOW',
        childId: rahulChildId,
      },
      {
        domain: 'youtube.com',
        action: 'BLOCK',
        childId: rahulChildId,
      },
    ];

    const res = await api('POST', '/api/activity', {
      'x-device-id': deviceId,
      'x-device-token': deviceToken,
    }, {
      events: batchEvents,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.count, 4);

    // Verify parent can retrieve activity attributed correctly to Manjari
    const manjariLogs = await api('GET', `/api/activity/child/${manjariChildId}`, {
      Authorization: `Bearer ${parentToken}`,
    });
    assert.strictEqual(manjariLogs.status, 200);
    const manjariLoggedDomains = manjariLogs.data.map((l: any) => l.domain);
    assert.ok(manjariLoggedDomains.includes('khanacademy.org'));
    assert.ok(manjariLoggedDomains.includes('roblox.com'));
    assert.ok(!manjariLoggedDomains.includes('pbskids.org'), 'Manjari log must not contain Rahul events');

    // Verify parent can retrieve activity attributed correctly to Rahul
    const rahulLogs = await api('GET', `/api/activity/child/${rahulChildId}`, {
      Authorization: `Bearer ${parentToken}`,
    });
    assert.strictEqual(rahulLogs.status, 200);
    const rahulLoggedDomains = rahulLogs.data.map((l: any) => l.domain);
    assert.ok(rahulLoggedDomains.includes('pbskids.org'));
    assert.ok(rahulLoggedDomains.includes('youtube.com'));
    assert.ok(!rahulLoggedDomains.includes('roblox.com'), 'Rahul log must not contain Manjari events');
  });

  it('4. should deliver real-time POLICY_UPDATED broadcast for any family child to the paired device', async () => {
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Authenticate device via message payload
    ws.send(JSON.stringify({
      type: 'AUTH_DEVICE',
      deviceId,
      deviceToken,
    }));

    const receivedMessages: any[] = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);
      } catch {}
    });

    // Wait for AUTH_SUCCESS
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AUTH_SUCCESS timed out')), 5000);
      const interval = setInterval(() => {
        if (receivedMessages.some((m) => m.type === 'AUTH_SUCCESS')) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
    });

    // Mutate Rahul's policy (even though device was initially paired with Manjari)
    await api('POST', `/api/policies/child/${rahulChildId}/rules`, {
      Authorization: `Bearer ${parentToken}`,
    }, {
      domain: 'minecraft.net',
      action: 'BLOCK',
      reason: 'Gaming restriction',
    });

    // Device should receive the broadcast for Rahul because they belong to the same family
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('POLICY_UPDATED timed out')), 5000);
      const interval = setInterval(() => {
        if (receivedMessages.some((m) => m.type === 'POLICY_UPDATED' && (m.childId === rahulChildId || m.payload?.childId === rahulChildId))) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
    });

    const updateMsg = receivedMessages.find((m) => m.type === 'POLICY_UPDATED' && (m.childId === rahulChildId || m.payload?.childId === rahulChildId));
    assert.ok(updateMsg, 'Paired shared device must receive policy update for any child in its family');
    ws.close();
  });
});
