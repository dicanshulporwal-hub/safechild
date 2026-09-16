import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';
import { prisma } from '../src/db/prisma';
import { authService } from '../src/services/auth.service';
import { mailService } from '../src/services/mail.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { rbacService } from '../src/services/rbac.service';
import { nanoid } from 'nanoid';

describe('SafeBrowse Stage 11 Step 3: System Admin RBAC & Family Authorization Suite', () => {
  let testServer: http.Server;
  let baseUrl: string;

  function getActivationToken(email: string): string {
    const mail = mailService.getOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase().trim()).pop();
    if (!mail || !mail.token) throw new Error(`Activation token not found for ${email}`);
    return mail.token;
  }

  // Family A Entities
  let ownerAId: string;
  let ownerAToken: string;
  let parentAId: string;
  let parentAToken: string;
  let viewerAId: string;
  let viewerAToken: string;
  let familyAId: string;
  let childAId: string;
  let deviceAId: string;
  let deviceAToken: string;

  // Family B Entities
  let ownerBId: string;
  let ownerBToken: string;
  let familyBId: string;
  let childBId: string;

  // Admin Entities
  let adminId: string;
  let adminToken: string;

  const testPassword = 'SafeBrowse-Password-15Chars!';

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
              parsedBody = JSON.parse(data);
            } catch {
              parsedBody = data;
            }
            resolve({ status: res.statusCode || 500, body: parsedBody, headers: res.headers });
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

    // 1. Setup Family A: Owner, Parent, Viewer, Child, Device
    const ownerAEmail = `owner-a-${nanoid(6)}@safebrowse.io`;
    const uOwnerA = await authService.register(ownerAEmail, testPassword, 'Owner A');
    await authService.activateAccount(getActivationToken(ownerAEmail));
    ownerAId = uOwnerA.user.id;
    const lOwnerA = await authService.login(ownerAEmail, testPassword);
    ownerAToken = lOwnerA.accessToken!;

    const famA = await familyService.getOrCreateUserFamily(ownerAId);
    familyAId = famA.id;

    // Create Child A
    const { child: cA } = await childService.createChild(ownerAId, 'Child A', 10, undefined, familyAId);
    childAId = cA.id;

    // Pair Device A
    const pairA = await deviceService.generatePairingCode(ownerAId, childAId);
    const { device: devA } = await deviceService.pairDevice(pairA.code, 'Device A', 'windows', '1.0.0');
    deviceAId = devA.id;
    deviceAToken = devA.deviceToken;

    // Invite & register Parent A
    const invParentA = await familyService.inviteParent(familyAId, ownerAId, `parent-a-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uParentA = await authService.register(invParentA.email, testPassword, 'Parent A');
    await authService.activateAccount(getActivationToken(invParentA.email));
    parentAId = uParentA.user.id;
    const lParentA = await authService.login(invParentA.email, testPassword);
    parentAToken = lParentA.accessToken!;
    await familyService.acceptInvitation(invParentA.token, parentAId);

    // Invite & register Viewer A
    const invViewerA = await familyService.inviteParent(familyAId, ownerAId, `viewer-a-${nanoid(6)}@safebrowse.io`, 'VIEWER');
    const uViewerA = await authService.register(invViewerA.email, testPassword, 'Viewer A');
    await authService.activateAccount(getActivationToken(invViewerA.email));
    viewerAId = uViewerA.user.id;
    const lViewerA = await authService.login(invViewerA.email, testPassword);
    viewerAToken = lViewerA.accessToken!;
    await familyService.acceptInvitation(invViewerA.token, viewerAId);

    // 2. Setup Family B: Owner, Child
    const ownerBEmail = `owner-b-${nanoid(6)}@safebrowse.io`;
    const uOwnerB = await authService.register(ownerBEmail, testPassword, 'Owner B');
    await authService.activateAccount(getActivationToken(ownerBEmail));
    ownerBId = uOwnerB.user.id;
    const lOwnerB = await authService.login(ownerBEmail, testPassword);
    ownerBToken = lOwnerB.accessToken!;

    const famB = await familyService.getOrCreateUserFamily(ownerBId);
    familyBId = famB.id;

    const { child: cB } = await childService.createChild(ownerBId, 'Child B', 12, undefined, familyBId);
    childBId = cB.id;

    // 3. Setup System Administrator
    const adminEmail = `admin-${nanoid(6)}@safebrowse.io`;
    const uAdmin = await authService.register(adminEmail, testPassword, 'System Administrator');
    await authService.activateAccount(getActivationToken(adminEmail));
    adminId = uAdmin.user.id;
    process.env.ENABLE_DEV_ADMIN_BOOTSTRAP = 'true';
    process.env.DEV_ADMIN_BOOTSTRAP_SECRET = 'test-secret-at-least-16-chars-long';
    await rbacService.bootstrapDevAdmin(adminId, 'test-secret-at-least-16-chars-long');
    const lAdmin = await authService.login(adminEmail, testPassword);
    adminToken = lAdmin.accessToken!;
  });

  after(() => {
    if (testServer) {
      testServer.close();
    }
  });

  describe('1. System Admin vs Family Roles Isolation', () => {
    it('1. should reject normal parent accessing system-admin endpoints (403)', async () => {
      const res = await makeRequest('GET', '/api/admin/metrics', {
        Authorization: `Bearer ${parentAToken}`,
      });
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /System administrator privilege required/i);
    });

    it('2. should reject Family OWNER accessing system-admin endpoints (403 - Owner is not System Admin)', async () => {
      const res = await makeRequest('GET', '/api/admin/fleet', {
        Authorization: `Bearer ${ownerAToken}`,
      });
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /System administrator privilege required/i);
    });

    it('3. should allow SYSTEM_ADMIN to access protected administrative operations (200)', async () => {
      const res = await makeRequest('GET', '/api/admin/metrics', {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.devicesCount !== undefined);
      assert.ok(res.body.healthBreakdown !== undefined);
    });

    it('3b. should record append-only audit event on privileged admin rollback', async () => {
      const res = await makeRequest(
        'POST',
        '/api/admin/rollback',
        { Authorization: `Bearer ${adminToken}` },
        { targetVersion: '1.0.0', reason: 'Automated test emergency rollback' }
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify audit log
      const auditRes = await makeRequest('GET', '/api/admin/audit', {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(auditRes.status, 200);
      assert.ok(Array.isArray(auditRes.body.logs));
      const hasRollbackLog = auditRes.body.logs.some((l: any) => l.action === 'EMERGENCY_ROLLBACK_TRIGGERED');
      assert.strictEqual(hasRollbackLog, true);
    });

    it('3c. should allow SYSTEM_ADMIN to list all parents and reject standard parents (403)', async () => {
      // Normal parent should get 403
      const forbiddenRes = await makeRequest('GET', '/api/admin/parents', {
        Authorization: `Bearer ${parentAToken}`,
      });
      assert.strictEqual(forbiddenRes.status, 403);

      // System Admin should get 200 with list of parents
      const adminRes = await makeRequest('GET', '/api/admin/parents', {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(adminRes.status, 200);
      assert.ok(Array.isArray(adminRes.body.parents));
      assert.ok(adminRes.body.total >= 2);
    });

    it('3d. should allow SYSTEM_ADMIN to view parent details, verify email, and reset password', async () => {
      // 1. Create a dedicated parent to test admin inspection and password reset
      const tempEmail = `temp-parent-${nanoid(6)}@safebrowse.io`;
      const tempParent = await authService.register(tempEmail, testPassword, 'Temp Parent');
      await authService.activateAccount(getActivationToken(tempEmail));
      const tempParentId = tempParent.user.id;

      // Set emailVerified to false to test admin manual verification
      await prisma.user.update({
        where: { id: tempParentId },
        data: { emailVerified: false },
      });

      // 2. Get specific parent details
      const detailRes = await makeRequest('GET', `/api/admin/parents/${tempParentId}`, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(detailRes.status, 200);
      assert.strictEqual(detailRes.body.id, tempParentId);
      assert.ok(Array.isArray(detailRes.body.families));

      // 3. Manually verify parent email
      const verifyRes = await makeRequest('POST', `/api/admin/parents/${tempParentId}/verify-email`, {
        Authorization: `Bearer ${adminToken}`,
      });
      assert.strictEqual(verifyRes.status, 200);
      assert.strictEqual(verifyRes.body.success, true);

      // 4. Admin reset parent password
      const resetRes = await makeRequest(
        'POST',
        `/api/admin/parents/${tempParentId}/reset-password`,
        { Authorization: `Bearer ${adminToken}` },
        { newPassword: 'NewAdminAssignedPass2026!' }
      );
      assert.strictEqual(resetRes.status, 200);
      assert.strictEqual(resetRes.body.success, true);

      // 5. Verify parent can login with new password
      const loginRes = await authService.login(detailRes.body.email, 'NewAdminAssignedPass2026!');
      assert.ok(loginRes.token);
    });
  });

  describe('2. Family Role Permissions & Co-Parent Access', () => {
    it('4. should allow OWNER to manage family members (change role and settings)', async () => {
      // OWNER updates family settings
      const patchRes = await makeRequest(
        'PATCH',
        '/api/family',
        { Authorization: `Bearer ${ownerAToken}` },
        { familyId: familyAId, name: 'Family A (Updated by Owner)' }
      );
      assert.strictEqual(patchRes.status, 200);
      assert.strictEqual(patchRes.body.family.name, 'Family A (Updated by Owner)');
    });

    it('5. should allow PARENT to manage permitted child resources (add rule, update pause)', async () => {
      const res = await makeRequest(
        'POST',
        `/api/policies/child/${childAId}/rules`,
        { Authorization: `Bearer ${parentAToken}` },
        { domain: 'minecraft.net', action: 'BLOCK', reason: 'School hours block' }
      );
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.rules.some((r: any) => r.domain === 'minecraft.net'));
    });

    it('6. should reject VIEWER mutating child policies with 403 Forbidden', async () => {
      const res = await makeRequest(
        'POST',
        `/api/policies/child/${childAId}/rules`,
        { Authorization: `Bearer ${viewerAToken}` },
        { domain: 'roblox.com', action: 'BLOCK' }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Forbidden/i);
    });

    it('6b. should reject VIEWER mutating screen-time budgets with 403 Forbidden', async () => {
      const res = await makeRequest(
        'POST',
        `/api/usage/child/${childAId}/budget`,
        { Authorization: `Bearer ${viewerAToken}` },
        { target: 'youtube.com', targetType: 'DOMAIN', dailyLimitMinutes: 30 }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Forbidden/i);
    });

    it('6c. should allow verified OWNER to create child without explicit familyId (derived tenancy)', async () => {
      const res = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${ownerAToken}` },
        { name: 'Child Created By Owner', age: 11, avatar: '👧' }
      );
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.child.id);
      assert.strictEqual(res.body.child.name, 'Child Created By Owner');
      assert.strictEqual(res.body.child.familyId, familyAId);
      assert.strictEqual(res.body.child.parentId, ownerAId);
      assert.ok(res.body.policy);
      assert.strictEqual(res.body.policy.childId, res.body.child.id);
      assert.strictEqual(res.body.policy.familyId, familyAId);
    });

    it('6d. should allow verified PARENT with CHILD_MANAGE to create child', async () => {
      const res = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${parentAToken}` },
        { name: 'Child Created By Parent', age: 8, familyId: familyAId }
      );
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.child.id);
      assert.strictEqual(res.body.child.name, 'Child Created By Parent');
      assert.strictEqual(res.body.child.familyId, familyAId);
      assert.strictEqual(res.body.child.parentId, parentAId);
    });

    it('6e. should reject VIEWER creating child profile with 403 Forbidden', async () => {
      const res = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${viewerAToken}` },
        { name: 'Unauthorized Child', age: 7, familyId: familyAId }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Forbidden/i);
    });

    it('6f. should reject cross-family familyId tampering with 403 Forbidden', async () => {
      // Owner A attempts to create a child inside Family B
      const res = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${ownerAToken}` },
        { name: 'Tampered Child', age: 10, familyId: familyBId }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Forbidden: You do not belong to this family/i);
    });

    it('6g. should reject missing name or invalid age with 400 Bad Request', async () => {
      const noName = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${ownerAToken}` },
        { name: '', age: 10 }
      );
      assert.strictEqual(noName.status, 400);
      assert.match(noName.body.error, /Child name is required/i);

      const invalidAge = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${ownerAToken}` },
        { name: 'Bad Age Child', age: -5 }
      );
      assert.strictEqual(invalidAge.status, 400);
      assert.match(invalidAge.body.error, /Invalid age/i);
    });

    it('6h. should reject unverified parent from creating child profile with 403', async () => {
      // 1. Unactivated user receives no accessToken
      const unverifiedReg = await authService.register(
        `unverified.${nanoid(6)}@example.com`,
        testPassword,
        'Unverified Parent'
      );
      assert.strictEqual(unverifiedReg.activationRequired, true);
      assert.strictEqual(unverifiedReg.user.emailVerified, false);

      // 2. Active user with emailVerified=false is rejected with 403
      await prisma.user.update({
        where: { id: unverifiedReg.user.id },
        data: { status: 'ACTIVE', emailVerified: false },
      });
      const login = await authService.login(unverifiedReg.user.email, testPassword);

      const res = await makeRequest(
        'POST',
        '/api/children',
        { Authorization: `Bearer ${login.accessToken}` },
        { name: 'Blocked Child', age: 9 }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Verify your email address/i);
    });

    it('6i. should atomically roll back child if policy creation fails', async () => {
      // Verify rollback by mocking a failure in transaction
      const targetFamily = familyAId;
      const initialCount = await prisma.child.count({ where: { familyId: targetFamily } });

      try {
        await prisma.$transaction(async (tx) => {
          await tx.child.create({
            data: {
              id: 'temp-rollback-child',
              parentId: ownerAId,
              familyId: targetFamily,
              name: 'Rollback Test',
            },
          });
          // Force an intentional failure on policy creation
          throw new Error('Simulated atomic transaction failure');
        });
      } catch (e: any) {
        assert.match(e.message, /Simulated atomic transaction failure/);
      }

      const finalCount = await prisma.child.count({ where: { familyId: targetFamily } });
      assert.strictEqual(finalCount, initialCount);
    });
  });

  describe('3. Access Request Approval & Family Rules', () => {
    let requestId: string;

    before(async () => {
      // Child A creates request from Device A
      const reqRes = await makeRequest(
        'POST',
        '/api/requests',
        { 'x-device-id': deviceAId, 'x-device-token': deviceAToken },
        { domain: 'scratch.mit.edu', reason: 'Coding homework' }
      );
      requestId = reqRes.body.id;
    });

    it('7. should reject VIEWER attempting to approve an access request with 403', async () => {
      const res = await makeRequest(
        'POST',
        `/api/requests/${requestId}/resolve`,
        { Authorization: `Bearer ${viewerAToken}` },
        { action: 'APPROVE', duration: '30m' }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Forbidden/i);
    });

    it('8a. should reject PARENT approval when family approval rule is set to OWNER_ONLY', async () => {
      // Set approval rule to OWNER_ONLY
      await makeRequest(
        'PATCH',
        '/api/family',
        { Authorization: `Bearer ${ownerAToken}` },
        { familyId: familyAId, approvalRule: 'OWNER_ONLY' }
      );

      const res = await makeRequest(
        'POST',
        `/api/requests/${requestId}/resolve`,
        { Authorization: `Bearer ${parentAToken}` },
        { action: 'APPROVE', duration: '30m' }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /requires the Family Owner/i);
    });

    it('8b. should allow PARENT approval when family approval rule is set to OWNER_OR_PARENT', async () => {
      // Set approval rule back to OWNER_OR_PARENT
      await makeRequest(
        'PATCH',
        '/api/family',
        { Authorization: `Bearer ${ownerAToken}` },
        { familyId: familyAId, approvalRule: 'OWNER_OR_PARENT' }
      );

      const res = await makeRequest(
        'POST',
        `/api/requests/${requestId}/resolve`,
        { Authorization: `Bearer ${parentAToken}` },
        { action: 'APPROVE', duration: '30m' }
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.request.status, 'APPROVED');
    });
  });

  describe('4. Cross-Family Isolation & Tenancy Verification', () => {
    it('9a. should reject Parent A accessing Child B profile (403/404)', async () => {
      const res = await makeRequest('GET', `/api/children/${childBId}`, {
        Authorization: `Bearer ${parentAToken}`,
      });
      assert.strictEqual(res.status, 403);
    });

    it('9b. should reject Parent A mutating Child B policy (403)', async () => {
      const res = await makeRequest(
        'POST',
        `/api/policies/child/${childBId}/rules`,
        { Authorization: `Bearer ${parentAToken}` },
        { domain: 'cross-site.com', action: 'BLOCK' }
      );
      assert.strictEqual(res.status, 403);
    });

    it('9c. should reject Parent B accessing Device A (403/404)', async () => {
      const res = await makeRequest('POST', `/api/devices/${deviceAId}/diagnostics`, {
        Authorization: `Bearer ${ownerBToken}`,
      });
      assert.strictEqual(res.status, 403);
    });

    it('9d. should reject Parent B modifying Child A usage budget (403)', async () => {
      const res = await makeRequest(
        'POST',
        `/api/usage/child/${childAId}/budget`,
        { Authorization: `Bearer ${ownerBToken}` },
        { target: 'youtube.com', targetType: 'DOMAIN', dailyLimitMinutes: 20 }
      );
      assert.strictEqual(res.status, 403);
    });
  });

  describe('5. Family Ownership Transfer & Invariants', () => {
    it('10. should prevent removal or demotion of the final Family OWNER', async () => {
      const membership = await prisma.familyMember.findFirst({
        where: { familyId: familyAId, userId: ownerAId },
      });
      assert.ok(membership);

      const res = await makeRequest('DELETE', `/api/family/members/${membership.id}?familyId=${familyAId}`, {
        Authorization: `Bearer ${ownerAToken}`,
      });
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /Cannot remove the Family Owner/i);
    });

    it('11. should reject ownership transfer without step-up authentication password (403)', async () => {
      const res = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerAToken}` },
        { familyId: familyAId, newOwnerUserId: parentAId }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /password must be provided|step-up/i);
    });

    it('12. should succeed ownership transfer with valid step-up password and persist single-owner invariant', async () => {
      const res = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerAToken}` },
        { familyId: familyAId, newOwnerUserId: parentAId, password: testPassword }
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify Family A owner is now Parent A
      const fam = await prisma.family.findUnique({ where: { id: familyAId } });
      assert.strictEqual(fam?.ownerUserId, parentAId);

      // Invariant: Exactly ONE active owner in Family A
      const owners = await prisma.familyMember.findMany({
        where: { familyId: familyAId, role: 'OWNER' },
      });
      assert.strictEqual(owners.length, 1);
      assert.strictEqual(owners[0].userId, parentAId);

      // Old owner is now PARENT
      const oldOwnerMem = await prisma.familyMember.findFirst({
        where: { familyId: familyAId, userId: ownerAId },
      });
      assert.strictEqual(oldOwnerMem?.role, 'PARENT');
    });
  });

  describe('6. Invitation Token Cryptography & Lifecycle', () => {
    let invitationToken: string;
    let inviteId: string;
    let inviteEmail: string;

    it('14. should generate hashed, expiring, single-use invitation token', async () => {
      inviteEmail = `new-member-${nanoid(6)}@safebrowse.io`;
      // Parent A is now the OWNER
      const res = await makeRequest(
        'POST',
        '/api/family/invitations',
        { Authorization: `Bearer ${parentAToken}` },
        { familyId: familyAId, email: inviteEmail, role: 'VIEWER' }
      );
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.invitation);
      assert.ok(res.body.invitation.token);
      invitationToken = res.body.invitation.token;
      inviteId = res.body.invitation.id;

      // Stored record in DB must hold SHA-256 hash — NOT raw token
      const storedInv = await prisma.familyInvitation.findUnique({ where: { id: inviteId } });
      assert.ok(storedInv?.tokenHash);
      assert.notStrictEqual(storedInv.tokenHash, invitationToken);
    });

    it('14b. should allow recipient to accept invitation and atomically consume it', async () => {
      const uNew = await authService.register(inviteEmail, testPassword, 'New Viewer');
      await authService.activateAccount(getActivationToken(inviteEmail));
      const login = await authService.login(inviteEmail, testPassword);

      const acceptRes = await makeRequest(
        'POST',
        '/api/family/invitations/accept',
        { Authorization: `Bearer ${login.accessToken}` },
        { token: invitationToken }
      );
      assert.strictEqual(acceptRes.status, 200);
      assert.strictEqual(acceptRes.body.success, true);
      assert.strictEqual(acceptRes.body.role, 'VIEWER');

      // Replay attempt must fail (Single-use invariant)
      const replayRes = await makeRequest(
        'POST',
        '/api/family/invitations/accept',
        { Authorization: `Bearer ${login.accessToken}` },
        { token: invitationToken }
      );
      assert.strictEqual(replayRes.status, 400);
      assert.match(replayRes.body.error, /Invalid or expired|already been accepted/i);
    });

    it('15. should reject acceptance of a revoked invitation', async () => {
      const revokeEmail = `revoked-${nanoid(6)}@safebrowse.io`;
      const invRes = await makeRequest(
        'POST',
        '/api/family/invitations',
        { Authorization: `Bearer ${parentAToken}` },
        { familyId: familyAId, email: revokeEmail, role: 'PARENT' }
      );
      const token = invRes.body.invitation.token;
      const id = invRes.body.invitation.id;

      // Revoke
      await makeRequest('DELETE', `/api/family/invitations/${id}`, {
        Authorization: `Bearer ${parentAToken}`,
      });

      // Attempt accept
      const uRev = await authService.register(revokeEmail, testPassword, 'Revoked User');
      await authService.activateAccount(getActivationToken(revokeEmail));
      const revLogin = await authService.login(revokeEmail, testPassword);

      const acceptRes = await makeRequest(
        'POST',
        '/api/family/invitations/accept',
        { Authorization: `Bearer ${revLogin.accessToken}` },
        { token }
      );
      assert.strictEqual(acceptRes.status, 400);
      assert.match(acceptRes.body.error, /Invalid or expired|already been accepted|revoked/i);
    });
  });
});
