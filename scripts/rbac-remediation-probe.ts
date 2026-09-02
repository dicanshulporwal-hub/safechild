/**
 * SafeBrowse Stage 11 Step 3A: RBAC Critical Remediation Adversarial Probe
 * Evaluates 8 security attack and isolation scenarios.
 *
 * Required output: All 8 metrics must evaluate strictly to `false`.
 */

import http from 'http';
import { app } from '../packages/backend/src/server';
import { db } from '../packages/backend/src/db/store';
import { authService } from '../packages/backend/src/services/auth.service';
import { familyService } from '../packages/backend/src/services/family.service';
import { childService } from '../packages/backend/src/services/child.service';
import { activityService } from '../packages/backend/src/services/activity.service';
import { profileService } from '../packages/backend/src/services/profile.service';
import { rbacService, FamilyPermission } from '../packages/backend/src/services/rbac.service';
import { generateTotpAtStep, getCurrentTotpTimeStep, decryptMfaSecret } from '../packages/backend/src/utils/security';
import { nanoid } from 'nanoid';

export interface RemediationProbeResults {
  ordinaryUserSelfPromotedToSystemAdmin: boolean;
  productionAdminBootstrapEnabled: boolean;
  recoveryCodeReusedForOwnershipTransfer: boolean;
  totpStepReusedForOwnershipTransfer: boolean;
  failedTransferLeftPartialMutation: boolean;
  concurrentTransferCreatedMultipleOwners: boolean;
  coParentActivityAccessDenied: boolean;
  multiFamilyResourceResolvedToWrongFamily: boolean;
}

