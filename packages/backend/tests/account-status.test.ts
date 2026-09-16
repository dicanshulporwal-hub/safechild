import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';
import { prisma } from '../src/db/prisma';
import { authService } from '../src/services/auth.service';
import { mailService } from '../src/services/mail.service';
import { profileService } from '../src/services/profile.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { rbacService } from '../src/services/rbac.service';
import { accountStatusService } from '../src/services/account-status.service';
import { generateCurrentTotp } from '../src/utils/security';
import { nanoid } from 'nanoid';

describe('SafeBrowse Stage 11 Step 4: User Account Enable/Disable Test Suite', () => {
  let testServer: http.Server;
  let baseUrl: string;

  let adminId: string;
  let adminToken: string;
  let secondAdminId: string;
  let secondAdminToken: string;

  let parentId: string;
  let parentEmail: string;
  let parentToken: string;
  let parentRefreshToken: string;
  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;

  let mfaParentId: string;
  let mfaParentEmail: string;
  let mfaSecret: string;

  const testPassword = 'SafeBrowse-Password-15Chars!';

  function getLatestActivationToken(email: string): string {
    const mail = mailService.getOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase().trim()).pop();
    if (!mail || !mail.token) {
      throw new Error(`No activation token found in outbox for ${email}`);
    }
    return mail.token;
  }

  const makeRequest = async (
    method: string,
    endpoint: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> => {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, baseUrl);
      const payload = body ? JSON.stringify(body) : undefined;

      const reqHeaders: http.OutgoingHttpHeaders = {
        ...headers,
      };

      if (payload) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(
        url,
        {
          method,
          headers: reqHeaders,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            let parsedBody: any;
            try {
              parsedBody = data ? JSON.parse(data) : {};
            } catch {
              parsedBody = data;
            }
            resolve({
              status: res.statusCode || 500,
              body: parsedBody,
              headers: res.headers,
            });
          });
        }
      );

      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  };

  before(async () => {
    testServer = http.createServer(app);
    await new Promise<void>((resolve) => {
      testServer.listen(0, '127.0.0.1', () => {
        const address = testServer.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // 1. Setup primary System Admin
    const adminEmail = `sysadmin-${nanoid(6)}@safebrowse.io`;
    const uAdmin = await authService.register(adminEmail, testPassword, 'Primary Admin');
    await authService.activateAccount(getLatestActivationToken(adminEmail));
    adminId = uAdmin.user.id;
    process.env.ENABLE_DEV_ADMIN_BOOTSTRAP = 'true';
    process.env.DEV_ADMIN_BOOTSTRAP_SECRET = 'test-secret-at-least-16-chars-long';
    await rbacService.bootstrapDevAdmin(adminId, 'test-secret-at-least-16-chars-long');
    const adminLog = await authService.login(adminEmail, testPassword);
    adminToken = adminLog.accessToken!;

    // 2. Setup secondary System Admin
    const admin2Email = `sysadmin-2-${nanoid(6)}@safebrowse.io`;
    const uAdmin2 = await authService.register(admin2Email, testPassword, 'Secondary Admin');
    await authService.activateAccount(getLatestActivationToken(admin2Email));
    secondAdminId = uAdmin2.user.id;
    await rbacService.bootstrapDevAdmin(secondAdminId, 'test-secret-at-least-16-chars-long');
    const admin2Log = await authService.login(admin2Email, testPassword);
    secondAdminToken = admin2Log.accessToken!;

    // 3. Setup Standard Parent with Family, Child, Policy, and Paired Device
    parentEmail = `parent-${nanoid(6)}@safebrowse.io`;
    const uParent = await authService.register(parentEmail, testPassword, 'Test Parent');
    await authService.activateAccount(getLatestActivationToken(parentEmail));
    parentId = uParent.user.id;
    const parentLog = await authService.login(parentEmail, testPassword);
    parentToken = parentLog.accessToken!;
    parentRefreshToken = parentLog.refreshToken!;

    const fam = await familyService.getOrCreateUserFamily(parentId);
    familyId = fam.id;

    const { child } = await childService.createChild(parentId, 'Protected Child', 9, undefined, familyId);
    childId = child.id;

    const pair = await deviceService.generatePairingCode(parentId, childId);
    const { device } = await deviceService.pairDevice(pair.code, 'Windows Agent Laptop', 'windows', '1.0.0');
    deviceId = device.id;
    deviceToken = device.deviceToken;

    // 4. Setup MFA-enabled Parent
    mfaParentEmail = `mfa-parent-${nanoid(6)}@safebrowse.io`;
    const uMfa = await authService.register(mfaParentEmail, testPassword, 'MFA Parent');
    await authService.activateAccount(getLatestActivationToken(mfaParentEmail));
    mfaParentId = uMfa.user.id;

    const setupMfa = await profileService.setupMfa(mfaParentId);
    mfaSecret = setupMfa.secret;
    const totpCode = generateCurrentTotp(mfaSecret);
    await profileService.verifyAndEnableMfa(mfaParentId, totpCode);
  });

  after(() => {
    if (testServer) {
      testServer.close();
    }
  });

  it('1. should set PENDING_ACTIVATION status by default for newly registered users and ACTIVE upon activation', async () => {
    const regEmail = `new-reg-${nanoid(6)}@safebrowse.io`;
    const newUser = await authService.register(regEmail, testPassword, 'New Reg');
    assert.strictEqual(newUser.user.status, 'PENDING_ACTIVATION');

    let dbUser = await prisma.user.findUnique({ where: { id: newUser.user.id } });
    assert.strictEqual(dbUser?.status, 'PENDING_ACTIVATION');

    await authService.activateAccount(getLatestActivationToken(regEmail));
    dbUser = await prisma.user.findUnique({ where: { id: newUser.user.id } });
    assert.strictEqual(dbUser?.status, 'ACTIVE');
  });

  it('2. should ensure pre-existing database users receive ACTIVE status via schema default', async () => {
    const dbUser = await prisma.user.findUnique({ where: { id: parentId } });
    assert.strictEqual(dbUser?.status, 'ACTIVE');
    assert.strictEqual(dbUser?.disabledAt, null);
    assert.strictEqual(dbUser?.disabledReason, null);
    assert.strictEqual(dbUser?.disabledByUserId, null);
  });

  it('4. should reject disabling without a non-empty reason (400)', async () => {
    const res = await makeRequest(
      'POST',
      `/api/admin/parents/${parentId}/disable`,
      { Authorization: `Bearer ${adminToken}` },
      { reason: '   ' }
    );
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /reason is required/i);
  });

  it('5. should reject non-admin attempting to disable a user (403)', async () => {
    const res = await makeRequest(
      'POST',
      `/api/admin/parents/${parentId}/disable`,
      { Authorization: `Bearer ${parentToken}` },
      { reason: 'Malicious disable attempt by normal user' }
    );
    assert.strictEqual(res.status, 403);
  });

  it('3. should allow Admin to disable a standard user', async () => {
    const res = await makeRequest(
      'POST',
      `/api/admin/parents/${parentId}/disable`,
      { Authorization: `Bearer ${adminToken}` },
      { reason: 'Security investigation - suspicious account activity' }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.user.status, 'DISABLED');
  });

  it('10. should immediately revoke existing web sessions upon disabling', async () => {
    const sessions = await prisma.userSession.findMany({
      where: { userId: parentId },
    });
    assert.ok(sessions.length > 0);
    for (const session of sessions) {
      assert.strictEqual(session.isRevoked, true);
    }
  });

  it('11. should increment user tokenVersion upon disabling', async () => {
    const dbUser = await prisma.user.findUnique({ where: { id: parentId } });
    assert.ok((dbUser?.tokenVersion || 0) >= 1);
  });

  it('12. should set disabledAt, disabledReason, and disabledByUserId upon disabling', async () => {
    const dbUser = await prisma.user.findUnique({ where: { id: parentId } });
    assert.ok(dbUser?.disabledAt instanceof Date);
    assert.strictEqual(dbUser?.disabledReason, 'Security investigation - suspicious account activity');
    assert.strictEqual(dbUser?.disabledByUserId, adminId);
  });

  it('13. should ensure disabling does not delete user record', async () => {
    const dbUser = await prisma.user.findUnique({ where: { id: parentId } });
    assert.ok(dbUser);
    assert.strictEqual(dbUser.id, parentId);
    assert.strictEqual(dbUser.email, parentEmail.toLowerCase());
  });

  it('14. should ensure disabling does not delete or alter family records', async () => {
    const fam = await prisma.family.findUnique({ where: { id: familyId } });
    assert.ok(fam);
    assert.strictEqual(fam.id, familyId);
  });

  it('15. should ensure disabling does not delete or alter child records', async () => {
    const ch = await prisma.child.findUnique({ where: { id: childId } });
    assert.ok(ch);
    assert.strictEqual(ch.id, childId);
    assert.strictEqual(ch.name, 'Protected Child');
  });

  it('16. should ensure disabling does not delete or alter policy records', async () => {
    const policy = await prisma.policy.findFirst({ where: { childId } });
    assert.ok(policy);
    assert.strictEqual(policy.childId, childId);
  });

  it('17. should ensure disabling does not delete or alter device records', async () => {
    const dev = await prisma.device.findUnique({ where: { id: deviceId } });
    assert.ok(dev);
    assert.strictEqual(dev.id, deviceId);
    assert.strictEqual(dev.childId, childId);
    assert.strictEqual(dev.isRevoked, false);
  });

  it('6. should reject disabled user login with HTTP 403 / ACCOUNT_DISABLED', async () => {
    const res = await makeRequest(
      'POST',
      '/api/auth/login',
      {},
      { email: parentEmail, password: testPassword }
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'ACCOUNT_DISABLED');
    assert.strictEqual(res.body.error, 'This account has been disabled. Contact the administrator.');
  });

  it('7. should reject disabled user MFA login with HTTP 403 / ACCOUNT_DISABLED', async () => {
    // 1. Initiate login for MFA user to get challenge ticket
    const loginRes = await makeRequest(
      'POST',
      '/api/auth/login',
      {},
      { email: mfaParentEmail, password: testPassword }
    );
    assert.strictEqual(loginRes.status, 200);
    assert.strictEqual(loginRes.body.mfaRequired, true);
    const mfaTicket = loginRes.body.mfaTicket;
    assert.ok(mfaTicket);

    // 2. Disable the MFA user
    await accountStatusService.disableUser(adminId, mfaParentId, 'MFA user disabled test');

    // 3. Attempt to submit MFA code for disabled user
    const currentCode = generateCurrentTotp(mfaSecret);
    const mfaRes = await makeRequest(
      'POST',
      '/api/auth/mfa-login',
      {},
      { mfaTicket, code: currentCode }
    );
    assert.strictEqual(mfaRes.status, 403);
    assert.strictEqual(mfaRes.body.code, 'ACCOUNT_DISABLED');
    assert.strictEqual(mfaRes.body.error, 'This account has been disabled. Contact the administrator.');
  });

  it('8. should reject disabled user authenticating with previously issued access token (403)', async () => {
    const res = await makeRequest(
      'GET',
      '/api/me',
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'ACCOUNT_DISABLED');
    assert.strictEqual(res.body.error, 'This account has been disabled. Contact the administrator.');
  });

  it('9. should reject disabled user refreshing session with previously issued refresh token (403)', async () => {
    const res = await makeRequest(
      'POST',
      '/api/auth/refresh',
      {},
      { refreshToken: parentRefreshToken }
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'ACCOUNT_DISABLED');
    assert.strictEqual(res.body.error, 'This account has been disabled. Contact the administrator.');
  });

  it('18. should ensure disabling parent does not impair child device policy sync or heartbeat', async () => {
    // 1. Device heartbeat succeeds
    const hbRes = await makeRequest(
      'POST',
      '/api/devices/heartbeat',
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      },
      { activePolicyVersion: 1, enforcementActive: true, platform: 'windows', agentVersion: '1.0.0', deviceId }
    );
    assert.strictEqual(hbRes.status, 200);
    assert.strictEqual(hbRes.body.status, 'ok');

    // 2. Device policy sync succeeds
    const polRes = await makeRequest(
      'GET',
      `/api/policies/device/${deviceId}`,
      {
        'x-device-id': deviceId,
        'x-device-token': deviceToken,
      }
    );
    assert.strictEqual(polRes.status, 200);
    assert.ok(polRes.body.policy !== undefined);
  });

  it('26. should reject non-admin attempting to enable a disabled user (403)', async () => {
    const tempEmail = `temp-u-${nanoid(6)}@safebrowse.io`;
    const tempUser = await authService.register(tempEmail, testPassword, 'Temp U');
    await authService.activateAccount(getLatestActivationToken(tempEmail));
    const tempLogin = await authService.login(tempEmail, testPassword);

    const res = await makeRequest(
      'POST',
      `/api/admin/parents/${parentId}/enable`,
      { Authorization: `Bearer ${tempLogin.accessToken}` }
    );
    assert.strictEqual(res.status, 403);
  });

  it('19. should allow Admin to re-enable a disabled user', async () => {
    const res = await makeRequest(
      'POST',
      `/api/admin/parents/${parentId}/enable`,
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.user.status, 'ACTIVE');
  });

  it('22. should clear disabledAt, disabledReason, and disabledByUserId upon re-enabling', async () => {
    const dbUser = await prisma.user.findUnique({ where: { id: parentId } });
    assert.strictEqual(dbUser?.status, 'ACTIVE');
    assert.strictEqual(dbUser?.disabledAt, null);
    assert.strictEqual(dbUser?.disabledReason, null);
    assert.strictEqual(dbUser?.disabledByUserId, null);
  });

  it('21. should ensure re-enabled user cannot use tokens from before disablement', async () => {
    // Old access token still invalid
    const tokenRes = await makeRequest(
      'GET',
      '/api/me',
      { Authorization: `Bearer ${parentToken}` }
    );
    assert.strictEqual(tokenRes.status, 401);

    // Old refresh token still invalid
    const refreshRes = await makeRequest(
      'POST',
      '/api/auth/refresh',
      {},
      { refreshToken: parentRefreshToken }
    );
    assert.strictEqual(refreshRes.status, 401);
  });

  it('20. should allow re-enabled user to log in successfully and receive new tokens', async () => {
    const loginRes = await makeRequest(
      'POST',
      '/api/auth/login',
      {},
      { email: parentEmail, password: testPassword }
    );
    assert.strictEqual(loginRes.status, 200);
    assert.ok(loginRes.body.accessToken);
    assert.ok(loginRes.body.refreshToken);
    assert.strictEqual(loginRes.body.user.status, 'ACTIVE');

    // New token works
    const profileRes = await makeRequest(
      'GET',
      '/api/me',
      { Authorization: `Bearer ${loginRes.body.accessToken}` }
    );
    assert.strictEqual(profileRes.status, 200);
    assert.strictEqual(profileRes.body.email, parentEmail.toLowerCase());
  });

  it('23. should reject System Admin disabling themselves (409)', async () => {
    const res = await makeRequest(
      'POST',
      `/api/admin/parents/${adminId}/disable`,
      { Authorization: `Bearer ${adminToken}` },
      { reason: 'Self-disable test' }
    );
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /cannot disable your own account/i);
  });

  it('24. should reject disabling the last active SYSTEM_ADMIN', async () => {
    // Disable all other active admins temporarily to ensure adminId is the sole active admin
    const otherAdmins = await prisma.user.findMany({
      where: {
        systemRole: 'SYSTEM_ADMIN',
        status: 'ACTIVE',
        id: { not: adminId },
      },
    });

    for (const other of otherAdmins) {
      await prisma.user.update({
        where: { id: other.id },
        data: { status: 'DISABLED' },
      });
    }

    // Now try to disable sole active admin using accountStatusService directly with a synthetic actor
    await assert.rejects(async () => {
      await accountStatusService.disableUser('synthetic-actor-id', adminId, 'Trying to disable sole active admin');
    }, /The last active SYSTEM_ADMIN cannot be disabled/i);

    // Restore other admins
    for (const other of otherAdmins) {
      await prisma.user.update({
        where: { id: other.id },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('25. should reject demoting the last active SYSTEM_ADMIN', async () => {
    // Disable all other active admins temporarily to ensure adminId is the sole active admin
    const otherAdmins = await prisma.user.findMany({
      where: {
        systemRole: 'SYSTEM_ADMIN',
        status: 'ACTIVE',
        id: { not: adminId },
      },
    });

    for (const other of otherAdmins) {
      await prisma.user.update({
        where: { id: other.id },
        data: { status: 'DISABLED' },
      });
    }

    // Attempt to demote primary admin to USER
    const demoteRes = await makeRequest(
      'POST',
      `/api/admin/parents/${adminId}/role`,
      { Authorization: `Bearer ${adminToken}` },
      { systemRole: 'USER' }
    );
    assert.strictEqual(demoteRes.status, 409);
    assert.match(demoteRes.body.error, /The last active SYSTEM_ADMIN cannot be demoted/i);

    // Restore other admins
    for (const other of otherAdmins) {
      await prisma.user.update({
        where: { id: other.id },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('27. should ensure Disable and Enable actions create audit log entries in SystemAuditLog', async () => {
    const auditRes = await makeRequest(
      'GET',
      '/api/admin/audit',
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.body.logs));

    const disableLog = auditRes.body.logs.find((l: any) => l.action === 'ADMIN_DISABLE_USER');
    const enableLog = auditRes.body.logs.find((l: any) => l.action === 'ADMIN_ENABLE_USER');

    assert.ok(disableLog, 'ADMIN_DISABLE_USER audit log entry must exist');
    assert.ok(enableLog, 'ADMIN_ENABLE_USER audit log entry must exist');
  });
});
