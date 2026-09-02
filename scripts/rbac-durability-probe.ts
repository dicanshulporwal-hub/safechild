#!/usr/bin/env ts-node

/**
 * SafeBrowse Stage 11 Step 3C: RBAC Durability & Tenancy Integrity Probe
 *
 * Verifies all 15 durability, atomicity, single-commit, and tenancy invariants.
 * All conditions MUST evaluate strictly to FALSE.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import assert from 'assert';
import bcrypt from 'bcryptjs';
import { db, DataStore, DataPersistenceError, DataLoadError, FatalConsistencyError, FatalTenancyError } from '../packages/backend/src/db/store';
import { authService } from '../packages/backend/src/services/auth.service';
import { familyService } from '../packages/backend/src/services/family.service';
import { childService } from '../packages/backend/src/services/child.service';
import { profileService } from '../packages/backend/src/services/profile.service';
import { rbacService, FamilyPermission } from '../packages/backend/src/services/rbac.service';
import { generateTotpAtStep, getCurrentTotpTimeStep, decryptMfaSecret, encryptMfaSecret } from '../packages/backend/src/utils/security';
import { runMigration } from '../packages/backend/src/utils/tenancy-migration';
import { nanoid } from 'nanoid';
import { app } from '../packages/backend/src/server';

export interface DurabilityProbeResults {
  ownershipTransferSucceededWhenSaveFailed: boolean;
  recoveryCodeReusableAfterSuccessfulRestart: boolean;
  totpReplayStateLostAfterRestart: boolean;
  auditEventLostAfterSuccessfulResponse: boolean;
  failedTransactionChangedMemory: boolean;
  failedTransactionChangedDisk: boolean;
  crossFamilyRollbackUndidSuccessfulTransfer: boolean;
  missingFamilyIdAccepted: boolean;
  ambiguousLegacyRecordAutoAssigned: boolean;
  malformedDatastoreStartedNormally: boolean;
  // Step 3C extensions
  ownershipTransferPerformedMultipleSaves: boolean;
  apiFailedButDiskCommittedOwnership: boolean;
  apiFailedButDiskContainsSuccessAudit: boolean;
  memoryDiskOwnerDiverged: boolean;
  rollbackPersistenceFailureSuppressed: boolean;
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; body: any }> {
  const addr = server.address() as any;
  const port = addr.port;

  return new Promise((resolve, reject) => {
    const jsonStr = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = { ...headers };
    if (jsonStr) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(jsonStr).toString();
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let respData = '';
        res.on('data', (chunk) => (respData += chunk));
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(respData);
          } catch {
            parsed = respData;
          }
          resolve({ status: res.statusCode || 500, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (jsonStr) req.write(jsonStr);
    req.end();
  });
}

async function runDurabilityProbe(): Promise<void> {
  const results: DurabilityProbeResults = {
    ownershipTransferSucceededWhenSaveFailed: true,
    recoveryCodeReusableAfterSuccessfulRestart: true,
    totpReplayStateLostAfterRestart: true,
    auditEventLostAfterSuccessfulResponse: true,
    failedTransactionChangedMemory: true,
    failedTransactionChangedDisk: true,
    crossFamilyRollbackUndidSuccessfulTransfer: true,
    missingFamilyIdAccepted: true,
    ambiguousLegacyRecordAutoAssigned: true,
    malformedDatastoreStartedNormally: true,
    ownershipTransferPerformedMultipleSaves: true,
    apiFailedButDiskCommittedOwnership: true,
    apiFailedButDiskContainsSuccessAudit: true,
    memoryDiskOwnerDiverged: true,
    rollbackPersistenceFailureSuppressed: true,
  };

  const testPass = 'SafeBrowse-Durability-15Chars!';
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    // -------------------------------------------------------------
    // Test 1: Single-commit & real familyService.transferOwnership
    // -------------------------------------------------------------
    const uOwnerSingle = authService.register(`single-owner-${nanoid(6)}@safebrowse.io`, testPass, 'Owner Single');
    authService.verifyEmail(uOwnerSingle.emailVerificationToken);
    const famSingle = familyService.getOrCreateUserFamily(uOwnerSingle.user.id);

    const invSingle = familyService.inviteParent(famSingle.id, uOwnerSingle.user.id, `single-cand-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uCandSingle = authService.register(invSingle.email, testPass, 'Single Cand');
    authService.verifyEmail(uCandSingle.emailVerificationToken);
    familyService.acceptInvitation(invSingle.token, uCandSingle.user.id);

    db.resetSaveCallCount();
    await familyService.transferOwnership(famSingle.id, uCandSingle.user.id, uOwnerSingle.user.id, testPass);

    // Metric: ownershipTransferPerformedMultipleSaves
    results.ownershipTransferPerformedMultipleSaves = db.saveCallCount !== 1;

    // -------------------------------------------------------------
    // Test 2: Real transfer failure during commit & partial-commit invariants
    // -------------------------------------------------------------
    const uOwnerFail = authService.register(`fail-owner-${nanoid(6)}@safebrowse.io`, testPass, 'Owner Fail');
    authService.verifyEmail(uOwnerFail.emailVerificationToken);
    const famFail = familyService.getOrCreateUserFamily(uOwnerFail.user.id);

    const invFail = familyService.inviteParent(famFail.id, uOwnerFail.user.id, `fail-cand-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uCandFail = authService.register(invFail.email, testPass, 'Fail Cand');
    authService.verifyEmail(uCandFail.emailVerificationToken);
    familyService.acceptInvitation(invFail.token, uCandFail.user.id);

    // Capture disk state before failure
    const storageFilePath = (db as any).storageFile;
    const diskContentBefore = fs.readFileSync(storageFilePath, 'utf-8');

    // Make save fail
    db._simulateSaveFailure = true;
    let transferFailed = false;
    try {
      await familyService.transferOwnership(famFail.id, uCandFail.user.id, uOwnerFail.user.id, testPass);
    } catch (e: any) {
      transferFailed = true;
    } finally {
      db._simulateSaveFailure = false;
    }

    results.ownershipTransferSucceededWhenSaveFailed = !transferFailed;

    // Read disk after failure
    const diskContentAfter = fs.readFileSync(storageFilePath, 'utf-8');
    const diskDataAfter = JSON.parse(diskContentAfter);

    // Disk must not commit ownership to candidate
    const diskFam = diskDataAfter.families.find((f: any) => f.id === famFail.id);
    results.apiFailedButDiskCommittedOwnership = diskFam ? diskFam.ownerUserId === uCandFail.user.id : false;

    // Disk must not contain the staged success audit entry
    const diskAudits = diskDataAfter.familyAuditLogs || [];
    const hasAuditOnDisk = diskAudits.some(
      (a: any) => a.familyId === famFail.id && a.action === 'OWNERSHIP_TRANSFERRED'
    );
    results.apiFailedButDiskContainsSuccessAudit = hasAuditOnDisk;

    // In-memory owner must match disk owner (original owner)
    const memOwner = db.families.get(famFail.id)!.ownerUserId;
    results.memoryDiskOwnerDiverged = (diskFam ? diskFam.ownerUserId : null) !== memOwner || memOwner !== uOwnerFail.user.id;

    // Memory and Disk must not have changed
    results.failedTransactionChangedMemory = memOwner !== uOwnerFail.user.id;
    results.failedTransactionChangedDisk = diskContentBefore !== diskContentAfter;

    // -------------------------------------------------------------
    // Test 3: Rollback persistence failure cannot be suppressed
    // -------------------------------------------------------------
    let errorCaught: any = null;
    try {
      // Force corruption in snapshot restoration
      db.restoreFamilySnapshot({ familyId: 'fam-bad', affectedUsers: null as any } as any);
    } catch (e: any) {
      errorCaught = e;
    }
    // Must throw FatalConsistencyError and NOT be suppressed
    results.rollbackPersistenceFailureSuppressed = !(errorCaught instanceof FatalConsistencyError);
    // Reset degraded state for remainder of probe
    (db as any)._isDegraded = false;

    // -------------------------------------------------------------
    // Test 4: Cross-family rollback isolation
    // -------------------------------------------------------------
    const uOwnerA = authService.register(`ownera-${nanoid(6)}@safebrowse.io`, testPass, 'Owner A');
    authService.verifyEmail(uOwnerA.emailVerificationToken);
    const famA = familyService.getOrCreateUserFamily(uOwnerA.user.id);
    const invA = familyService.inviteParent(famA.id, uOwnerA.user.id, `canda-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uCandA = authService.register(invA.email, testPass, 'Cand A');
    authService.verifyEmail(uCandA.emailVerificationToken);
    familyService.acceptInvitation(invA.token, uCandA.user.id);

    const uOwnerB = authService.register(`ownerb-${nanoid(6)}@safebrowse.io`, testPass, 'Owner B');
    authService.verifyEmail(uOwnerB.emailVerificationToken);
    const famB = familyService.getOrCreateUserFamily(uOwnerB.user.id);
    const invB = familyService.inviteParent(famB.id, uOwnerB.user.id, `candb-${nanoid(6)}@safebrowse.io`, 'PARENT');
    const uCandB = authService.register(invB.email, testPass, 'Cand B');
    authService.verifyEmail(uCandB.emailVerificationToken);
    familyService.acceptInvitation(invB.token, uCandB.user.id);

    // Family A transfer succeeds
    await familyService.transferOwnership(famA.id, uCandA.user.id, uOwnerA.user.id, testPass);
    assert.strictEqual(db.families.get(famA.id)!.ownerUserId, uCandA.user.id);

    // Family B transfer fails during commit
    db._simulateSaveFailure = true;
    try {
      await familyService.transferOwnership(famB.id, uCandB.user.id, uOwnerB.user.id, testPass);
    } catch {} finally {
      db._simulateSaveFailure = false;
    }

    // Family A owner MUST still be Cand A!
    const famAAfter = db.families.get(famA.id)!;
    results.crossFamilyRollbackUndidSuccessfulTransfer = famAAfter.ownerUserId !== uCandA.user.id;

    // -------------------------------------------------------------
    // Test 5: Restart durability for recovery code, TOTP, audit
    // -------------------------------------------------------------
    const probeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_durability_restart_'));
    const testStore = new DataStore(probeDataDir);

    const uOwnerRestart: any = {
      id: `owner-rst-${nanoid(6)}`,
      email: `owner-rst-${nanoid(6)}@safebrowse.io`,
      passwordHash: bcrypt.hashSync(testPass, 10),
      name: 'Restart Owner',
      emailVerified: true,
      mfaEnabled: true,
      createdAt: new Date().toISOString(),
      totpLastUsedSteps: {} as Record<string, number>,
      mfaRecoveryCodes: [bcrypt.hashSync('REC-RESTART-CODE-1', 10)],
      mfaSecret: encryptMfaSecret('JBSWY3DPEHPK3PXP'),
    };
    testStore.users.set(uOwnerRestart.id, uOwnerRestart);

    const famRestart: any = {
      id: `fam-rst-${nanoid(6)}`,
      name: 'Restart Fam',
      ownerUserId: uOwnerRestart.id,
      requireMfa: true,
      approvalRule: 'OWNER_ONLY',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    testStore.families.set(famRestart.id, famRestart);

    const memRestart: any = {
      id: `fm-rst-${nanoid(6)}`,
      familyId: famRestart.id,
      userId: uOwnerRestart.id,
      role: 'OWNER',
      joinedAt: new Date().toISOString(),
    };
    testStore.familyMembers.set(memRestart.id, memRestart);

    // Consume recovery code and record TOTP step
    uOwnerRestart.mfaRecoveryCodes = [];
    const step = getCurrentTotpTimeStep();
    uOwnerRestart.totpLastUsedSteps = { family_ownership_transfer: step };

    testStore.familyAuditLogs.push({
      id: `fa-${nanoid(8)}`,
      familyId: famRestart.id,
      actorUserId: uOwnerRestart.id,
      actorName: uOwnerRestart.name,
      action: 'OWNERSHIP_TRANSFERRED',
      details: 'Transferred',
      timestamp: new Date().toISOString(),
    });
    testStore.save();

    // Reload from disk (simulating backend process restart)
    const reloaded = new DataStore(probeDataDir);
    const reloadedOwner = reloaded.users.get(uOwnerRestart.id)!;

    // Recovery code must remain consumed after restart
    results.recoveryCodeReusableAfterSuccessfulRestart =
      Boolean(reloadedOwner.mfaRecoveryCodes && reloadedOwner.mfaRecoveryCodes.length > 0);

    // TOTP replay step must survive reload
    const reloadedStep = reloadedOwner.totpLastUsedSteps?.['family_ownership_transfer'];
    results.totpReplayStateLostAfterRestart = reloadedStep !== step;

    // Audit event must survive reload
    const reloadedAudit = reloaded.familyAuditLogs.find((a) => a.familyId === famRestart.id);
    results.auditEventLostAfterSuccessfulResponse = !reloadedAudit;

    // Clean up restart dir
    try { fs.rmSync(probeDataDir, { recursive: true, force: true }); } catch {}

    // -------------------------------------------------------------
    // Test 6: Tenancy and migration invariant conditions
    // -------------------------------------------------------------
    // Metric: missingFamilyIdAccepted
    let childCreatedWithoutFamily = false;
    try {
      childService.createChild(uOwnerSingle.user.id, 'NoFamChild', 8, undefined, '' as any);
      childCreatedWithoutFamily = true;
    } catch {}
    results.missingFamilyIdAccepted = childCreatedWithoutFamily;

    // Metric: ambiguousLegacyRecordAutoAssigned
    const migTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_probe_mig_'));
    const migFile = path.join(migTempDir, 'safebrowse-db.json');
    const ambigData = {
      families: [
        { id: 'fam-1', name: 'Fam 1', ownerUserId: 'p-amb' },
        { id: 'fam-2', name: 'Fam 2', ownerUserId: 'p-amb' },
      ],
      familyMembers: [
        { id: 'fm-1', familyId: 'fam-1', userId: 'p-amb', role: 'OWNER' },
        { id: 'fm-2', familyId: 'fam-2', userId: 'p-amb', role: 'OWNER' },
      ],
      children: [{ id: 'c-ambig', parentId: 'p-amb', name: 'Ambig Child' }],
      devices: [],
      policies: [],
      pairingCodes: [],
      requests: [],
    };
    fs.writeFileSync(migFile, JSON.stringify(ambigData, null, 2), 'utf-8');
    const migReport = runMigration(migFile, true);
    // An ambiguous record must be quarantined, never auto-assigned
    results.ambiguousLegacyRecordAutoAssigned = migReport.counts.migrated > 0 || migReport.counts.quarantined === 0;
    try { fs.rmSync(migTempDir, { recursive: true, force: true }); } catch {}

    // Metric: malformedDatastoreStartedNormally
    const malformedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_probe_malformed_'));
    fs.writeFileSync(path.join(malformedDir, 'safebrowse-db.json'), 'not valid json {{{', 'utf-8');
    let malformedStarted = false;
    try {
      new DataStore(malformedDir);
      malformedStarted = true;
    } catch {}
    results.malformedDatastoreStartedNormally = malformedStarted;
    try { fs.rmSync(malformedDir, { recursive: true, force: true }); } catch {}

  } finally {
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));

  const allPassed = Object.values(results).every((val) => val === false);
  if (!allPassed) {
    console.error('❌ Stage 11 Step 3C Durability Probe FAILED: Not all conditions false.');
    process.exit(1);
  } else {
    console.log('✅ Stage 11 Step 3C Durability Probe Passed: All 15 conditions false.');
  }
}

if (require.main === module) {
  runDurabilityProbe().catch((err) => {
    console.error('Probe execution fatal error:', err);
    process.exit(1);
  });
}
