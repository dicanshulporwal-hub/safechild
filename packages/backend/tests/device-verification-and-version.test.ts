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

describe('SafeBrowse Stage C.4.2 — Device Verification, Protocol Version Gate & Lifecycle Suite', () => {
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

  const testPassword = 'StrongPassword123!VerificationSuite';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childAliceId: string;
  let otherParentToken: string;
  let otherFamilyId: string;

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

    // 1. Setup primary family
    parentEmail = `parent.verify.${nanoid().toLowerCase()}@example.test`;
    const regRes = await authService.register(parentEmail, testPassword, 'Primary Verifier');
    parentUserId = regRes.user.id;
    const actToken = getActivationToken(parentEmail);
    await authService.activateAccount(actToken);
    const loginRes = await authService.login(parentEmail, testPassword);
    parentToken = loginRes.token!;

    const fam = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = fam.id;

    const aliceRes = await childService.createChild(parentUserId, 'Alice', 10, undefined, familyId);
    childAliceId = aliceRes.child.id;

    // 2. Setup secondary family
    const otherEmail = `parent.other.${nanoid().toLowerCase()}@example.test`;
    const regOther = await authService.register(otherEmail, testPassword, 'Secondary Verifier');
    const actTokenOther = getActivationToken(otherEmail);
    await authService.activateAccount(actTokenOther);
    const loginOther = await authService.login(otherEmail, testPassword);
    otherParentToken = loginOther.token!;

    const otherFam = await familyService.getOrCreateUserFamily(regOther.user.id);
    otherFamilyId = otherFam.id;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. GET /api/version exposes public metadata, protocol 3 and schema 20261023120000 without auth', async () => {
    const res = await api('GET', '/api/version');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.application, 'SafeBrowse');
    assert.strictEqual(res.data.windowsProtocolVersion, 3);
    assert.strictEqual(res.data.schemaVersion, '20261023120000');
    assert.strictEqual(res.data.backendVersion, '1.0.4-validation');
    assert.ok(typeof res.data.buildCommit === 'string' && res.data.buildCommit.length > 0);
  });

  it('2. GET /api/health returns healthy without authentication', async () => {
    const res = await api('GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'healthy');
    assert.ok(res.data.timestamp);
  });

  it('3. POST /api/devices/verify returns NOT_FOUND for non-existent device', async () => {
    const res = await api('POST', '/api/devices/verify', {}, {
      deviceId: 'dev_non_existent_9999',
      deviceToken: 'dummy_token',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'NOT_FOUND');
    assert.strictEqual(res.data.valid, false);
  });

  it('4. POST /api/devices/verify returns AUTH_FAILED for invalid device token', async () => {
    // Generate code and claim valid device
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    assert.strictEqual(codeRes.status, 200);

    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: codeRes.data.code,
      deviceName: 'Alice-Laptop-Verify',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
      windowsProtocolVersion: 3,
    });
    assert.strictEqual(claimRes.status, 200);
    const { device } = claimRes.data;

    const res = await api('POST', '/api/devices/verify', {}, {
      deviceId: device.id,
      deviceToken: 'wrong_secret_token_123',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'AUTH_FAILED');
    assert.strictEqual(res.data.valid, false);
  });

  it('5. POST /api/devices/verify returns ACCOUNT_SETUP_REQUIRED for new Windows device before mappings', async () => {
    // Generate code and claim valid device
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    assert.strictEqual(codeRes.status, 200);

    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: codeRes.data.code,
      deviceName: 'Alice-Laptop-Unconfigured',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
      windowsProtocolVersion: 3,
    });
    assert.strictEqual(claimRes.status, 200);
    const { device } = claimRes.data;

    const res = await api('POST', '/api/devices/verify', {}, {
      deviceId: device.id,
      deviceToken: device.deviceToken,
      familyId,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ACCOUNT_SETUP_REQUIRED');
    assert.strictEqual(res.data.valid, false);
  });

  it('6. POST /api/devices/verify returns FAMILY_MISMATCH when familyId does not match', async () => {
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: codeRes.data.code,
      deviceName: 'Alice-Laptop-Mismatch',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
      windowsProtocolVersion: 3,
    });
    const { device } = claimRes.data;

    const res = await api('POST', '/api/devices/verify', {}, {
      deviceId: device.id,
      deviceToken: device.deviceToken,
      familyId: otherFamilyId, // Mismatched family ID
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'FAMILY_MISMATCH');
    assert.strictEqual(res.data.valid, false);
  });

  it('7. Syncing mappings transitions device to ACTIVATING, then heartbeat promotes to PROTECTED / VALID', async () => {
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: codeRes.data.code,
      deviceName: 'Alice-Laptop-Full-Flow',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
      windowsProtocolVersion: 3,
    });
    const { device } = claimRes.data;

    // Configure account mappings
    const mapRes = await api(
      'PUT',
      `/api/devices/${device.id}/account-mappings`,
      { Authorization: `Bearer ${parentToken}` },
      {
        mappings: [
          {
            windowsSid: 'S-1-5-21-999-1001',
            windowsUsername: 'AzureAD\\AliceUser',
            childId: childAliceId,
            enabled: true,
          },
        ],
      }
    );
    assert.strictEqual(mapRes.status, 200);

    // Send heartbeat from agent
    const hbRes = await api(
      'POST',
      '/api/devices/heartbeat',
      {
        'x-device-id': device.id,
        'x-device-token': device.deviceToken,
      },
      {
        deviceId: device.id,
        deviceToken: device.deviceToken,
        agentVersion: '1.0.4-validation',
        enforcementActive: true,
        protectionStatus: 'PROTECTED',
      }
    );
    assert.strictEqual(hbRes.status, 200);

    // Now verification returns VALID
    const verifyRes = await api('POST', '/api/devices/verify', {}, {
      deviceId: device.id,
      deviceToken: device.deviceToken,
      familyId,
    });
    assert.strictEqual(verifyRes.status, 200);
    assert.strictEqual(verifyRes.data.status, 'VALID');
    assert.strictEqual(verifyRes.data.valid, true);

    // Verify parent device query returns same physical device with PROTECTED status
    const listRes = await api('GET', '/api/devices', { Authorization: `Bearer ${parentToken}` });
    assert.strictEqual(listRes.status, 200);
    const listed = listRes.data.find((d: any) => d.id === device.id);
    assert.ok(listed, 'Device should appear in parent device list');
    assert.strictEqual(listed.protectionStatus, 'PROTECTED');
    assert.strictEqual(listed.healthState, 'PROTECTED');
  });

  it('8. POST /api/devices/:id/unpair revokes credentials and blocks subsequent heartbeats', async () => {
    // Generate code and pair
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: codeRes.data.code,
      deviceName: 'Alice-Laptop-To-Unpair',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
      windowsProtocolVersion: 3,
    });
    const { device } = claimRes.data;

    // Unpair using device token
    const unpairRes = await api(
      'POST',
      `/api/devices/${device.id}/unpair`,
      {
        'x-device-id': device.id,
        'x-device-token': device.deviceToken,
      },
      {
        deviceId: device.id,
        deviceToken: device.deviceToken,
      }
    );
    assert.strictEqual(unpairRes.status, 200);
    assert.strictEqual(unpairRes.data.success, true);

    // Verification should now return REVOKED
    const verifyRes = await api('POST', '/api/devices/verify', {}, {
      deviceId: device.id,
      deviceToken: device.deviceToken,
    });
    assert.strictEqual(verifyRes.status, 200);
    assert.strictEqual(verifyRes.data.status, 'REVOKED');
    assert.strictEqual(verifyRes.data.valid, false);

    // Subsequent heartbeat must be rejected (403 Forbidden: credentials revoked)
    const hbRes = await api(
      'POST',
      '/api/devices/heartbeat',
      {
        'x-device-id': device.id,
        'x-device-token': device.deviceToken,
      },
      {
        deviceId: device.id,
        deviceToken: device.deviceToken,
      }
    );
    assert.strictEqual(hbRes.status, 403);
  });

  it('9. POST /api/devices/claim rejects obsolete Windows protocol versions (< 3)', async () => {
    // 9.1 Reject protocol version 1
    const codeRes1 = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    const resProto1 = await api('POST', '/api/devices/claim', {}, {
      code: codeRes1.data.code,
      deviceName: 'Obsolete-Win-1',
      platform: 'windows',
      windowsProtocolVersion: 1,
    });
    assert.strictEqual(resProto1.status, 400);
    assert.match(resProto1.data.error, /protocol version 3 or higher is required/i);

    // 9.2 Reject protocol version 2 (Stage C.4 client)
    const codeRes2 = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId }
    );
    const resProto2 = await api('POST', '/api/devices/claim', {}, {
      code: codeRes2.data.code,
      deviceName: 'Obsolete-Win-2',
      platform: 'windows',
      windowsProtocolVersion: 2,
    });
    assert.strictEqual(resProto2.status, 400);
    assert.match(resProto2.data.error, /protocol version 3 or higher is required/i);

    // 9.3 Reject Windows family pairing code when protocol version is missing
    const familyCodeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { platform: 'windows' }
    );
    const resMissingProto = await api('POST', '/api/devices/claim', {}, {
      code: familyCodeRes.data.code,
      deviceName: 'Obsolete-Win-Missing-Proto',
      platform: 'windows',
    });
    assert.strictEqual(resMissingProto.status, 400);
    assert.match(resMissingProto.data.error, /protocol version 3 or higher is required/i);
  });

  it('10. Test D: Android pairing remains completely unchanged and succeeds without protocol header', async () => {
    // Generate pairing code for Android child
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      { Authorization: `Bearer ${parentToken}` },
      { childId: childAliceId, platform: 'android' }
    );
    assert.strictEqual(codeRes.status, 200);

    // Standard Android client payload (no windowsProtocolVersion)
    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: codeRes.data.code,
      deviceName: "Alice's Android Phone",
      platform: 'android',
      agentVersion: '1.0.4-validation',
    });

    assert.strictEqual(claimRes.status, 200);
    assert.ok(claimRes.data.device);
    assert.strictEqual(claimRes.data.device.platform, 'android');
    assert.strictEqual(claimRes.data.device.childId, childAliceId);
    assert.strictEqual(claimRes.data.device.protectionStatus, 'ACTIVE');
    assert.ok(claimRes.data.policy);
  });
});
