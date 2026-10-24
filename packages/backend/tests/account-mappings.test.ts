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

describe('SafeBrowse Stage C.4 — Device Account Mappings & Family Device Model Tests', () => {
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

  const testPassword = 'StrongPassword123!FamilyLaptop';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childAliceId: string;
  let childBobId: string;

  let otherParentEmail: string;
  let otherParentToken: string;
  let otherFamilyId: string;
  let otherChildEveId: string;

  let laptopDeviceId: string;
  let laptopDeviceToken: string;

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
      'postgresql://safebrowse:8a683c5c15aa50149bb805b59a2632b5af132d48987099ab@127.0.0.1:55432/safebrowse_test?schema=public';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Setup Main Family
    parentEmail = `parent.laptop.${nanoid().toLowerCase()}@example.test`;
    const regRes = await authService.register(parentEmail, testPassword, 'Family Parent');
    parentUserId = regRes.user.id;
    const actToken = getActivationToken(parentEmail);
    await authService.activateAccount(actToken);
    const loginRes = await authService.login(parentEmail, testPassword);
    parentToken = loginRes.token!;

    const fam = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = fam.id;

    // Create Children Alice and Bob
    const aliceRes = await childService.createChild(parentUserId, 'Alice', 10, undefined, familyId);
    childAliceId = aliceRes.child.id;

    const bobRes = await childService.createChild(parentUserId, 'Bob', 14, undefined, familyId);
    childBobId = bobRes.child.id;

    // 2. Setup Other Family (Eve) for isolation testing
    otherParentEmail = `parent.other.${nanoid().toLowerCase()}@example.test`;
    const otherRegRes = await authService.register(otherParentEmail, testPassword, 'Other Parent');
    const actTokenOther = getActivationToken(otherParentEmail);
    await authService.activateAccount(actTokenOther);
    const otherLoginRes = await authService.login(otherParentEmail, testPassword);
    otherParentToken = otherLoginRes.token!;

    const famOther = await familyService.getOrCreateUserFamily(otherRegRes.user.id);
    otherFamilyId = famOther.id;

    const eveRes = await childService.createChild(otherRegRes.user.id, 'Eve', 12, undefined, otherFamilyId);
    otherChildEveId = eveRes.child.id;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. Pairs Windows PC and initially flags as ACCOUNT_SETUP_REQUIRED before accounts configured', async () => {
    // Generate pairing code
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    assert.strictEqual(codeRes.status, 200);
    const { code } = codeRes.data;

    // Claim pairing code as Windows PC
    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code,
      deviceName: 'Family-Surface-Laptop',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
      windowsProtocolVersion: 3,
    });
    assert.strictEqual(claimRes.status, 200);
    assert.ok(claimRes.data.device);
    assert.ok(claimRes.data.device.id);
    assert.ok(claimRes.data.device.deviceToken);

    laptopDeviceId = claimRes.data.device.id;
    laptopDeviceToken = claimRes.data.device.deviceToken;

    // Fetch device details as parent
    const devRes = await api('GET', `/api/devices/${laptopDeviceId}`, { Authorization: `Bearer ${parentToken}` });
    assert.strictEqual(devRes.status, 200);
    assert.strictEqual(devRes.data.device.platform, 'windows');
    assert.strictEqual(devRes.data.device.healthState, 'ACCOUNT_SETUP_REQUIRED');
    assert.strictEqual(devRes.data.device.healthStatus, 'account_setup_required');
    assert.deepStrictEqual(devRes.data.device.accountMappings, []);
  });

  it('2. Rejects invalid SID format when syncing account mappings', async () => {
    const res = await api(
      'PUT',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { 'x-device-token': laptopDeviceToken },
      {
        mappings: [
          { windowsSid: 'NOT-A-REAL-SID', windowsUsername: 'AliceWin', childId: childAliceId },
        ],
      }
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.data.error.includes('Invalid Windows SID format'));
  });

  it('3. Rejects duplicate SIDs in mapping payload', async () => {
    const res = await api(
      'PUT',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { 'x-device-token': laptopDeviceToken },
      {
        mappings: [
          { windowsSid: 'S-1-5-21-111-222-333-1001', windowsUsername: 'AliceWin', childId: childAliceId },
          { windowsSid: 'S-1-5-21-111-222-333-1001', windowsUsername: 'AliceWin2', childId: childAliceId },
        ],
      }
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.data.error.includes('Duplicate mapping detected'));
  });

  it('4. Rejects child from another family (cross-tenant safety)', async () => {
    const res = await api(
      'PUT',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { 'x-device-token': laptopDeviceToken },
      {
        mappings: [
          { windowsSid: 'S-1-5-21-111-222-333-1001', windowsUsername: 'EveWin', childId: otherChildEveId },
        ],
      }
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.data.error.includes('does not belong to this device\'s family'));
  });

  it('5. Successfully syncs mappings using device token', async () => {
    const payload = {
      mappings: [
        {
          windowsSid: 'S-1-5-21-111-222-333-1001',
          windowsUsername: 'AliceWin',
          childId: childAliceId,
          enabled: true,
        },
        {
          windowsSid: 'S-1-5-21-111-222-333-1002',
          windowsUsername: 'BobWin',
          childId: childBobId,
          enabled: true,
        },
        {
          windowsSid: 'S-1-5-21-111-222-333-500',
          windowsUsername: 'ParentWin',
          childId: null, // Parent unmanaged
          enabled: true,
        },
      ],
    };

    const res = await api(
      'PUT',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { 'x-device-token': laptopDeviceToken },
      payload
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.count, 3);
    assert.strictEqual(res.data.mappings.length, 3);

    // Verify GET /api/devices/:id/account-mappings via device token
    const getRes = await api(
      'GET',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { 'x-device-token': laptopDeviceToken }
    );
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.data.mappings.length, 3);
    const aliceMapping = getRes.data.mappings.find((m: any) => m.windowsSid === 'S-1-5-21-111-222-333-1001');
    assert.ok(aliceMapping);
    assert.strictEqual(aliceMapping.childId, childAliceId);
    assert.strictEqual(aliceMapping.childName, 'Alice');
  });

  it('6. Parent can also read and sync mappings via parent JWT', async () => {
    const getRes = await api(
      'GET',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.data.mappings.length, 3);

    // Other parent cannot access
    const forbiddenRes = await api(
      'GET',
      `/api/devices/${laptopDeviceId}/account-mappings`,
      { Authorization: `Bearer ${otherParentToken}` }
    );
    assert.strictEqual(forbiddenRes.status, 403);
  });

  it('7. Shared laptop appears in getDevicesForChild for both Alice and Bob', async () => {
    const aliceDevices = await deviceService.getDevicesForChild(childAliceId);
    assert.strictEqual(aliceDevices.length, 1);
    assert.strictEqual(aliceDevices[0].id, laptopDeviceId);
    assert.strictEqual(aliceDevices[0].windowsAccountName, 'AliceWin');

    const bobDevices = await deviceService.getDevicesForChild(childBobId);
    assert.strictEqual(bobDevices.length, 1);
    assert.strictEqual(bobDevices[0].id, laptopDeviceId);
    assert.strictEqual(bobDevices[0].windowsAccountName, 'BobWin');

    const eveDevices = await deviceService.getDevicesForChild(otherChildEveId);
    assert.strictEqual(eveDevices.length, 0);
  });

  it('8. Device details and family devices reflect configured account mappings', async () => {
    const devRes = await api('GET', `/api/devices/${laptopDeviceId}`, { Authorization: `Bearer ${parentToken}` });
    assert.strictEqual(devRes.status, 200);
    assert.strictEqual(devRes.data.device.healthState, 'PROTECTED');
    assert.strictEqual(devRes.data.device.accountMappings.length, 3);

    const familyDevices = await deviceService.getDevicesForParent(parentUserId, familyId);
    assert.strictEqual(familyDevices.length, 1);
    assert.strictEqual(familyDevices[0].id, laptopDeviceId);
    assert.strictEqual(familyDevices[0].healthState, 'PROTECTED');
    assert.strictEqual(familyDevices[0].accountMappings?.length, 3);
  });

  it('9. Heartbeat persists activeChildId only when matching a valid mapping', async () => {
    // Valid heartbeat for Alice
    const validHbRes = await api(
      'POST',
      '/api/devices/heartbeat',
      { 'x-device-token': laptopDeviceToken },
      {
        deviceId: laptopDeviceId,
        mappedAccountName: 'AliceWin',
        mappedAccountSid: 'S-1-5-21-111-222-333-1001',
        activeChildId: childAliceId,
        protectionStatus: 'MANAGED_CHILD',
        enforcementActive: true,
      }
    );
    assert.strictEqual(validHbRes.status, 200);

    const devAfterAlice = await prisma.device.findUnique({ where: { id: laptopDeviceId } });
    assert.strictEqual(devAfterAlice?.activeChildId, childAliceId);
    assert.strictEqual(devAfterAlice?.mappedAccountSid, 'S-1-5-21-111-222-333-1001');

    // Attempted spoofed heartbeat with Eve's childId (not in mappings)
    const spoofHbRes = await api(
      'POST',
      '/api/devices/heartbeat',
      { 'x-device-token': laptopDeviceToken },
      {
        deviceId: laptopDeviceId,
        mappedAccountName: 'Spoofed',
        mappedAccountSid: 'S-1-5-21-999-999-999-999',
        activeChildId: otherChildEveId,
        protectionStatus: 'MANAGED_CHILD',
        enforcementActive: true,
      }
    );
    assert.strictEqual(spoofHbRes.status, 200);

    const devAfterSpoof = await prisma.device.findUnique({ where: { id: laptopDeviceId } });
    // Should NOT have changed to Eve
    assert.strictEqual(devAfterSpoof?.activeChildId, childAliceId);
  });
});
