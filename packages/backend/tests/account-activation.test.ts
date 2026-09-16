import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';
import { prisma } from '../src/db/prisma';
import { authService } from '../src/services/auth.service';
import { mailService } from '../src/services/mail.service';
import { hashToken } from '../src/utils/security';
import { nanoid } from 'nanoid';

describe('SafeBrowse Account Activation Lifecycle & Security Hardening Test Suite', () => {
  let testServer: http.Server;
  let baseUrl: string;

  let adminId: string;
  let adminToken: string;

  function getLatestActivationToken(email: string): string {
    const normalized = email.toLowerCase().trim();
    const outbox = mailService.getOutbox();
    const mail = outbox.filter((m) => m.to.toLowerCase() === normalized).pop();
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

    // Create active admin user
    const adminEmail = `admin-${nanoid(6)}@safebrowse.io`;
    const regRes = await authService.register(adminEmail, 'Admin-Password-15Chars!', 'System Admin');
    adminId = regRes.user.id;

    // Activate and promote admin
    await prisma.user.update({
      where: { id: adminId },
      data: {
        status: 'ACTIVE',
        activatedAt: new Date(),
        systemRole: 'SYSTEM_ADMIN',
        emailVerified: true,
      },
    });

    const loginRes = await authService.login(adminEmail, 'Admin-Password-15Chars!');
    adminToken = loginRes.accessToken!;
  });

  after(async () => {
    if (testServer) {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  describe('1. Parent Self-Registration Flow', () => {
    const parentEmail = `parent-self-${nanoid(6)}@example.com`.toLowerCase();
    const parentPassword = 'Secure-Password-15Chars!';
    let rawActivationToken: string;
    let registeredUserId: string;

    it('creates user as PENDING_ACTIVATION and returns no session token or activationToken via HTTP', async () => {
      const res = await makeRequest('POST', '/api/auth/register', {}, {
        email: parentEmail,
        password: parentPassword,
        name: 'Jane Doe',
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user.status, 'PENDING_ACTIVATION');
      assert.strictEqual(res.body.user.emailVerified, false);
      assert.strictEqual(res.body.activationRequired, true);
      assert.strictEqual(res.body.token, undefined);
      assert.strictEqual(res.body.accessToken, undefined);
      assert.strictEqual(res.body.activationToken, undefined, 'activationToken must NEVER be in HTTP response');

      registeredUserId = res.body.user.id;
      rawActivationToken = getLatestActivationToken(parentEmail);
      assert.ok(rawActivationToken, 'Raw activation token obtained from mail outbox');

      // Database verification
      const dbUser = await prisma.user.findUnique({ where: { id: registeredUserId } });
      assert.strictEqual(dbUser?.status, 'PENDING_ACTIVATION');
      assert.strictEqual(dbUser?.activatedAt, null);

      const dbToken = await prisma.accountActivationToken.findUnique({
        where: { tokenHash: hashToken(rawActivationToken) },
      });
      assert.ok(dbToken);
      assert.strictEqual(dbToken.userId, registeredUserId);
      assert.strictEqual(dbToken.source, 'SELF_REGISTRATION');
      assert.strictEqual(dbToken.usedAt, null);
    });

    it('blocks login attempt before activation with 403 ACCOUNT_ACTIVATION_REQUIRED', async () => {
      const res = await makeRequest('POST', '/api/auth/login', {}, {
        email: parentEmail,
        password: parentPassword,
      });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, 'ACCOUNT_ACTIVATION_REQUIRED');
    });

    it('validates activation token via GET /api/auth/activate/verify', async () => {
      const res = await makeRequest('GET', `/api/auth/activate/verify?token=${encodeURIComponent(rawActivationToken)}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, true);
      assert.strictEqual(res.body.email, parentEmail);
      assert.strictEqual(res.body.name, 'Jane Doe');
      assert.strictEqual(res.body.source, 'SELF_REGISTRATION');
      assert.strictEqual(res.body.requiresPassword, false);
    });

    it('activates account via POST /api/auth/activate', async () => {
      const res = await makeRequest('POST', '/api/auth/activate', {}, {
        token: rawActivationToken,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.email, parentEmail);

      const dbUser = await prisma.user.findUnique({ where: { id: registeredUserId } });
      assert.strictEqual(dbUser?.status, 'ACTIVE');
      assert.strictEqual(dbUser?.emailVerified, true);
      assert.ok(dbUser?.activatedAt !== null);

      const dbToken = await prisma.accountActivationToken.findUnique({
        where: { tokenHash: hashToken(rawActivationToken) },
      });
      assert.ok(dbToken?.usedAt !== null);
    });

    it('rejects reused activation token', async () => {
      const res = await makeRequest('POST', '/api/auth/activate', {}, {
        token: rawActivationToken,
      });

      assert.strictEqual(res.status, 400);
    });

    it('allows successful login after activation', async () => {
      const res = await makeRequest('POST', '/api/auth/login', {}, {
        email: parentEmail,
        password: parentPassword,
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.token);
      assert.strictEqual(res.body.user.status, 'ACTIVE');
    });
  });

  describe('2. Admin-Created Parent Flow', () => {
    const parentEmail = `admin-created-${nanoid(6)}@example.com`;
    let rawActivationToken: string;
    let createdUserId: string;
    const chosenPassword = 'Parent-Chosen-Password-15!';

    it('rejects parent creation by unauthenticated or non-admin user', async () => {
      const res = await makeRequest('POST', '/api/admin/parents', {}, {
        name: 'Bob Smith',
        email: parentEmail,
      });
      assert.strictEqual(res.status, 401);
    });

    it('allows SYSTEM_ADMIN to create parent pending activation without returning activationToken via HTTP', async () => {
      const res = await makeRequest('POST', '/api/admin/parents', {
        Authorization: `Bearer ${adminToken}`,
      }, {
        name: 'Bob Smith',
        email: parentEmail,
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.user.status, 'PENDING_ACTIVATION');
      assert.strictEqual(res.body.user.systemRole, 'USER');
      assert.strictEqual(res.body.activationToken, undefined, 'activationToken must NEVER be returned over HTTP');

      createdUserId = res.body.user.id;
      rawActivationToken = getLatestActivationToken(parentEmail);
      assert.ok(rawActivationToken);

      const dbToken = await prisma.accountActivationToken.findUnique({
        where: { tokenHash: hashToken(rawActivationToken) },
      });
      assert.ok(dbToken);
      assert.strictEqual(dbToken.source, 'ADMIN_CREATED');
    });

    it('verifies that admin-created token requires setting password', async () => {
      const res = await makeRequest('GET', `/api/auth/activate/verify?token=${encodeURIComponent(rawActivationToken)}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, true);
      assert.strictEqual(res.body.requiresPassword, true);
    });

    it('rejects activation without password for admin-created parent', async () => {
      const res = await makeRequest('POST', '/api/auth/activate', {}, {
        token: rawActivationToken,
      });

      assert.strictEqual(res.status, 400);
    });

    it('rejects activation with weak password violating policy', async () => {
      const res = await makeRequest('POST', '/api/auth/activate', {}, {
        token: rawActivationToken,
        password: 'short',
      });

      assert.strictEqual(res.status, 400);
    });

    it('activates account and sets password when policy is satisfied', async () => {
      const res = await makeRequest('POST', '/api/auth/activate', {}, {
        token: rawActivationToken,
        password: chosenPassword,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      const dbUser = await prisma.user.findUnique({ where: { id: createdUserId } });
      assert.strictEqual(dbUser?.status, 'ACTIVE');
      assert.strictEqual(dbUser?.emailVerified, true);
      assert.ok(dbUser?.activatedAt);
    });

    it('parent logs in successfully with the chosen password', async () => {
      const res = await makeRequest('POST', '/api/auth/login', {}, {
        email: parentEmail,
        password: chosenPassword,
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.token);
      assert.strictEqual(res.body.user.status, 'ACTIVE');
    });
  });

  describe('3. Resend Activation Flow', () => {
    const parentEmail = `resend-${nanoid(6)}@example.com`;
    let originalToken: string;
    let userId: string;

    before(async () => {
      const res = await makeRequest('POST', '/api/auth/register', {}, {
        email: parentEmail,
        password: 'Password-For-Resend-15Chars!',
        name: 'Charlie Brown',
      });
      userId = res.body.user.id;
      originalToken = getLatestActivationToken(parentEmail);
    });

    it('public resend returns generic message to prevent user enumeration without returning activationToken', async () => {
      const nonExistent = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: 'nonexistent@example.com',
      });
      assert.strictEqual(nonExistent.status, 200);
      assert.strictEqual(nonExistent.body.activationToken, undefined);
      assert.ok(nonExistent.body.message.includes('If an unactivated account exists'));

      const res = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: parentEmail,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.activationToken, undefined);
      assert.ok(res.body.message.includes('If an unactivated account exists'));

      const newToken = getLatestActivationToken(parentEmail);
      assert.ok(newToken);
      assert.notStrictEqual(newToken, originalToken);

      // Old token invalidated
      const oldDbToken = await prisma.accountActivationToken.findUnique({
        where: { tokenHash: hashToken(originalToken) },
      });
      assert.ok(oldDbToken?.usedAt !== null);
    });

    it('admin can resend activation email without returning activationToken via HTTP', async () => {
      const res = await makeRequest('POST', `/api/admin/parents/${userId}/resend-activation`, {
        Authorization: `Bearer ${adminToken}`,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.activationToken, undefined);

      const latestToken = getLatestActivationToken(parentEmail);
      const dbToken = await prisma.accountActivationToken.findUnique({
        where: { tokenHash: hashToken(latestToken) },
      });
      assert.strictEqual(dbToken?.source, 'ADMIN_REGENERATED');
    });
  });

  describe('4. Token Security & PostgreSQL Triggers', () => {
    it('rejects expired activation token', async () => {
      const parentEmail = `expired-${nanoid(6)}@example.com`;
      await authService.register(parentEmail, 'Password-Expired-15Chars!', 'Expired Test');
      const rawToken = getLatestActivationToken(parentEmail);

      // Manually set expiration to past
      await prisma.accountActivationToken.update({
        where: { tokenHash: hashToken(rawToken) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const verifyRes = await makeRequest('GET', `/api/auth/activate/verify?token=${encodeURIComponent(rawToken)}`);
      assert.strictEqual(verifyRes.status, 400);
      assert.strictEqual(verifyRes.body.valid, false);

      const actRes = await makeRequest('POST', '/api/auth/activate', {}, { token: rawToken });
      assert.strictEqual(actRes.status, 400);
    });

    it('PostgreSQL trigger blocks direct session insert for PENDING_ACTIVATION user', async () => {
      const parentEmail = `trigger-${nanoid(6)}@example.com`;
      const reg = await authService.register(parentEmail, 'Password-Trigger-15Chars!', 'Trigger Test');

      await assert.rejects(async () => {
        await prisma.userSession.create({
          data: {
            id: `sess_${nanoid(16)}`,
            userId: reg.user.id,
            sessionFamilyId: `sfam_${nanoid(16)}`,
            refreshTokenHash: hashToken('rt_test'),
            expiresAt: new Date(Date.now() + 3600000),
            tokenVersion: 1,
          },
        });
      }, (err: any) => {
        return err.message.includes('ACCOUNT_ACTIVATION_REQUIRED') || err.message.includes('trigger');
      });
    });
  });

  describe('5. P0-1 Security Remediation: NODE_ENV=development HTTP Token Leak Prevention', () => {
    let originalEnv: string | undefined;

    before(() => {
      originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
    });

    after(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('ensures POST /api/auth/register never exposes activationToken or raw URLs in development mode', async () => {
      const testEmail = `dev-reg-${nanoid(6)}@example.com`;
      const res = await makeRequest('POST', '/api/auth/register', {}, {
        email: testEmail,
        password: 'DevModePassword123!',
        name: 'Dev Parent',
      });

      assert.strictEqual(res.status, 200);
      const bodyStr = JSON.stringify(res.body);
      assert.strictEqual(res.body.activationToken, undefined);
      assert.strictEqual(bodyStr.includes('act_'), false, 'Response body must not contain raw activation token');
      assert.strictEqual(bodyStr.includes('/activate?token='), false, 'Response body must not contain activation URL');
    });

    it('ensures POST /api/auth/activate/resend never exposes activationToken in development mode', async () => {
      const testEmail = `dev-resend-${nanoid(6)}@example.com`;
      await authService.register(testEmail, 'DevModePassword123!', 'Dev Parent');

      const res = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: testEmail,
      });

      assert.strictEqual(res.status, 200);
      const bodyStr = JSON.stringify(res.body);
      assert.strictEqual(res.body.activationToken, undefined);
      assert.strictEqual(bodyStr.includes('act_'), false);
    });

    it('ensures POST /api/admin/parents never exposes activationToken in development mode', async () => {
      const testEmail = `dev-admin-parent-${nanoid(6)}@example.com`;
      const res = await makeRequest('POST', '/api/admin/parents', {
        Authorization: `Bearer ${adminToken}`,
      }, {
        name: 'Dev Admin Parent',
        email: testEmail,
      });

      assert.strictEqual(res.status, 201);
      const bodyStr = JSON.stringify(res.body);
      assert.strictEqual(res.body.activationToken, undefined);
      assert.strictEqual(bodyStr.includes('act_'), false);
    });

    it('ensures POST /api/admin/parents/:id/resend-activation never exposes activationToken in development mode', async () => {
      const testEmail = `dev-admin-resend-${nanoid(6)}@example.com`;
      const createRes = await authService.adminCreateParent(adminId, 'Dev Admin Resend Parent', testEmail);

      const res = await makeRequest('POST', `/api/admin/parents/${createRes.user.id}/resend-activation`, {
        Authorization: `Bearer ${adminToken}`,
      });

      assert.strictEqual(res.status, 200);
      const bodyStr = JSON.stringify(res.body);
      assert.strictEqual(res.body.activationToken, undefined);
      assert.strictEqual(bodyStr.includes('act_'), false);
    });
  });

  describe('6. P0-2 Security Remediation: Admin Verify Email Must NOT Activate PENDING_ACTIVATION Account', () => {
    it('rejects admin email verification for PENDING_ACTIVATION parent with 400 ACCOUNT_ACTIVATION_REQUIRED', async () => {
      const pendingEmail = `pending-verify-${nanoid(6)}@example.com`;
      const createRes = await authService.adminCreateParent(adminId, 'Pending Parent', pendingEmail);
      const targetUserId = createRes.user.id;

      // Admin attempts to verify email directly
      const verifyRes = await makeRequest('POST', `/api/admin/parents/${targetUserId}/verify-email`, {
        Authorization: `Bearer ${adminToken}`,
      });

      assert.strictEqual(verifyRes.status, 400);
      assert.strictEqual(verifyRes.body.code, 'ACCOUNT_ACTIVATION_REQUIRED');
      assert.ok(verifyRes.body.error.includes('Cannot manually verify email for an account pending activation'));

      // Check DB user status remains PENDING_ACTIVATION and emailVerified is false
      const dbUser = await prisma.user.findUnique({ where: { id: targetUserId } });
      assert.strictEqual(dbUser?.status, 'PENDING_ACTIVATION');
      assert.strictEqual(dbUser?.emailVerified, false);
      assert.strictEqual(dbUser?.activatedAt, null);

      // Verify login is still blocked
      const loginRes = await makeRequest('POST', '/api/auth/login', {}, {
        email: pendingEmail,
        password: 'AnyPassword123!',
      });
      assert.strictEqual(loginRes.status, 403);
      assert.strictEqual(loginRes.body.code, 'ACCOUNT_ACTIVATION_REQUIRED');

      // Verify account can still be activated properly with activation token and password setup
      const token = getLatestActivationToken(pendingEmail);
      const actRes = await makeRequest('POST', '/api/auth/activate', {}, {
        token,
        password: 'ValidActivationPassword123!',
      });
      assert.strictEqual(actRes.status, 200);
      assert.strictEqual(actRes.body.success, true);

      // DB user is now ACTIVE
      const activatedUser = await prisma.user.findUnique({ where: { id: targetUserId } });
      assert.strictEqual(activatedUser?.status, 'ACTIVE');
      assert.strictEqual(activatedUser?.emailVerified, true);
    });

    it('allows admin email verification for already ACTIVE users', async () => {
      const activeEmail = `active-parent-${nanoid(6)}@example.com`;
      const regRes = await authService.register(activeEmail, 'ActiveParentPassword123!', 'Active Parent');
      const token = getLatestActivationToken(activeEmail);
      await authService.activateAccount(token);

      // Set emailVerified to false manually for test
      await prisma.user.update({
        where: { id: regRes.user.id },
        data: { emailVerified: false },
      });

      // Admin verifies email
      const verifyRes = await makeRequest('POST', `/api/admin/parents/${regRes.user.id}/verify-email`, {
        Authorization: `Bearer ${adminToken}`,
      });

      assert.strictEqual(verifyRes.status, 200);
      assert.strictEqual(verifyRes.body.success, true);

      const dbUser = await prisma.user.findUnique({ where: { id: regRes.user.id } });
      assert.strictEqual(dbUser?.emailVerified, true);
      assert.strictEqual(dbUser?.status, 'ACTIVE');
    });
  });

  describe('7. Anti-Enumeration Invariant: Public Resend Account Status Neutrality', () => {
    it('returns identical 200 response for non-existent, active, disabled, and pending accounts', async () => {
      const expectedMessage = 'If an unactivated account exists for this email, an activation link has been sent.';

      // 1. Non-existent email
      const resNonExistent = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: `ghost-${nanoid(8)}@example.com`,
      });
      assert.strictEqual(resNonExistent.status, 200);
      assert.deepStrictEqual(resNonExistent.body, { success: true, message: expectedMessage });

      // 2. Active user
      const activeEmail = `active-${nanoid(6)}@example.com`;
      await authService.register(activeEmail, 'ValidPassword123!', 'Active User');
      const actToken = getLatestActivationToken(activeEmail);
      await authService.activateAccount(actToken);

      const resActive = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: activeEmail,
      });
      assert.strictEqual(resActive.status, 200);
      assert.deepStrictEqual(resActive.body, { success: true, message: expectedMessage });

      // 3. Disabled user
      const disabledEmail = `disabled-${nanoid(6)}@example.com`;
      const disReg = await authService.register(disabledEmail, 'ValidPassword123!', 'Disabled User');
      const disToken = getLatestActivationToken(disabledEmail);
      await authService.activateAccount(disToken);
      await prisma.user.update({
        where: { id: disReg.user.id },
        data: { status: 'DISABLED', disabledAt: new Date(), disabledReason: 'Test disable' },
      });

      const resDisabled = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: disabledEmail,
      });
      assert.strictEqual(resDisabled.status, 200);
      assert.deepStrictEqual(resDisabled.body, { success: true, message: expectedMessage });

      // 4. Pending activation user
      const pendingEmail = `pending-${nanoid(6)}@example.com`;
      await authService.register(pendingEmail, 'ValidPassword123!', 'Pending User');

      const resPending = await makeRequest('POST', '/api/auth/activate/resend', {}, {
        email: pendingEmail,
      });
      assert.strictEqual(resPending.status, 200);
      assert.deepStrictEqual(resPending.body, { success: true, message: expectedMessage });
    });
  });
});
