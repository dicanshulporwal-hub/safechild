/**
 * SafeBrowse Stage 11 Step 3: Focused RBAC & Family Authorization Probe
 * Evaluates 11 direct security attack scenarios against system admin and family RBAC gates.
 *
 * Required output: All 11 metrics must evaluate strictly to `false`.
 */

import http from 'http';
import { app } from '../packages/backend/src/server';
import { db } from '../packages/backend/src/db/store';
import { authService } from '../packages/backend/src/services/auth.service';
import { familyService } from '../packages/backend/src/services/family.service';
import { childService } from '../packages/backend/src/services/child.service';
import { deviceService } from '../packages/backend/src/services/device.service';
import { rbacService } from '../packages/backend/src/services/rbac.service';
import { nanoid } from 'nanoid';

interface ProbeResults {
  parentAccessedSystemAdmin: boolean;
  familyOwnerTreatedAsSystemAdmin: boolean;
  viewerMutatedPolicy: boolean;
  viewerApprovedRequest: boolean;
  parentBypassedOwnerOnlyApproval: boolean;
  crossFamilyChildAccessed: boolean;
  crossFamilyDeviceAccessed: boolean;
  crossFamilyUsageChanged: boolean;
  finalOwnerRemoved: boolean;
  ownershipTransferredWithoutStepUp: boolean;
  invitationReused: boolean;
}

