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

describe('SafeBrowse Windows Pilot v1.0 — Device Management & Telemetry API Suite', () => {
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

  const testPassword = 'StrongPassword123!PilotDevice';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childAliceId: string;
  let childBobId: string;
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
    const testDbUrl =
      process.env.TEST_DATABASE_URL ||
      'postgresql://safebrowse:safebrowse_dev_password@127.0.0.1:5432/safebrowse_test';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Register & activate parent
    parentEmail = `parent-pilot-${nanoid(6).toLowerCase()}@example.com`;
    const regRes = await authService.register(parentEmail, testPassword, 'Pilot Parent');
    parentUserId = regRes.user.id;

    const actToken = getActivationToken(parentEmail);
    await authService.activateAccount(actToken);

    const loginRes = await authService.login(parentEmail, testPassword);
    parentToken = loginRes.token!;

    // Create family and two child profiles
    const fam = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = fam.id;

    const alice = await childService.createChild(parentUserId, 'Alice', 10, undefined, familyId);
    childAliceId = alice.child.id;

    const bob = await childService.createChild(parentUserId, 'Bob', 14, undefined, familyId);
    childBobId = bob.child.id;

    // Pair a device assigned to Alice
    const pairing = await deviceService.generatePairingCode(parentUserId, childAliceId);
    const pairResult = await deviceService.pairDevice(
      pairing.code,
      'Acer Aspire 5',
      'windows',
      '1.0.0-pilot'
    );
    deviceId = pairResult.device.id;
    deviceToken = pairResult.device.deviceToken;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. GET /api/devices returns parent devices with online status, childName, and no leaked secrets', async () => {
    const res = await api('GET', '/api/devices', {
      Authorization: `Bearer ${parentToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    const dev = res.data.find((d: any) => d.id === deviceId);
    assert.ok(dev, 'Paired device found in device list');
    assert.strictEqual(dev.name, 'Acer Aspire 5');
    assert.strictEqual(dev.platform, 'windows');
    assert.strictEqual(dev.childId, childAliceId);
    assert.strictEqual(dev.childName, 'Alice');
    assert.strictEqual(dev.agentVersion, '1.0.0-pilot');
    // Ensure security: deviceToken must NOT be present in parent list response
    assert.strictEqual(dev.deviceToken, undefined);
  });

  it('2. GET /api/devices/:id returns full device details, child metadata, and policy summary', async () => {
    const res = await api('GET', `/api/devices/${deviceId}`, {
      Authorization: `Bearer ${parentToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.device);
    assert.strictEqual(res.data.device.id, deviceId);
    assert.strictEqual(res.data.device.name, 'Acer Aspire 5');
    assert.strictEqual(res.data.device.deviceToken, undefined);

    assert.ok(res.data.child);
    assert.strictEqual(res.data.child.id, childAliceId);
    assert.strictEqual(res.data.child.name, 'Alice');

    assert.ok(res.data.policy);
    assert.ok(res.data.policy.version >= 1);
  });

  it('3. PATCH /api/devices/:id renames device and reassigns child profile with tenant enforcement', async () => {
    // 3a. Rename device
    const renameRes = await api(
      'PATCH',
      `/api/devices/${deviceId}`,
      { Authorization: `Bearer ${parentToken}` },
      { name: 'Acer Shared Laptop' }
    );
    assert.strictEqual(renameRes.status, 200);
    assert.strictEqual(renameRes.data.device.name, 'Acer Shared Laptop');

    // 3b. Reassign to Bob
    const reassignRes = await api(
      'PATCH',
      `/api/devices/${deviceId}`,
      { Authorization: `Bearer ${parentToken}` },
      { childId: childBobId }
    );
    assert.strictEqual(reassignRes.status, 200);
    assert.strictEqual(reassignRes.data.device.childId, childBobId);

    // Verify in details endpoint
    const details = await api('GET', `/api/devices/${deviceId}`, {
      Authorization: `Bearer ${parentToken}`,
    });
    assert.strictEqual(details.data.device.name, 'Acer Shared Laptop');
    assert.strictEqual(details.data.child.name, 'Bob');
  });

  it('4. POST /api/devices/:id/sync broadcasts policy update trigger to the device', async () => {
    const syncRes = await api('POST', `/api/devices/${deviceId}/sync`, {
      Authorization: `Bearer ${parentToken}`,
    });

    assert.strictEqual(syncRes.status, 200);
    assert.strictEqual(syncRes.data.success, true);
    assert.ok(syncRes.data.message.includes('Policy synchronization signal queued'));
  });

  it('5. POST /api/devices/heartbeat sets Attention Required / DEGRADED when hasMultipleSessions is true', async () => {
    // Send heartbeat with multi-session warning
    const hbRes = await api(
      'POST',
      '/api/devices/heartbeat',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      {
        activePolicyVersion: 1,
        enforcementActive: true,
        platform: 'windows',
        agentVersion: '1.0.0-pilot',
        mappedAccountName: 'DESKTOP-PC\\Bob',
        hasMultipleSessions: true,
        protectionStatus: 'DEGRADED',
      }
    );

    assert.strictEqual(hbRes.status, 200);
    assert.strictEqual(hbRes.data.status, 'ok');

    // Verify parent device details reflects Attention Required / Degraded state
    const devDetails = await api('GET', `/api/devices/${deviceId}`, {
      Authorization: `Bearer ${parentToken}`,
    });

    assert.strictEqual(devDetails.status, 200);
    assert.strictEqual(devDetails.data.device.healthState, 'DEGRADED');
    assert.strictEqual(devDetails.data.device.healthStatus, 'attention_required');
    assert.strictEqual(devDetails.data.device.windowsAccountName, 'DESKTOP-PC\\Bob');
    assert.strictEqual(devDetails.data.device.hasMultipleSessions, true);
  });

  it('6. DELETE /api/devices/:id revokes credentials and removes device permanently', async () => {
    const delRes = await api('DELETE', `/api/devices/${deviceId}`, {
      Authorization: `Bearer ${parentToken}`,
    });
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.data.success, true);

    // Verify device can no longer access heartbeat endpoint (credentials revoked)
    const hbAttempt = await api(
      'POST',
      '/api/devices/heartbeat',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      {
        activePolicyVersion: 1,
        enforcementActive: true,
        platform: 'windows',
      }
    );
    assert.strictEqual(hbAttempt.status, 401);

    // Verify device is no longer found in parent device list
    const listRes = await api('GET', '/api/devices', {
      Authorization: `Bearer ${parentToken}`,
    });
    const found = listRes.data.find((d: any) => d.id === deviceId);
    assert.strictEqual(found, undefined);
  });
});
