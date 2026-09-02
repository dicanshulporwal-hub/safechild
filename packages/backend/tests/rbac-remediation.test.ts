import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../src/server';
import { db } from '../src/db/store';
import { authService } from '../src/services/auth.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { activityService } from '../src/services/activity.service';
import { profileService } from '../src/services/profile.service';
import { rbacService, FamilyPermission } from '../src/services/rbac.service';
import { generateTotpAtStep, getCurrentTotpTimeStep, decryptMfaSecret } from '../src/utils/security';
import { nanoid } from 'nanoid';

describe('SafeBrowse Stage 11 Step 3A: RBAC Critical Remediation Test Suite', () => {
  let testServer: http.Server;
  let baseUrl: string;

  const testPassword = 'SafeBrowse-Password-15Chars!';
  const bootstrapSecret = 'test-secret-at-least-16-chars-long';

  const makeRequest = async (
    method: string,
    endpoint: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> => {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, baseUrl);
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };

      const payload = body ? JSON.stringify(body) : undefined;
      if (payload) {
        reqHeaders['Content-Length'] = Buffer.byteLength(payload).toString();
      }

      const req = http.request(
        url,
        {
          method,
          headers: reqHeaders,
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            let parsedBody = {};
            try {
              parsedBody = rawData ? JSON.parse(rawData) : {};
            } catch (e) {
              parsedBody = { raw: rawData };
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

    process.env.ENABLE_DEV_ADMIN_BOOTSTRAP = 'true';
    process.env.DEV_ADMIN_BOOTSTRAP_SECRET = bootstrapSecret;
  });

  after(() => {
    if (testServer) {
      testServer.close();
    }
  });

  describe('1. Secure System-Admin Provisioning', () => {
    it('should reject bootstrap without valid x-admin-bootstrap-secret header (403)', async () => {
      const u = authService.register(`user-bootstrap-${nanoid(6)}@safebrowse.io`, testPassword, 'Normal User');
      authService.verifyEmail(u.emailVerificationToken);

      const res = await makeRequest('POST', '/api/admin/bootstrap-dev', {
        Authorization: `Bearer ${u.accessToken}`,
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(u.user.systemRole || 'USER', 'USER');
    });

    it('should reject bootstrap in production mode even if ENABLE_DEV_ADMIN_BOOTSTRAP=true', async () => {
      const u = authService.register(`prod-user-${nanoid(6)}@safebrowse.io`, testPassword, 'Prod User');
      authService.verifyEmail(u.emailVerificationToken);

      const prevEnv = process.env.NODE_ENV;
      const prevJwt = process.env.JWT_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = 'dev-jwt-secret-safebrowse-platform-2026-min32chars';

        const res = await makeRequest(
          'POST',
          '/api/admin/bootstrap-dev',
          {
            Authorization: `Bearer ${u.accessToken}`,
            'x-admin-bootstrap-secret': bootstrapSecret,
          },
          { bootstrapSecret }
        );

        assert.strictEqual(res.status, 403);
        assert.match(res.body.error, /strictly disabled in production/i);
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.JWT_SECRET = prevJwt;
      }
    });

    it('should not infer system admin from admin@... email address', async () => {
      const u = authService.register(`admin-imposter-${nanoid(6)}@safebrowse.io`, testPassword, 'Imposter Admin');
      authService.verifyEmail(u.emailVerificationToken);

      const res = await makeRequest('GET', '/api/admin/metrics', {
        Authorization: `Bearer ${u.accessToken}`,
      });
      assert.strictEqual(res.status, 403);
    });
  });

  describe('2. Co-Parent Route Authorization (Activity & Stats)', () => {
    let familyId: string;
    let ownerToken: string;
    let coparentToken: string;
    let outsiderToken: string;
    let childId: string;

    before(() => {
      const uOwner = authService.register(`owner-act-${nanoid(6)}@safebrowse.io`, testPassword, 'Act Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      ownerToken = uOwner.accessToken;
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);
      familyId = fam.id;

      const { child } = childService.createChild(uOwner.user.id, 'Act Child', 8, undefined, familyId);
      childId = child.id;

      // Log some dummy activity
      activityService.logActivity(childId, 'dev-1', 'wikipedia.org', 'ALLOWED');
      activityService.logActivity(childId, 'dev-1', 'tiktok.com', 'BLOCKED');

      // Add Co-Parent
      const inv = familyService.inviteParent(familyId, uOwner.user.id, `coparent-act-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCoparent = authService.register(inv.email, testPassword, 'Act Coparent');
      authService.verifyEmail(uCoparent.emailVerificationToken);
      coparentToken = uCoparent.accessToken;
      familyService.acceptInvitation(inv.token, uCoparent.user.id);

      // Unrelated Outsider
      const uOutsider = authService.register(`outsider-act-${nanoid(6)}@safebrowse.io`, testPassword, 'Outsider');
      authService.verifyEmail(uOutsider.emailVerificationToken);
      outsiderToken = uOutsider.accessToken;
    });

    it('should allow Co-Parent to access GET /api/activity/child/:childId', async () => {
      const res = await makeRequest('GET', `/api/activity/child/${childId}`, {
        Authorization: `Bearer ${coparentToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 2);
    });

    it('should allow Co-Parent to access GET /api/activity/stats/:childId', async () => {
      const res = await makeRequest('GET', `/api/activity/stats/${childId}`, {
        Authorization: `Bearer ${coparentToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.todayBlockedCount !== undefined);
    });

    it('should reject unrelated family member from viewing child activity (403)', async () => {
      const res = await makeRequest('GET', `/api/activity/child/${childId}`, {
        Authorization: `Bearer ${outsiderToken}`,
      });
      assert.strictEqual(res.status, 403);
    });
  });

  describe('3. Ownership-Transfer Step-Up Replay & Atomic Rollback', () => {
    let familyId: string;
    let ownerUser: any;
    let ownerToken: string;
    let memberId: string;
    let memberUser: any;

    before(async () => {
      const uOwner = authService.register(`stepup-owner-${nanoid(6)}@safebrowse.io`, testPassword, 'Stepup Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      ownerUser = uOwner.user;
      ownerToken = uOwner.accessToken;

      const fam = familyService.getOrCreateUserFamily(ownerUser.id);
      familyId = fam.id;

      // Enable MFA on owner to get recovery codes and TOTP secret
      const setup = await profileService.setupMfa(ownerUser.id);
      const step = getCurrentTotpTimeStep();
      const otp = generateTotpAtStep(setup.secret, step);
      const mfaRes = profileService.verifyAndEnableMfa(ownerUser.id, otp);
      ownerUser = db.users.get(ownerUser.id)!;
      ownerUser._rawRecoveryCodes = mfaRes.recoveryCodes;

      // Add target family member
      const inv = familyService.inviteParent(familyId, ownerUser.id, `target-stepup-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uTarget = authService.register(inv.email, testPassword, 'Target Member');
      authService.verifyEmail(uTarget.emailVerificationToken);
      memberUser = uTarget.user;
      memberId = uTarget.user.id;
      familyService.acceptInvitation(inv.token, memberId);
    });

    it('should consume recovery code upon ownership transfer and reject reuse', async () => {
      const recoveryCode = ownerUser._rawRecoveryCodes[0];
      const initialCodesCount = ownerUser.mfaRecoveryCodes.length;

      // 1. Perform ownership transfer with recovery code
      const res1 = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerToken}` },
        { familyId, newOwnerUserId: memberId, password: testPassword, otpCode: recoveryCode }
      );
      assert.strictEqual(res1.status, 200);

      const refreshedOwner = db.users.get(ownerUser.id)!;
      assert.strictEqual(refreshedOwner.mfaRecoveryCodes?.length, initialCodesCount - 1);

      // Transfer back so we can test replay
      // Member is now owner; transfer back to original owner
      await familyService.transferOwnership(familyId, ownerUser.id, memberId, testPassword);

      // Attempt to reuse the SAME recovery code
      const res2 = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerToken}` },
        { familyId, newOwnerUserId: memberId, password: testPassword, otpCode: recoveryCode }
      );
      assert.strictEqual(res2.status, 403);
      assert.match(res2.body.error, /Invalid MFA verification code/i);
    });

    it('should reject TOTP code reuse for ownership transfer during the same timestep', async () => {
      // Original owner is currently owner
      const step = getCurrentTotpTimeStep();
      const decryptedSecret = decryptMfaSecret(ownerUser.mfaSecret);
      const totpCode = generateTotpAtStep(decryptedSecret, step);

      // First transfer with TOTP
      const res1 = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerToken}` },
        { familyId, newOwnerUserId: memberId, password: testPassword, otpCode: totpCode }
      );
      assert.strictEqual(res1.status, 200);

      // Member transfers back
      await familyService.transferOwnership(familyId, ownerUser.id, memberId, testPassword);

      // Attempt to reuse the EXACT same TOTP code in the same timestep
      const res2 = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerToken}` },
        { familyId, newOwnerUserId: memberId, password: testPassword, otpCode: totpCode }
      );
      assert.strictEqual(res2.status, 403);
      assert.match(res2.body.error, /already been used/i);
    });

    it('should roll back all mutations if ownership transfer fails validation or throws', async () => {
      const famBefore = db.families.get(familyId)!;
      const initialOwner = famBefore.ownerUserId;
      const membersBefore = JSON.stringify(Array.from(db.familyMembers.values()));

      // Try transferring to non-existent user
      const nonExistentUserId = `user-ghost-${nanoid(8)}`;
      const res = await makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${ownerToken}` },
        { familyId, newOwnerUserId: nonExistentUserId, password: testPassword }
      );
      assert.strictEqual(res.status, 403);

      // Verify complete rollback
      const famAfter = db.families.get(familyId)!;
      assert.strictEqual(famAfter.ownerUserId, initialOwner);
      const membersAfter = JSON.stringify(Array.from(db.familyMembers.values()));
      assert.strictEqual(membersAfter, membersBefore);
    });
  });

  describe('4. Ownership Concurrency Safety (Single-Owner Invariant)', () => {
    it('should serialize concurrent ownership transfers leaving exactly one owner', async () => {
      const uOwner = authService.register(`conc-owner-${nanoid(6)}@safebrowse.io`, testPassword, 'Conc Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);

      // Create two candidates
      const inv1 = familyService.inviteParent(fam.id, uOwner.user.id, `cand1-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand1 = authService.register(inv1.email, testPassword, 'Cand 1');
      authService.verifyEmail(uCand1.emailVerificationToken);
      familyService.acceptInvitation(inv1.token, uCand1.user.id);

      const inv2 = familyService.inviteParent(fam.id, uOwner.user.id, `cand2-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand2 = authService.register(inv2.email, testPassword, 'Cand 2');
      authService.verifyEmail(uCand2.emailVerificationToken);
      familyService.acceptInvitation(inv2.token, uCand2.user.id);

      // Issue two transfers concurrently
      const p1 = makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${uOwner.accessToken}` },
        { familyId: fam.id, newOwnerUserId: uCand1.user.id, password: testPassword }
      );
      const p2 = makeRequest(
        'POST',
        '/api/family/transfer-ownership',
        { Authorization: `Bearer ${uOwner.accessToken}` },
        { familyId: fam.id, newOwnerUserId: uCand2.user.id, password: testPassword }
      );

      const [res1, res2] = await Promise.all([p1, p2]);

      // One must succeed, and the second must be rejected (since original owner was demoted to PARENT)
      const statuses = [res1.status, res2.status].sort();
      assert.strictEqual(statuses[0], 200);
      assert.strictEqual(statuses[1], 403);

      // Verify the single-owner invariant strictly holds
      const owners = Array.from(db.familyMembers.values()).filter(
        (m) => m.familyId === fam.id && m.role === 'OWNER'
      );
      assert.strictEqual(owners.length, 1);
      const refreshedFam = db.families.get(fam.id)!;
      assert.strictEqual(refreshedFam.ownerUserId, owners[0].userId);
    });
  });

  describe('5. Explicit Resource Tenancy & Multi-Family User Isolation', () => {
    it('should correctly isolate permissions for a user belonging to multiple families', async () => {
      // User X is OWNER of Family 1
      const uUserX = authService.register(`multi-user-${nanoid(6)}@safebrowse.io`, testPassword, 'User X');
      authService.verifyEmail(uUserX.emailVerificationToken);
      const fam1 = familyService.getOrCreateUserFamily(uUserX.user.id);
      const { child: child1 } = childService.createChild(uUserX.user.id, 'Fam1 Child', 7, undefined, fam1.id);

      // Family 2 owned by User Y
      const uUserY = authService.register(`other-owner-${nanoid(6)}@safebrowse.io`, testPassword, 'User Y');
      authService.verifyEmail(uUserY.emailVerificationToken);
      const fam2 = familyService.getOrCreateUserFamily(uUserY.user.id);
      const { child: child2 } = childService.createChild(uUserY.user.id, 'Fam2 Child', 11, undefined, fam2.id);

      // User X joins Family 2 as VIEWER
      const inv2 = familyService.inviteParent(fam2.id, uUserY.user.id, uUserX.user.email, 'VIEWER');
      familyService.acceptInvitation(inv2.token, uUserX.user.id);

      // 1. User X accessing Child 1 (in Fam 1 where they are OWNER) -> Can delete child
      assert.strictEqual(rbacService.hasFamilyPermission(uUserX.user.id, fam1.id, FamilyPermission.CHILD_MANAGE), true);

      // 2. User X accessing Child 2 (in Fam 2 where they are VIEWER) -> CANNOT mutate policy or delete
      assert.strictEqual(rbacService.hasFamilyPermission(uUserX.user.id, fam2.id, FamilyPermission.CHILD_MANAGE), false);

      // Tenancy check: child1 familyId is fam1.id, child2 familyId is fam2.id
      const resolvedFam1 = rbacService.getFamilyForChild(child1.id);
      const resolvedFam2 = rbacService.getFamilyForChild(child2.id);
      assert.strictEqual(resolvedFam1?.id, fam1.id);
      assert.strictEqual(resolvedFam2?.id, fam2.id);

      // Try mutating Child 2 policy as User X (must return 403 Forbidden)
      const res = await makeRequest(
        'POST',
        `/api/policies/child/${child2.id}/pause`,
        { Authorization: `Bearer ${uUserX.accessToken}` },
        { isPaused: true }
      );
      assert.strictEqual(res.status, 403);
    });
  });

  describe('6. Permissions Alignment (Invitations & Audit Logs)', () => {
    it('should forbid PARENT from issuing invitations (OWNER only)', async () => {
      const uOwner = authService.register(`perm-owner-${nanoid(6)}@safebrowse.io`, testPassword, 'Perm Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);

      const inv = familyService.inviteParent(fam.id, uOwner.user.id, `perm-parent-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uParent = authService.register(inv.email, testPassword, 'Perm Parent');
      authService.verifyEmail(uParent.emailVerificationToken);
      familyService.acceptInvitation(inv.token, uParent.user.id);

      // Parent attempts to invite someone
      const res = await makeRequest(
        'POST',
        '/api/family/invitations',
        { Authorization: `Bearer ${uParent.accessToken}` },
        { familyId: fam.id, email: 'new-invite@safebrowse.io', role: 'VIEWER' }
      );
      assert.strictEqual(res.status, 403);
    });

    it('should forbid VIEWER from reading family audit logs', async () => {
      const uOwner = authService.register(`audit-owner-${nanoid(6)}@safebrowse.io`, testPassword, 'Audit Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);

      const inv = familyService.inviteParent(fam.id, uOwner.user.id, `audit-viewer-${nanoid(6)}@safebrowse.io`, 'VIEWER');
      const uViewer = authService.register(inv.email, testPassword, 'Audit Viewer');
      authService.verifyEmail(uViewer.emailVerificationToken);
      familyService.acceptInvitation(inv.token, uViewer.user.id);

      // Viewer attempts to read audit logs
      const res = await makeRequest('GET', '/api/family/audit', {
        Authorization: `Bearer ${uViewer.accessToken}`,
      });
      assert.strictEqual(res.status, 403);
    });
  });
});