async function runRbacProbe(): Promise<ProbeResults> {
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

  const testPass = 'SafeBrowse-Password-15Chars!';

  // 1. Setup Family A: Owner, Parent, Viewer, Child, Device
  const uOwnerA = authService.register(`p-owner-a-${nanoid(6)}@safebrowse.io`, testPass, 'Owner A');
  authService.verifyEmail(uOwnerA.emailVerificationToken);
  const famA = familyService.getOrCreateUserFamily(uOwnerA.user.id);

  const { child: childA } = childService.createChild(uOwnerA.user.id, 'Child A', 10);
  const pairA = deviceService.generatePairingCode(uOwnerA.user.id, childA.id);
  const { device: devA } = deviceService.pairDevice(pairA.code, 'Dev A', 'windows', '1.0.0');

  const invParentA = familyService.inviteParent(famA.id, uOwnerA.user.id, `p-parent-a-${nanoid(6)}@safebrowse.io`, 'PARENT');
  const uParentA = authService.register(invParentA.email, testPass, 'Parent A');
  authService.verifyEmail(uParentA.emailVerificationToken);
  familyService.acceptInvitation(invParentA.token, uParentA.user.id);

  const invViewerA = familyService.inviteParent(famA.id, uOwnerA.user.id, `p-viewer-a-${nanoid(6)}@safebrowse.io`, 'VIEWER');
  const uViewerA = authService.register(invViewerA.email, testPass, 'Viewer A');
  authService.verifyEmail(uViewerA.emailVerificationToken);
  familyService.acceptInvitation(invViewerA.token, uViewerA.user.id);

  // 2. Setup Family B: Owner, Child
  const uOwnerB = authService.register(`p-owner-b-${nanoid(6)}@safebrowse.io`, testPass, 'Owner B');
  authService.verifyEmail(uOwnerB.emailVerificationToken);
  const { child: childB } = childService.createChild(uOwnerB.user.id, 'Child B', 12);

  // Results tracker
  const results: ProbeResults = {
    parentAccessedSystemAdmin: true,
    familyOwnerTreatedAsSystemAdmin: true,
    viewerMutatedPolicy: true,
    viewerApprovedRequest: true,
    parentBypassedOwnerOnlyApproval: true,
    crossFamilyChildAccessed: true,
    crossFamilyDeviceAccessed: true,
    crossFamilyUsageChanged: true,
    finalOwnerRemoved: true,
    ownershipTransferredWithoutStepUp: true,
    invitationReused: true,
  };

  try {
    // Probe 1: Normal Parent accesses System Admin
    const p1 = await request('GET', '/api/admin/metrics', {
      Authorization: `Bearer ${uParentA.accessToken}`,
    });
    results.parentAccessedSystemAdmin = p1.status === 200;

    // Probe 2: Family Owner treated as System Admin
    const p2 = await request('GET', '/api/admin/fleet', {
      Authorization: `Bearer ${uOwnerA.accessToken}`,
    });
    results.familyOwnerTreatedAsSystemAdmin = p2.status === 200;

    // Probe 3: Viewer mutates policy
    const p3 = await request(
      'POST',
      `/api/policies/child/${childA.id}/rules`,
      { Authorization: `Bearer ${uViewerA.accessToken}` },
      { domain: 'tiktok.com', action: 'BLOCK' }
    );
    results.viewerMutatedPolicy = p3.status === 200;

    // Probe 4: Viewer approves access request
    const devReq = await request(
      'POST',
      '/api/requests',
      { 'x-device-id': devA.id, 'x-device-token': devA.deviceToken },
      { domain: 'game.com', reason: 'fun' }
    );
    const reqId = devReq.body.id;

    const p4 = await request(
      'POST',
      `/api/requests/${reqId}/resolve`,
      { Authorization: `Bearer ${uViewerA.accessToken}` },
      { action: 'APPROVE', duration: '15m' }
    );
    results.viewerApprovedRequest = p4.status === 200;

    // Probe 5: Parent bypasses OWNER_ONLY approval rule
    await request(
      'PATCH',
      '/api/family',
      { Authorization: `Bearer ${uOwnerA.accessToken}` },
      { familyId: famA.id, approvalRule: 'OWNER_ONLY' }
    );
    const p5 = await request(
      'POST',
      `/api/requests/${reqId}/resolve`,
      { Authorization: `Bearer ${uParentA.accessToken}` },
      { action: 'APPROVE', duration: '15m' }
    );
    results.parentBypassedOwnerOnlyApproval = p5.status === 200;

    // Probe 6: Cross-Family Child Access (Parent A -> Child B)
    const p6 = await request('GET', `/api/children/${childB.id}`, {
      Authorization: `Bearer ${uParentA.accessToken}`,
    });
    results.crossFamilyChildAccessed = p6.status === 200;

    // Probe 7: Cross-Family Device Access (Owner B -> Device A diagnostics)
    const p7 = await request('POST', `/api/devices/${devA.id}/diagnostics`, {
      Authorization: `Bearer ${uOwnerB.accessToken}`,
    });
    results.crossFamilyDeviceAccessed = p7.status === 200;

    // Probe 8: Cross-Family Usage Budget Modification (Owner B -> Child A Budget)
    const p8 = await request(
      'POST',
      `/api/usage/child/${childA.id}/budget`,
      { Authorization: `Bearer ${uOwnerB.accessToken}` },
      { target: 'youtube.com', targetType: 'DOMAIN', dailyLimitMinutes: 10 }
    );
    results.crossFamilyUsageChanged = p8.status === 200;

    // Probe 9: Removal of Final Family Owner
    const memOwner = Array.from(db.familyMembers.values()).find(
      (m) => m.familyId === famA.id && m.userId === uOwnerA.user.id
    )!;
    const p9 = await request('DELETE', `/api/family/members/${memOwner.id}?familyId=${famA.id}`, {
      Authorization: `Bearer ${uOwnerA.accessToken}`,
    });
    results.finalOwnerRemoved = p9.status === 200;

    // Probe 10: Ownership Transfer Without Step-Up Auth
    const p10 = await request(
      'POST',
      '/api/family/transfer-ownership',
      { Authorization: `Bearer ${uOwnerA.accessToken}` },
      { familyId: famA.id, newOwnerUserId: uParentA.user.id } // No password provided
    );
    results.ownershipTransferredWithoutStepUp = p10.status === 200;

    // Probe 11: Single-Use Invitation Token Replay
    const testInv = familyService.inviteParent(famA.id, uOwnerA.user.id, `replay-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uReplay = authService.register(testInv.email, testPass, 'Replay User');
    authService.verifyEmail(uReplay.emailVerificationToken);

    // Accept once (valid)
    await request(
      'POST',
      '/api/family/invitations/accept',
      { Authorization: `Bearer ${uReplay.accessToken}` },
      { token: testInv.token }
    );
    // Attempt second accept (replay)
    const p11 = await request(
      'POST',
      '/api/family/invitations/accept',
      { Authorization: `Bearer ${uReplay.accessToken}` },
      { token: testInv.token }
    );
    results.invitationReused = p11.status === 200;
  } finally {
    server.close();
  }

  return results;
}

runRbacProbe()
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
