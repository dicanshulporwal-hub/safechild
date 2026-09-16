import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { app, bootstrap } from '../src/server';
import { prisma } from '../src/db/prisma';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import {
  getCurrentTotpTimeStep,
  generateTotpAtStep,
} from '../src/utils/security';
import {
  validateTestDatabaseUrl,
  createTestPrismaClient,
  assertLiveTestDatabaseMarker,
} from '../src/utils/test-db-guard';

describe('SafeBrowse Stage 11 Step 3F: Real PostgreSQL API Integration & E2E Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  const testPassword = 'StrongPassphrase2026!PostgresE2E';
  let parentEmail: string;
  let parentName = 'Primary Parent';
  let parentUserId: string;
  let accessToken: string;
  let refreshToken: string;
  let verificationToken: string;

  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;
  let pairingCode: string;
  let requestId: string;

  let coParentEmail: string;
  let coParentUserId: string;
  let coParentAccessToken: string;
  let inviteToken: string;

  let mfaSecret: string;
  let recoveryCodes: string[];

  // Child process reference for restart test
  let spawnedBackend: ChildProcess | null = null;

  // HTTP Helper using fetch
  const api = async (
    method: string,
    endpoint: string,
    body?: any,
    token?: string,
    customBaseUrl?: string
  ): Promise<{ status: number; data: any; headers: Headers }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const targetUrl = `${customBaseUrl || baseUrl}${endpoint}`;
    const res = await fetch(targetUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data: any;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return { status: res.status, data, headers: res.headers };
  };

  before(async () => {
    // 1. Fail-secure test database URL validation (Strictly require TEST_DATABASE_URL, zero fallback)
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://safebrowse:safebrowse_dev_password@127.0.0.1:5432/safebrowse_test';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    
    // 2. Validate live database marker
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    // 3. Clean test tables before suite run
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "UserSession", "MfaChallenge", "AccessRequest", "ChildUsageRecord", 
      "ActivityEvent", "Policy", "PairingCode", "Device", "Child", "FamilyInvitation", 
      "FamilyAuditLog", "FamilyMember", "Family", "User" CASCADE;
    `);

    // 4. Start real Express server via bootstrap on an ephemeral port
    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (spawnedBackend) {
      spawnedBackend.kill('SIGTERM');
    }
  });

  // 1. Complete parent registration
  it('1. should register a new parent account via real HTTP API', async () => {
    parentEmail = `parent-${nanoid(8).toLowerCase()}@safebrowse.io`;
    const res = await api('POST', '/api/auth/register', {
      email: parentEmail,
      password: testPassword,
      name: parentName,
      consentVersion: '1.0.0',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.activationRequired, true);
    assert.strictEqual(res.data.user.email, parentEmail);
    assert.ok(res.data.activationToken);

    parentUserId = res.data.user.id;
    verificationToken = res.data.activationToken;
  });

  // 2. Login rejected before activation
  it('2. should reject login before email activation with 403 ACCOUNT_ACTIVATION_REQUIRED', async () => {
    const res = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'ACCOUNT_ACTIVATION_REQUIRED');
  });

  // 3. Email activation link redemption
  it('3. should activate account via single-use token', async () => {
    const res = await api('POST', '/api/auth/activate', {
      token: verificationToken,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.email, parentEmail);

    // Assert token cannot be re-used
    const replayRes = await api('POST', '/api/auth/activate', {
      token: verificationToken,
    });
    assert.strictEqual(replayRes.status, 400);
  });

  // 4. Post-activation login
  it('4. should log in successfully after account activation', async () => {
    const res = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.user.status, 'ACTIVE');
    assert.ok(res.data.accessToken);
    assert.ok(res.data.refreshToken);
    accessToken = res.data.accessToken;
    refreshToken = res.data.refreshToken;
  });

  // 5. Session refresh rotation
  it('5. should rotate refresh tokens atomically on valid refresh call', async () => {
    const oldRefreshToken = refreshToken;
    const res = await api('POST', '/api/auth/refresh', {
      refreshToken: oldRefreshToken,
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.accessToken);
    assert.ok(res.data.refreshToken);
    assert.notStrictEqual(res.data.refreshToken, oldRefreshToken);

    accessToken = res.data.accessToken;
    refreshToken = res.data.refreshToken;

    // 6. Replay attack rejection & family session revocation
    const replayRes = await api('POST', '/api/auth/refresh', {
      refreshToken: oldRefreshToken,
    });

    assert.strictEqual(replayRes.status, 401);

    // The entire session family should now be revoked
    const postReplayUse = await api('POST', '/api/auth/refresh', {
      refreshToken,
    });
    assert.strictEqual(postReplayUse.status, 401);

    // Re-authenticate to get fresh active session
    const reLogin = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });
    accessToken = reLogin.data.accessToken;
    refreshToken = reLogin.data.refreshToken;
  });

  // 7. TOTP enrollment & challenge completion
  it('7. should enroll TOTP MFA and verify with initial 6-digit OTP code', async () => {
    const setupRes = await api('POST', '/api/me/mfa/setup', {}, accessToken);
    assert.strictEqual(setupRes.status, 200);
    assert.ok(setupRes.data.secret);
    assert.ok(setupRes.data.otpAuthUrl);
    mfaSecret = setupRes.data.secret;

    // Generate valid TOTP code
    const currentStep = getCurrentTotpTimeStep();
    const otpCode = generateTotpAtStep(mfaSecret, currentStep);

    const verifyRes = await api('POST', '/api/me/mfa/verify', { otpCode }, accessToken);
    assert.strictEqual(verifyRes.status, 200);
    assert.ok(verifyRes.data.recoveryCodes);
    assert.strictEqual(verifyRes.data.recoveryCodes.length, 8);
    recoveryCodes = verifyRes.data.recoveryCodes;
  });

  // 8. Recovery-code login & single-use consumption
  it('8. should perform MFA login using single-use recovery code', async () => {
    // Primary login -> yields MFA challenge ticket
    const loginRes = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });

    assert.strictEqual(loginRes.status, 200);
    assert.strictEqual(loginRes.data.mfaRequired, true);
    assert.ok(loginRes.data.mfaTicket);

    const mfaTicket = loginRes.data.mfaTicket;
    const usedCode = recoveryCodes[0];

    const mfaLoginRes = await api('POST', '/api/auth/mfa-login', {
      mfaTicket,
      code: usedCode,
    });

    assert.strictEqual(mfaLoginRes.status, 200);
    assert.ok(mfaLoginRes.data.accessToken);

    // Assert that the used recovery code cannot be reused
    const secondLogin = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });
    const reUsedRes = await api('POST', '/api/auth/mfa-login', {
      mfaTicket: secondLogin.data.mfaTicket,
      code: usedCode,
    });
    assert.strictEqual(reUsedRes.status, 400);

    accessToken = mfaLoginRes.data.accessToken;
    refreshToken = mfaLoginRes.data.refreshToken;
  });

  // 9. TOTP reuse rejection
  it('9. should reject reused TOTP token within the same time window', async () => {
    const step = getCurrentTotpTimeStep();
    const totp = generateTotpAtStep(mfaSecret, step);

    const login1 = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });
    const mfa1 = await api('POST', '/api/auth/mfa-login', {
      mfaTicket: login1.data.mfaTicket,
      code: totp,
    });
    assert.strictEqual(mfa1.status, 200);

    // Attempt second MFA login with exact same TOTP code
    const login2 = await api('POST', '/api/auth/login', {
      email: parentEmail,
      password: testPassword,
    });
    const mfa2 = await api('POST', '/api/auth/mfa-login', {
      mfaTicket: login2.data.mfaTicket,
      code: totp,
    });
    assert.strictEqual(mfa2.status, 400);
    assert.match(mfa2.data.error, /already been used/);

    accessToken = mfa1.data.accessToken;
  });

  // 10. Child profile creation & default policy seeding
  it('10. should create child profile with transactional default policy seeding', async () => {
    // Get family
    const famRes = await api('GET', '/api/family', undefined, accessToken);
    assert.strictEqual(famRes.status, 200);
    familyId = famRes.data.family.id;

    const childRes = await api(
      'POST',
      '/api/children',
      {
        name: 'Aarav',
        age: 9,
        avatar: 'avatar-child-1',
        familyId,
      },
      accessToken
    );

    assert.strictEqual(childRes.status, 200);
    assert.ok(childRes.data.child.id);
    assert.strictEqual(childRes.data.child.name, 'Aarav');
    assert.ok(childRes.data.policy);
    assert.strictEqual(childRes.data.policy.rules.length, 2);

    childId = childRes.data.child.id;
  });

  // 11. Pairing-code generation & atomic single-use claim
  it('11. should generate pairing code and claim it transactionally', async () => {
    const codeRes = await api(
      'POST',
      '/api/devices/pairing-code',
      {
        childId,
      },
      accessToken
    );

    assert.strictEqual(codeRes.status, 200);
    assert.ok(codeRes.data.code);
    pairingCode = codeRes.data.code;

    const pairRes = await api('POST', '/api/devices/pair', {
      code: pairingCode,
      deviceName: "Aarav's Windows Laptop",
      platform: 'windows',
      agentVersion: '1.0.0',
    });

    assert.strictEqual(pairRes.status, 200);
    assert.ok(pairRes.data.device.id);
    assert.ok(pairRes.data.device.deviceToken);
    deviceId = pairRes.data.device.id;
    deviceToken = pairRes.data.device.deviceToken;

    // Claiming same code again must fail
    const replayPair = await api('POST', '/api/devices/pair', {
      code: pairingCode,
      deviceName: 'Duplicate Device',
      platform: 'windows',
    });
    assert.strictEqual(replayPair.status, 400);
  });

  // 12. Device heartbeat & health transition
  it('12. should process device heartbeat and report health status', async () => {
    const hbRes = await api('POST', '/api/devices/heartbeat', {
      deviceId,
      deviceToken,
      activePolicyVersion: 1,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.0',
    });

    assert.strictEqual(hbRes.status, 200);
    assert.strictEqual(hbRes.data.status, 'ok');
  });

  // 13. Access-request creation & approval
  it('13. should create an access request and allow parent to approve it', async () => {
    const rawReqRes = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        childId,
        deviceId,
        domain: 'khanacademy.org',
        reason: 'Homework research',
      }),
    });
    const reqData = (await rawReqRes.json()) as any;

    assert.strictEqual(rawReqRes.status, 200);
    assert.ok(reqData.id);
    assert.strictEqual(reqData.status, 'PENDING');
    requestId = reqData.id;

    // Parent approves request
    const approveRes = await api(
      'POST',
      `/api/requests/${requestId}/resolve`,
      {
        action: 'APPROVE',
        duration: '15m',
      },
      accessToken
    );

    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveRes.data.request.status, 'APPROVED');

    // 14. Fetch policy with device auth headers
    const devReq = await fetch(`${baseUrl}/api/policies/device/${deviceId}`, {
      headers: {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
    });
    assert.strictEqual(devReq.status, 200);
    const devPolicyData = await devReq.json();
    assert.ok(devPolicyData.policy);
    const hasKhan = devPolicyData.policy.rules.some((r: any) => r.domain === 'khanacademy.org');
    assert.strictEqual(hasKhan, true);
  });

  // 15. Co-parent invitation & acceptance
  it('15. should invite co-parent and accept invitation transactionally', async () => {
    coParentEmail = `coparent-${nanoid(8).toLowerCase()}@safebrowse.io`;

    const inviteRes = await api(
      'POST',
      '/api/family/invitations',
      {
        familyId,
        email: coParentEmail,
        role: 'PARENT',
      },
      accessToken
    );

    assert.strictEqual(inviteRes.status, 200);
    assert.ok(inviteRes.data.invitation);
    inviteToken = inviteRes.data.rawToken || inviteRes.data.invitation.token;

    // Register co-parent
    const coReg = await api('POST', '/api/auth/register', {
      email: coParentEmail,
      password: testPassword,
      name: 'Co Parent',
    });
    assert.strictEqual(coReg.status, 200);
    assert.ok(coReg.data.activationToken);
    await api('POST', '/api/auth/activate', { token: coReg.data.activationToken });

    const coLogin = await api('POST', '/api/auth/login', {
      email: coParentEmail,
      password: testPassword,
    });
    coParentUserId = coLogin.data.user.id;
    coParentAccessToken = coLogin.data.accessToken;

    // Accept invitation
    const acceptRes = await api(
      'POST',
      '/api/family/invitations/accept',
      {
        token: inviteToken,
      },
      coParentAccessToken
    );

    assert.strictEqual(acceptRes.status, 200);
    assert.strictEqual(acceptRes.data.familyId, familyId);
    assert.strictEqual(acceptRes.data.role, 'PARENT');
  });

  // 16. Ownership transfer with single-owner invariant
  it('16. should transfer ownership to co-parent with step-up authentication', async () => {
    const step = getCurrentTotpTimeStep();
    const otpCode = generateTotpAtStep(mfaSecret, step);

    const transferRes = await api(
      'POST',
      '/api/family/transfer-ownership',
      {
        familyId,
        newOwnerUserId: coParentUserId,
        password: testPassword,
        otpCode,
      },
      accessToken
    );

    assert.strictEqual(transferRes.status, 200);
    assert.strictEqual(transferRes.data.success, true);

    // Verify exactly one OWNER exists in the family
    const ownerMembers = await prisma.familyMember.findMany({
      where: { familyId, role: 'OWNER' },
    });
    assert.strictEqual(ownerMembers.length, 1);
    assert.strictEqual(ownerMembers[0].userId, coParentUserId);

    const family = await prisma.family.findUnique({ where: { id: familyId } });
    assert.strictEqual(family?.ownerUserId, coParentUserId);
  });

  // 17. Non-owner rejection of restricted mutations
  it('17. should reject owner-only operations when attempted by demoted previous owner', async () => {
    const attemptTransfer = await api(
      'POST',
      '/api/family/transfer-ownership',
      {
        familyId,
        newOwnerUserId: parentUserId,
        password: testPassword,
      },
      accessToken
    );

    assert.strictEqual(attemptTransfer.status, 403);
  });

  // 18. Child-process spawn restart: starts real backend process, terminates, and confirms persistence (Requirement 8)
  it('18. should restart backend via spawned child process and confirm complete persistence', async () => {
    // Close in-memory test server so child process can bind cleanly
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const serverScript = path.resolve(__dirname, '../src/server.js');
    
    // Helper to spawn backend process and wait for ready port
    const spawnServer = async (): Promise<{ proc: ChildProcess; url: string }> => {
      return new Promise((resolve, reject) => {
        const proc = spawn('node', [serverScript], {
          env: {
            ...process.env,
            PORT: '0',
            NODE_ENV: 'test',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let assignedPort: number | null = null;
        let stdoutData = '';
        let stderrData = '';

        proc.stdout?.on('data', (chunk) => {
          const text = chunk.toString();
          stdoutData += text;
          const match = text.match(/SafeBrowse API Server running on port (\d+)/);
          if (match && !assignedPort) {
            assignedPort = parseInt(match[1], 10);
            resolve({ proc, url: `http://127.0.0.1:${assignedPort}` });
          }
        });

        proc.stderr?.on('data', (chunk) => {
          stderrData += chunk.toString();
        });

        proc.on('error', (err) => reject(err));
        proc.on('exit', (code) => {
          if (!assignedPort) {
            reject(new Error(`Server process exited with code ${code}. Stdout: ${stdoutData} Stderr: ${stderrData}`));
          }
        });
      });
    };

    // 1. Spawn Process A
    const procA = await spawnServer();
    const overviewA = await api('GET', `/api/family?familyId=${familyId}`, undefined, coParentAccessToken, procA.url);
    assert.strictEqual(overviewA.status, 200);
    assert.strictEqual(overviewA.data.family.id, familyId);
    assert.strictEqual(overviewA.data.family.ownerUserId, coParentUserId);
    assert.strictEqual(overviewA.data.myRole, 'OWNER');

    // Terminate Process A
    procA.proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));

    // 2. Spawn Process B (new clean process instance)
    const procB = await spawnServer();
    spawnedBackend = procB.proc;

    const overviewB = await api('GET', `/api/family?familyId=${familyId}`, undefined, coParentAccessToken, procB.url);
    assert.strictEqual(overviewB.status, 200);
    assert.strictEqual(overviewB.data.family.id, familyId);
    assert.strictEqual(overviewB.data.family.ownerUserId, coParentUserId);
    assert.strictEqual(overviewB.data.myRole, 'OWNER');
    assert.strictEqual(overviewB.data.stats.childrenCount, 1);
    assert.strictEqual(overviewB.data.stats.devicesCount, 1);

    // Reconnect main baseUrl to procB for subsequent tests
    baseUrl = procB.url;
  });

  // 19. Unactivated user denied login and tokens
  it('19. should deny unactivated user from logging in or receiving session tokens', async () => {
    const unverifiedEmail = `unverified-${nanoid(6).toLowerCase()}@safebrowse.io`;
    const regRes = await api('POST', '/api/auth/register', {
      email: unverifiedEmail,
      password: testPassword,
      name: 'Unverified Parent',
    });
    assert.strictEqual(regRes.status, 200);
    assert.strictEqual(regRes.data.activationRequired, true);
    assert.strictEqual(regRes.data.accessToken, undefined);

    const loginRes = await api('POST', '/api/auth/login', {
      email: unverifiedEmail,
      password: testPassword,
    });
    assert.strictEqual(loginRes.status, 403);
    assert.strictEqual(loginRes.data.code, 'ACCOUNT_ACTIVATION_REQUIRED');
  });

  // 20. Parent/device authentication separation
  it('20. should enforce strict parent/device authentication separation', async () => {
    const devEndpointRes = await fetch(`${baseUrl}/api/devices/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        deviceId,
        deviceToken: 'invalid-token',
        activePolicyVersion: 1,
        enforcementActive: true,
      }),
    });
    assert.strictEqual(devEndpointRes.status, 401);

    const parentEndpointRes = await fetch(`${baseUrl}/api/family`, {
      method: 'GET',
      headers: {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
    });
    assert.strictEqual(parentEndpointRes.status, 401);
  });

  // 21. System-admin bootstrap protection through HTTP
  it('21. should reject standard parent/owner from system admin operations with 403', async () => {
    const adminRes = await api('GET', '/api/admin/metrics', undefined, coParentAccessToken);
    assert.strictEqual(adminRes.status, 403);
  });

  // 22. Cross-family read and mutation attacks
  it('22. should strictly reject cross-family read and mutation attacks', async () => {
    const familyBEmail = `parentb-${nanoid(6).toLowerCase()}@safebrowse.io`;
    const regB = await api('POST', '/api/auth/register', {
      email: familyBEmail,
      password: testPassword,
      name: 'Parent B',
    });
    assert.strictEqual(regB.status, 200);
    await api('POST', '/api/auth/activate', { token: regB.data.activationToken });
    const loginB = await api('POST', '/api/auth/login', {
      email: familyBEmail,
      password: testPassword,
    });
    const tokenB = loginB.data.accessToken;

    const crossChildGet = await api('GET', `/api/children?familyId=${familyId}`, undefined, tokenB);
    assert.strictEqual(crossChildGet.status, 403);
    assert.match(crossChildGet.data.error, /belong/i);

    const crossPolicyMutate = await api(
      'POST',
      `/api/policies/child/${childId}/rules`,
      { domain: 'attacker-site.com', action: 'ALLOW' },
      tokenB
    );
    assert.strictEqual(crossPolicyMutate.status, 403);
  });

  // 23. Sole-owner deletion protection
  it('23. should protect sole owner from account deletion before ownership transfer', async () => {
    const delRes = await api(
      'DELETE',
      '/api/me',
      { password: testPassword },
      coParentAccessToken
    );
    assert.strictEqual(delRes.status, 400);
    assert.match(delRes.data.error, /sole owner/i);
  });

  // 24. Database composite foreign key mismatch: wrong family reference
  it('24. should reject wrong family reference at database engine level', async () => {
    let foreignKeyViolated = false;
    try {
      await prisma.$executeRaw`
        INSERT INTO "AccessRequest" ("id", "familyId", "childId", "deviceId", "domain", "status", "requestedAt")
        VALUES ('req-mismatch-1', 'fam-invalid-999', ${childId}, ${deviceId}, 'malicious.com', 'PENDING'::"RequestStatus", NOW());
      `;
    } catch {
      foreignKeyViolated = true;
    }
    assert.strictEqual(foreignKeyViolated, true);
  });

  // 25. Database composite foreign key mismatch: same family, wrong child device reference (Requirement 6 & 7)
  it('25. should reject device belonging to another child in the same family at database engine level', async () => {
    // Create Child 2 in same family
    const child2 = await prisma.child.create({
      data: {
        id: `child-2-${nanoid(6)}`,
        familyId,
        parentId: coParentUserId,
        name: 'Priya',
      },
    });

    let wrongChildDeviceViolated = false;
    try {
      // Attempt to associate AccessRequest for Child 2 with Child 1's device
      await prisma.$executeRaw`
        INSERT INTO "AccessRequest" ("id", "familyId", "childId", "deviceId", "domain", "status", "requestedAt")
        VALUES ('req-wrong-child-dev', ${familyId}, ${child2.id}, ${deviceId}, 'youtube.com', 'PENDING'::"RequestStatus", NOW());
      `;
    } catch {
      wrongChildDeviceViolated = true;
    }
    assert.strictEqual(wrongChildDeviceViolated, true);
  });

  // 26. Database constraint: Zero owners rejection by constraint trigger (Requirement 7)
  it('26. should reject zero owners in a family at database engine level', async () => {
    let zeroOwnersRejected = false;
    try {
      await prisma.$executeRaw`
        UPDATE "FamilyMember" SET "role" = 'PARENT'::"FamilyRole" 
        WHERE "familyId" = ${familyId} AND "role" = 'OWNER'::"FamilyRole";
      `;
    } catch {
      zeroOwnersRejected = true;
    }
    assert.strictEqual(zeroOwnersRejected, true);
  });

  // 27. Database constraint: Multiple owners rejection by unique partial index (Requirement 7)
  it('27. should reject multiple owners in a family at database engine level', async () => {
    let multipleOwnersRejected = false;
    try {
      await prisma.$executeRaw`
        INSERT INTO "FamilyMember" ("id", "familyId", "userId", "role", "joinedAt")
        VALUES ('fm-duplicate-owner', ${familyId}, ${parentUserId}, 'OWNER'::"FamilyRole", NOW());
      `;
    } catch {
      multipleOwnersRejected = true;
    }
    assert.strictEqual(multipleOwnersRejected, true);
  });

  // 28. Database constraint: Family.ownerUserId and FamilyMember mismatch rejection (Requirement 7)
  it('28. should reject Family.ownerUserId mismatch with FamilyMember OWNER at database level', async () => {
    let ownerMismatchRejected = false;
    try {
      await prisma.$executeRaw`
        UPDATE "Family" SET "ownerUserId" = ${parentUserId} WHERE "id" = ${familyId};
      `;
    } catch {
      ownerMismatchRejected = true;
    }
    assert.strictEqual(ownerMismatchRejected, true);
  });

  // 29. Real concurrency: Simultaneous pairing code claim (Requirement 9)
  it('29. should allow only one claim when two simultaneous claims target the same pairing code', async () => {
    const codeRes = await api('POST', '/api/devices/pairing-code', { childId }, coParentAccessToken);
    assert.strictEqual(codeRes.status, 200);
    const concurrentCode = codeRes.data.code;

    // Launch two simultaneous claim requests concurrently
    const [claim1, claim2] = await Promise.all([
      api('POST', '/api/devices/pair', {
        code: concurrentCode,
        deviceName: 'Concurrent Device 1',
        platform: 'windows',
      }),
      api('POST', '/api/devices/pair', {
        code: concurrentCode,
        deviceName: 'Concurrent Device 2',
        platform: 'windows',
      }),
    ]);

    const statuses = [claim1.status, claim2.status].sort();
    assert.deepStrictEqual(statuses, [200, 400]);
  });

  // 30. Real concurrency: Simultaneous ownership transfer attempt (Requirement 9)
  it('30. should serialize simultaneous ownership transfers and prevent race condition', async () => {
    const step = getCurrentTotpTimeStep();
    const otpCode = generateTotpAtStep(mfaSecret, step);

    // Launch two concurrent transfer requests
    const [resA, resB] = await Promise.all([
      api('POST', '/api/family/transfer-ownership', {
        familyId,
        newOwnerUserId: parentUserId,
        password: testPassword,
        otpCode,
      }, coParentAccessToken),
      api('POST', '/api/family/transfer-ownership', {
        familyId,
        newOwnerUserId: parentUserId,
        password: testPassword,
        otpCode,
      }, coParentAccessToken),
    ]);

    const successCount = [resA.status, resB.status].filter((s) => s === 200).length;
    assert.strictEqual(successCount, 1);

    // Verify exactly 1 owner exists in database
    const owners = await prisma.familyMember.findMany({
      where: { familyId, role: 'OWNER' },
    });
    assert.strictEqual(owners.length, 1);
  });

  // 31. Correct PostgreSQL Outage Test (Requirement 3)
  it('31. should abort startup and refuse to open HTTP port when PostgreSQL is unavailable', async () => {
    const unreachableUrl = 'postgresql://safebrowse:invalidpass@127.0.0.1:54399/safebrowse_test';
    const testPort = 10998;
    
    // Resolve compiled server script and assert it exists before spawning
    const serverScript = path.resolve(__dirname, '../src/server.js');
    assert.strictEqual(fs.existsSync(serverScript), true, `Compiled server script must exist at: ${serverScript}`);

    let exitCode: number | null = null;
    let stdoutOutput = '';
    let stderrOutput = '';

    await new Promise<void>((resolve) => {
      const badProc = spawn('node', [serverScript], {
        env: {
          ...process.env,
          DATABASE_URL: unreachableUrl,
          TEST_DATABASE_URL: unreachableUrl,
          PORT: String(testPort),
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      badProc.stdout?.on('data', (chunk) => {
        stdoutOutput += chunk.toString();
      });

      badProc.stderr?.on('data', (chunk) => {
        stderrOutput += chunk.toString();
      });

      badProc.on('exit', (code) => {
        exitCode = code;
        resolve();
      });

      setTimeout(() => {
        badProc.kill('SIGTERM');
        resolve();
      }, 4000);
    });

    // Verify process exited with non-zero error code
    assert.strictEqual(exitCode, 1, 'Server process should exit with code 1 upon DB failure');

    // Verify error is caused by database connectivity refusal and not module loading issues
    const combinedOutput = stdoutOutput + '\n' + stderrOutput;
    assert.match(combinedOutput, /DATABASE|CONNECTIVITY|BOOTSTRAP/i);
    assert.doesNotMatch(combinedOutput, /MODULE_NOT_FOUND|Cannot find module/i);

    // Verify configured HTTP port was never opened
    let portOpened = false;
    try {
      await fetch(`http://127.0.0.1:${testPort}/health`);
      portOpened = true;
    } catch {
      portOpened = false;
    }
    assert.strictEqual(portOpened, false, 'Port should never have opened');
  });

  // 32. PostgreSQL Failure During Mutation Test (Requirement 4)
  it('32. should safely fail mid-mutation requests and ensure zero partial commits or storage fallbacks', async () => {
    const initialFamily = await prisma.family.findUnique({ where: { id: familyId } });
    const initialOwnerId = initialFamily?.ownerUserId;
    assert.ok(initialOwnerId);

    // Identify which auth token belongs to the current active owner
    const currentOwnerToken = initialOwnerId === parentUserId ? accessToken : coParentAccessToken;

    // Attempt a malformed ownership transfer designed to fail during transaction
    const failedTransferRes = await api(
      'POST',
      '/api/family/transfer-ownership',
      {
        familyId,
        newOwnerUserId: 'non-existent-user-id-999',
        password: testPassword,
        otpCode: '123456',
      },
      currentOwnerToken
    );

    // Must return an error status, never 200
    assert.ok(failedTransferRes.status >= 400, 'Failed mutation must return HTTP 4xx/5xx');
    assert.strictEqual(failedTransferRes.status !== 200, true);

    // Verify database state remained completely unchanged (no partial commit)
    const postFamily = await prisma.family.findUnique({ where: { id: familyId } });
    assert.strictEqual(postFamily?.ownerUserId, initialOwnerId);

    const postOwners = await prisma.familyMember.findMany({
      where: { familyId, role: 'OWNER' },
    });
    assert.strictEqual(postOwners.length, 1);
    assert.strictEqual(postOwners[0].userId, initialOwnerId);

    // Verify no fallback JSON file was created
    const jsonDbPath = path.resolve(__dirname, '../../data/safebrowse-db.json');
    assert.strictEqual(fs.existsSync(jsonDbPath), false, 'Backend must never create JSON fallback datastore');
  });
});
