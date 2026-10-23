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
import {
  PAIRING_CODE_ALPHABET,
  normalizePairingCode,
  formatPairingCode,
} from '@safebrowse/shared';

describe('SafeBrowse Stage C.4.1: Pairing Code UX Consistency & Integration Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

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

  const testPassword = 'StrongPassword123!PairTest';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childId: string;

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

    // Setup Parent & Child
    parentEmail = `parent.pairing.${nanoid().toLowerCase()}@example.test`;
    const regRes = await authService.register(parentEmail, testPassword, 'Pairing Parent');
    parentUserId = regRes.user.id;
    const actToken = getActivationToken(parentEmail);
    await authService.activateAccount(actToken);
    const loginRes = await authService.login(parentEmail, testPassword);
    parentToken = loginRes.token!;

    const fam = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = fam.id;

    const childRes = await childService.createChild(parentUserId, 'Manjari', 10, undefined, familyId);
    childId = childRes.child.id;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('1. Backend generates canonical 8-character code with ambiguity-safe alphabet', async () => {
    const pairing = await deviceService.generatePairingCode(parentUserId, childId);

    // Exact length = 8
    assert.strictEqual(pairing.code.length, 8);

    // Ambiguity-safe regex: 8 uppercase characters from 2-9, A-Z excluding 0, O, 1, I
    assert.match(pairing.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);

    // Verify absence of visually ambiguous characters
    assert.ok(!pairing.code.includes('0'), 'Code must not contain digit 0');
    assert.ok(!pairing.code.includes('O'), 'Code must not contain uppercase O');
    assert.ok(!pairing.code.includes('1'), 'Code must not contain digit 1');
    assert.ok(!pairing.code.includes('I'), 'Code must not contain uppercase I');

    // Display formatting helper produces 4-4 hyphenated string
    const formatted = formatPairingCode(pairing.code);
    assert.strictEqual(formatted, `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`);
    assert.strictEqual(normalizePairingCode(formatted), pairing.code);
  });

  it('2. Mandatory End-to-End Integration: generate code -> claim -> device created -> code consumed -> second claim fails', async () => {
    // 1. Backend generates pairing code
    const pairRes = await api('POST', '/api/devices/pairing-code', { Authorization: `Bearer ${parentToken}` }, { childId });
    assert.strictEqual(pairRes.status, 200);
    const generatedCode = pairRes.data.code;
    assert.strictEqual(generatedCode.length, 8);

    // Verify stored in DB
    const dbRecordBefore = await prisma.pairingCode.findUnique({
      where: { code: generatedCode },
    });
    assert.ok(dbRecordBefore, 'Pairing code must exist in DB before claim');

    // 2. Exact generated code passed to claim endpoint
    const claimRes = await api('POST', '/api/devices/claim', {}, {
      code: generatedCode,
      deviceName: 'Family Living Room Laptop',
      platform: 'windows',
      agentVersion: '1.0.4-validation',
    });

    // 3. Claim succeeds
    assert.strictEqual(claimRes.status, 200);
    assert.ok(claimRes.data.device);
    const deviceId = claimRes.data.device.id;
    assert.ok(deviceId.startsWith('dev-'));
    assert.ok(claimRes.data.device.deviceToken.startsWith('dtk_'));
    assert.strictEqual(claimRes.data.device.childId, childId);

    // 4. Device created in DB
    const createdDevice = await prisma.device.findUnique({
      where: { id: deviceId },
    });
    assert.ok(createdDevice, 'Device record must exist in DB');
    assert.strictEqual(createdDevice.name, 'Family Living Room Laptop');
    assert.strictEqual(createdDevice.platform, 'windows');

    // 5. Code consumed atomically
    const dbRecordAfter = await prisma.pairingCode.findUnique({
      where: { code: generatedCode },
    });
    assert.strictEqual(dbRecordAfter, null, 'Pairing code must be consumed and deleted from DB');

    // 6. Second claim fails (replay attack prevented)
    const replayRes = await api('POST', '/api/devices/claim', {}, {
      code: generatedCode,
      deviceName: 'Attacker Machine',
      platform: 'windows',
    });
    assert.strictEqual(replayRes.status, 400);
    assert.match(replayRes.data.error, /Invalid or expired pairing code/i);
  });

  it('3. Normalization: Canonical uppercase K8X9M2W7 claims successfully', async () => {
    const pair = await deviceService.generatePairingCode(parentUserId, childId);
    const code = pair.code;

    const res = await api('POST', '/api/devices/claim', {}, {
      code: code,
      deviceName: 'Laptop Test Canonical',
      platform: 'windows',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.device.id);

    // Cleaned up
    const remaining = await prisma.pairingCode.findUnique({ where: { code } });
    assert.strictEqual(remaining, null);
  });

  it('4. Normalization: Hyphenated display format K8X9-M2W7 claims successfully', async () => {
    const pair = await deviceService.generatePairingCode(parentUserId, childId);
    const code = pair.code;
    const hyphenated = `${code.slice(0, 4)}-${code.slice(4)}`;

    const res = await api('POST', '/api/devices/claim', {}, {
      code: hyphenated,
      deviceName: 'Laptop Test Hyphenated',
      platform: 'windows',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.device.id);

    const remaining = await prisma.pairingCode.findUnique({ where: { code } });
    assert.strictEqual(remaining, null);
  });

  it('5. Normalization: Legacy prefix SB-K8X9-M2W7 claims successfully', async () => {
    const pair = await deviceService.generatePairingCode(parentUserId, childId);
    const code = pair.code;
    const legacy = `SB-${code.slice(0, 4)}-${code.slice(4)}`;

    const res = await api('POST', '/api/devices/claim', {}, {
      code: legacy,
      deviceName: 'Laptop Test Legacy SB',
      platform: 'windows',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.device.id);

    const remaining = await prisma.pairingCode.findUnique({ where: { code } });
    assert.strictEqual(remaining, null);
  });

  it('6. Normalization: Lowercase equivalent and spaces resolve to same active code', async () => {
    const pair = await deviceService.generatePairingCode(parentUserId, childId);
    const code = pair.code;
    const messyInput = `  sb-${code.slice(0, 4).toLowerCase()} - ${code.slice(4).toLowerCase()}  `;

    const res = await api('POST', '/api/devices/claim', {}, {
      code: messyInput,
      deviceName: 'Laptop Test Messy Lowercase',
      platform: 'windows',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.device.id);

    const remaining = await prisma.pairingCode.findUnique({ where: { code } });
    assert.strictEqual(remaining, null);
  });

  it('7. Backward compatibility: Pre-existing SB-XXXX-XXXX record in DB claims via canonical input', async () => {
    const rawA = nanoid(4).toUpperCase().replace(/[^2-9A-Z]/g, 'X');
    const rawB = nanoid(4).toUpperCase().replace(/[^2-9A-Z]/g, 'Y');
    const legacyDbCode = `SB-${rawA}-${rawB}`;
    await prisma.pairingCode.create({
      data: {
        id: `pair-leg-${nanoid(8)}`,
        code: legacyDbCode,
        childId,
        createdByParentId: parentUserId,
        familyId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    // Parent enters clean code without SB prefix
    const res = await api('POST', '/api/devices/claim', {}, {
      code: `${rawA}-${rawB}`,
      deviceName: 'Laptop Legacy Record Test',
      platform: 'windows',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.device.id);

    const remaining = await prisma.pairingCode.findUnique({ where: { code: legacyDbCode } });
    assert.strictEqual(remaining, null);
  });

  it('8. Expired codes are rejected and purged from database', async () => {
    const expiredCode = `EX${nanoid(6).toUpperCase().replace(/[^2-9A-Z]/g, '9')}`;
    await prisma.pairingCode.create({
      data: {
        id: `pair-exp-${nanoid(8)}`,
        code: expiredCode,
        childId,
        createdByParentId: parentUserId,
        familyId,
        expiresAt: new Date(Date.now() - 60 * 1000), // 1 minute in the past
      },
    });

    const res = await api('POST', '/api/devices/claim', {}, {
      code: expiredCode,
      deviceName: 'Laptop Expired Test',
      platform: 'windows',
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /expired/i);

    // Code must be deleted from DB upon expired claim attempt
    const purged = await prisma.pairingCode.findUnique({ where: { code: expiredCode } });
    assert.strictEqual(purged, null);
  });

  it('9. Non-existent and malformed codes fail safely', async () => {
    const res1 = await api('POST', '/api/devices/claim', {}, {
      code: 'NONEXIST',
      deviceName: 'Laptop Fake Code',
      platform: 'windows',
    });
    assert.strictEqual(res1.status, 400);
    assert.match(res1.data.error, /Invalid or expired pairing code/i);

    const res2 = await api('POST', '/api/devices/claim', {}, {
      code: '',
      deviceName: 'Laptop Empty Code',
      platform: 'windows',
    });
    assert.strictEqual(res2.status, 400);
  });
});