async function runRemediationProbe(): Promise<RemediationProbeResults> {
  const server = http.createServer(app);
  let baseUrl = '';

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const request = async (
    method: string,
    endpoint: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ status: number; body: any }> => {
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
            let parsed = {};
            try {
              parsed = rawData ? JSON.parse(rawData) : {};
            } catch (e) {
              parsed = { raw: rawData };
            }
            resolve({ status: res.statusCode || 500, body: parsed });
          });
        }
      );

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  const results: RemediationProbeResults = {
    ordinaryUserSelfPromotedToSystemAdmin: true,
    productionAdminBootstrapEnabled: true,
    recoveryCodeReusedForOwnershipTransfer: true,
    totpStepReusedForOwnershipTransfer: true,
    failedTransferLeftPartialMutation: true,
    concurrentTransferCreatedMultipleOwners: true,
    coParentActivityAccessDenied: true,
    multiFamilyResourceResolvedToWrongFamily: true,
  };

  const testPass = 'SafeBrowse-Password-15Chars!';
  const devBootstrapSecret = 'test-secret-at-least-16-chars-long';
  process.env.ENABLE_DEV_ADMIN_BOOTSTRAP = 'true';
  process.env.DEV_ADMIN_BOOTSTRAP_SECRET = devBootstrapSecret;

  try {
    // --- Metric 1: ordinaryUserSelfPromotedToSystemAdmin ---
    const uOrdinary = authService.register(`ordinary-${nanoid(6)}@safebrowse.io`, testPass, 'Ordinary User');
    authService.verifyEmail(uOrdinary.emailVerificationToken);

    // Call bootstrap without secret
    const p1 = await request('POST', '/api/admin/bootstrap-dev', {
      Authorization: `Bearer ${uOrdinary.accessToken}`,
    });
    const refreshedUser = db.users.get(uOrdinary.user.id)!;
    results.ordinaryUserSelfPromotedToSystemAdmin = p1.status === 200 || refreshedUser.systemRole === 'SYSTEM_ADMIN';

    // --- Metric 2: productionAdminBootstrapEnabled ---
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const p2 = await request(
        'POST',
        '/api/admin/bootstrap-dev',
        {
          Authorization: `Bearer ${uOrdinary.accessToken}`,
          'x-admin-bootstrap-secret': devBootstrapSecret,
        },
        { bootstrapSecret: devBootstrapSecret }
      );
      results.productionAdminBootstrapEnabled = p2.status === 200;
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // --- Metric 3: recoveryCodeReusedForOwnershipTransfer ---
    const uOwner3 = authService.register(`owner3-${nanoid(6)}@safebrowse.io`, testPass, 'Owner 3');
    authService.verifyEmail(uOwner3.emailVerificationToken);
    const fam3 = familyService.getOrCreateUserFamily(uOwner3.user.id);

    // Setup MFA
    const setup3 = await profileService.setupMfa(uOwner3.user.id);
    const step3 = getCurrentTotpTimeStep();
    const otp3 = generateTotpAtStep(setup3.secret, step3);
    const mfa3 = profileService.verifyAndEnableMfa(uOwner3.user.id, otp3);
    const recoveryCode3 = mfa3.recoveryCodes[0];

    // Add target member
    const inv3 = familyService.inviteParent(fam3.id, uOwner3.user.id, `target3-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uTarget3 = authService.register(inv3.email, testPass, 'Target 3');
    authService.verifyEmail(uTarget3.emailVerificationToken);
    familyService.acceptInvitation(inv3.token, uTarget3.user.id);

    // Transfer 1 with recovery code (succeeds)
    const p3a = await request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner3.accessToken}` },
      { familyId: fam3.id, newOwnerUserId: uTarget3.user.id, password: testPass, otpCode: recoveryCode3 }
    );

    // Transfer back
    await familyService.transferOwnership(fam3.id, uOwner3.user.id, uTarget3.user.id, testPass);

    // Transfer 2 reusing recovery code (must fail)
    const p3b = await request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner3.accessToken}` },
      { familyId: fam3.id, newOwnerUserId: uTarget3.user.id, password: testPass, otpCode: recoveryCode3 }
    );
    results.recoveryCodeReusedForOwnershipTransfer = p3b.status === 200;

    // --- Metric 4: totpStepReusedForOwnershipTransfer ---
    const decSec = decryptMfaSecret(uOwner3.user.mfaSecret!);
    const currStep = getCurrentTotpTimeStep();
    const totpCode = generateTotpAtStep(decSec, currStep);

    // Transfer 1 with TOTP
    await request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner3.accessToken}` },
      { familyId: fam3.id, newOwnerUserId: uTarget3.user.id, password: testPass, otpCode: totpCode }
    );

    // Transfer back
    await familyService.transferOwnership(fam3.id, uOwner3.user.id, uTarget3.user.id, testPass);

    // Transfer 2 reusing EXACT TOTP in same timestep (must fail)
    const p4 = await request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner3.accessToken}` },
      { familyId: fam3.id, newOwnerUserId: uTarget3.user.id, password: testPass, otpCode: totpCode }
    );
    results.totpStepReusedForOwnershipTransfer = p4.status === 200;

    // --- Metric 5: failedTransferLeftPartialMutation ---
    const initialFam = db.families.get(fam3.id)!;
    const initialOwnerId = initialFam.ownerUserId;
    const initialMembers = JSON.stringify(Array.from(db.familyMembers.values()));

    // Transfer to invalid target
    await request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner3.accessToken}` },
      { familyId: fam3.id, newOwnerUserId: 'non-existent-user', password: testPass }
    );

    const postFam = db.families.get(fam3.id)!;
    const postMembers = JSON.stringify(Array.from(db.familyMembers.values()));
    results.failedTransferLeftPartialMutation =
      postFam.ownerUserId !== initialOwnerId || postMembers !== initialMembers;

    // --- Metric 6: concurrentTransferCreatedMultipleOwners ---
    const uOwner6 = authService.register(`owner6-${nanoid(6)}@safebrowse.io`, testPass, 'Owner 6');
    authService.verifyEmail(uOwner6.emailVerificationToken);
    const fam6 = familyService.getOrCreateUserFamily(uOwner6.user.id);

    const inv6a = familyService.inviteParent(fam6.id, uOwner6.user.id, `cand6a-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const u6a = authService.register(inv6a.email, testPass, '6A');
    authService.verifyEmail(u6a.emailVerificationToken);
    familyService.acceptInvitation(inv6a.token, u6a.user.id);

    const inv6b = familyService.inviteParent(fam6.id, uOwner6.user.id, `cand6b-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const u6b = authService.register(inv6b.email, testPass, '6B');
    authService.verifyEmail(u6b.emailVerificationToken);
    familyService.acceptInvitation(inv6b.token, u6b.user.id);

    // Simultaneous transfers
    const t1 = request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner6.accessToken}` },
      { familyId: fam6.id, newOwnerUserId: u6a.user.id, password: testPass }
    );
    const t2 = request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwner6.accessToken}` },
      { familyId: fam6.id, newOwnerUserId: u6b.user.id, password: testPass }
    );

    await Promise.all([t1, t2]);

    const fam6Owners = Array.from(db.familyMembers.values()).filter(
      (m) => m.familyId === fam6.id && m.role === 'OWNER'
    );
    const refreshedFam6 = db.families.get(fam6.id)!;
    results.concurrentTransferCreatedMultipleOwners =
      fam6Owners.length !== 1 || fam6Owners[0].userId !== refreshedFam6.ownerUserId;

    // --- Metric 7: coParentActivityAccessDenied ---
    const uOwner7 = authService.register(`owner7-${nanoid(6)}@safebrowse.io`, testPass, 'Owner 7');
    authService.verifyEmail(uOwner7.emailVerificationToken);
    const fam7 = familyService.getOrCreateUserFamily(uOwner7.user.id);
    const { child: child7 } = childService.createChild(uOwner7.user.id, 'Child 7', 9, undefined, fam7.id);

    activityService.logActivity(child7.id, 'dev-7', 'khanacademy.org', 'ALLOWED');

    const inv7 = familyService.inviteParent(fam7.id, uOwner7.user.id, `coparent7-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const u7 = authService.register(inv7.email, testPass, 'Coparent 7');
    authService.verifyEmail(u7.emailVerificationToken);
    familyService.acceptInvitation(inv7.token, u7.user.id);

    const actReq = await request('GET', `/api/activity/child/${child7.id}`, {
      Authorization: `Bearer ${u7.accessToken}`,
    });
    const statsReq = await request('GET', `/api/activity/stats/${child7.id}`, {
      Authorization: `Bearer ${u7.accessToken}`,
    });

    // If both succeeded (200), access was NOT denied -> false
    results.coParentActivityAccessDenied = actReq.status !== 200 || statsReq.status !== 200;

    // --- Metric 8: multiFamilyResourceResolvedToWrongFamily ---
    // User Multi belongs to Fam A (OWNER) and Fam B (VIEWER)
    const uMulti = authService.register(`multi-${nanoid(6)}@safebrowse.io`, testPass, 'Multi User');
    authService.verifyEmail(uMulti.emailVerificationToken);
    const famMultiA = familyService.getOrCreateUserFamily(uMulti.user.id);
    const { child: childMultiA } = childService.createChild(uMulti.user.id, 'Child Multi A', 6, undefined, famMultiA.id);

    const uOtherOwner = authService.register(`other-${nanoid(6)}@safebrowse.io`, testPass, 'Other Owner');
    authService.verifyEmail(uOtherOwner.emailVerificationToken);
    const famMultiB = familyService.getOrCreateUserFamily(uOtherOwner.user.id);
    const { child: childMultiB } = childService.createChild(uOtherOwner.user.id, 'Child Multi B', 12, undefined, famMultiB.id);

    // Multi User joins Fam B as VIEWER
    const invMultiB = familyService.inviteParent(famMultiB.id, uOtherOwner.user.id, uMulti.user.email, 'VIEWER');
    familyService.acceptInvitation(invMultiB.token, uMulti.user.id);

    // Check tenancy resolution
    const resFamA = rbacService.getFamilyForChild(childMultiA.id);
    const resFamB = rbacService.getFamilyForChild(childMultiB.id);

    const roleInFamA = rbacService.getUserFamilyRole(uMulti.user.id, famMultiA.id);
    const roleInFamB = rbacService.getUserFamilyRole(uMulti.user.id, famMultiB.id);

    // Attempt to mutate childMultiB policy as uMulti (must be rejected with 403 because VIEWER in Fam B)
    const mutRes = await request(
      'POST',
      `/api/policies/child/${childMultiB.id}/pause`,
      { Authorization: `Bearer ${uMulti.accessToken}` },
      { isPaused: true }
    );

    const resolvedCorrectly =
      resFamA?.id === famMultiA.id &&
      resFamB?.id === famMultiB.id &&
      roleInFamA === 'OWNER' &&
      roleInFamB === 'VIEWER' &&
      mutRes.status === 403;

    results.multiFamilyResourceResolvedToWrongFamily = !resolvedCorrectly;
  } finally {
    server.close();
  }

  return results;
}

runRemediationProbe()
  .then((results) => {
    console.log(JSON.stringify(results, null, 2));
    const allPassed = Object.values(results).every((v) => v === false);
    if (!allPassed) {
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('Probe execution error:', err);
    process.exit(1);
  });
