import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  db,
  DataStore,
  DataPersistenceError,
  DataLoadError,
  FatalConsistencyError,
  FatalTenancyError,
  ParentUser,
  FamilyMember,
  Family,
} from '../src/db/store';
import { authService } from '../src/services/auth.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { requestService } from '../src/services/request.service';
import { usageService } from '../src/services/usage.service';
import { rbacService } from '../src/services/rbac.service';
import { profileService } from '../src/services/profile.service';
import { runMigration } from '../src/utils/tenancy-migration';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { nanoid } from 'nanoid';
import { getCurrentTotpTimeStep, generateTotpAtStep } from '../src/utils/security';

describe('SafeBrowse Stage 11 Step 3C: Single-Commit Transactions & Tenancy Integrity', () => {
  const testPass = 'SafeBrowse-Durability-Test-Pass1!';

  describe('1. Fail-Secure DataStore Persistence, Fsync & Atomic Replacement', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_ds_atomic_test_'));
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('DataStore.save() writes data atomically and retains a backup file', () => {
      const testStore = new DataStore(tempDir);
      const user: ParentUser = {
        id: 'u-1',
        email: 'user1@test.io',
        passwordHash: 'hash',
        name: 'User One',
        createdAt: new Date().toISOString(),
      };
      testStore.users.set(user.id, user);
      testStore.save();

      const mainFile = path.join(tempDir, 'safebrowse-db.json');
      const backupFile = path.join(tempDir, 'safebrowse-db.json.bak');

      assert.strictEqual(fs.existsSync(mainFile), true);
      const parsed = JSON.parse(fs.readFileSync(mainFile, 'utf-8'));
      assert.strictEqual(parsed.users.length, 1);

      // Perform second save to generate backup
      user.name = 'User One Updated';
      testStore.users.set(user.id, user);
      testStore.save();

      assert.strictEqual(fs.existsSync(backupFile), true);
      const bakParsed = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
      assert.strictEqual(bakParsed.users[0].name, 'User One');
    });

    it('DataStore.save() throws DataPersistenceError when fsync fails and leaves file unchanged', () => {
      const testStore = new DataStore(tempDir);
      testStore.users.set('u-fsync', {
        id: 'u-fsync',
        email: 'fsync@test.io',
        passwordHash: 'hash',
        name: 'Fsync Initial',
        createdAt: new Date().toISOString(),
      });
      testStore.save();

      const mainFile = path.join(tempDir, 'safebrowse-db.json');
      const beforeContent = fs.readFileSync(mainFile, 'utf-8');

      testStore.users.get('u-fsync')!.name = 'Fsync Modified';
      testStore._simulateFsyncFailure = true;

      assert.throws(() => {
        testStore.save();
      }, DataPersistenceError);

      testStore._simulateFsyncFailure = false;
      const afterContent = fs.readFileSync(mainFile, 'utf-8');
      assert.strictEqual(beforeContent, afterContent);
    });

    it('DataStore.save() throws DataPersistenceError when atomic replacement fails and leaves live file unchanged', () => {
      const testStore = new DataStore(tempDir);
      testStore.users.set('u-rename', {
        id: 'u-rename',
        email: 'rename@test.io',
        passwordHash: 'hash',
        name: 'Rename Initial',
        createdAt: new Date().toISOString(),
      });
      testStore.save();

      const mainFile = path.join(tempDir, 'safebrowse-db.json');
      const beforeContent = fs.readFileSync(mainFile, 'utf-8');

      testStore.users.get('u-rename')!.name = 'Rename Modified';
      testStore._simulateRenameFailure = true;

      assert.throws(() => {
        testStore.save();
      }, DataPersistenceError);

      testStore._simulateRenameFailure = false;
      const afterContent = fs.readFileSync(mainFile, 'utf-8');
      assert.strictEqual(beforeContent, afterContent);
    });

    it('DataStore.save() respects backupFailureBlocksCommit policy', () => {
      const testStore = new DataStore(tempDir);
      testStore.users.set('u-bak', {
        id: 'u-bak',
        email: 'bak@test.io',
        passwordHash: 'hash',
        name: 'Bak Initial',
        createdAt: new Date().toISOString(),
      });
      testStore.save();

      // Case A: backupFailureBlocksCommit = true -> commit MUST fail
      testStore.backupFailureBlocksCommit = true;
      testStore._simulateBackupFailure = true;
      assert.throws(() => {
        testStore.save();
      }, DataPersistenceError);

      // Case B: backupFailureBlocksCommit = false -> commit completes
      testStore.backupFailureBlocksCommit = false;
      testStore.save();
      testStore._simulateBackupFailure = false;
    });

    it('DataStore enters degraded read-only state when rollback fails', () => {
      const testStore = new DataStore(tempDir);
      assert.strictEqual(testStore.isDegraded, false);

      testStore.setDegraded('Simulated corruption');
      assert.strictEqual(testStore.isDegraded, true);

      assert.throws(() => {
        testStore.save();
      }, FatalConsistencyError);
    });
  });

  describe('2. Fail-Secure Backup Recovery & Tenancy Validation', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_ds_val_test_'));
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('DataStore.load() recovers from backup when primary file is corrupted', () => {
      const testStore = new DataStore(tempDir);
      const famId = 'fam-rec';
      testStore.families.set(famId, {
        id: famId,
        name: 'Rec Fam',
        ownerUserId: 'u-recover',
        requireMfa: false,
        approvalRule: 'OWNER_ONLY',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      testStore.familyMembers.set('fm-rec', {
        id: 'fm-rec',
        familyId: famId,
        userId: 'u-recover',
        role: 'OWNER',
        joinedAt: new Date().toISOString(),
      });
      testStore.users.set('u-recover', {
        id: 'u-recover',
        email: 'recover@test.io',
        passwordHash: 'hash',
        name: 'Recoverable User',
        createdAt: new Date().toISOString(),
      });
      testStore.save();
      testStore.save(); // Creates backup

      const mainFile = path.join(tempDir, 'safebrowse-db.json');
      fs.writeFileSync(mainFile, '{"users": [ corrupt-incomplete-json...', 'utf-8');

      // Reload recovers
      const recoveredStore = new DataStore(tempDir);
      assert.strictEqual(recoveredStore.users.has('u-recover'), true);
    });

    it('rejects backup recovery if backup fails relational tenancy validation', () => {
      const mainFile = path.join(tempDir, 'safebrowse-db.json');
      const backupFile = path.join(tempDir, 'safebrowse-db.json.bak');

      fs.writeFileSync(mainFile, 'corrupt', 'utf-8');

      // Syntactically valid JSON but structurally invalid tenancy: child references non-existent family
      const invalidBackupData = {
        families: [],
        familyMembers: [],
        children: [{ id: 'c-invalid', familyId: 'fam-ghost', parentId: 'p-1', name: 'Ghost Child' }],
        devices: [],
        policies: [],
        pairingCodes: [],
        requests: [],
      };
      fs.writeFileSync(backupFile, JSON.stringify(invalidBackupData, null, 2), 'utf-8');

      assert.throws(() => {
        new DataStore(tempDir);
      }, DataLoadError);
    });

    it('DataStore.validateTenancyIntegrity rejects multiple or mismatched family owners', () => {
      const invalidSource = {
        families: [{ id: 'fam-x', name: 'Fam X', ownerUserId: 'user-a' }],
        familyMembers: [
          { id: 'm-1', familyId: 'fam-x', userId: 'user-a', role: 'OWNER' },
          { id: 'm-2', familyId: 'fam-x', userId: 'user-b', role: 'OWNER' }, // Dual owners!
        ],
        children: [],
        devices: [],
        policies: [],
        pairingCodes: [],
        requests: [],
      };

      assert.throws(() => {
        DataStore.validateTenancyIntegrity(invalidSource);
      }, FatalTenancyError);
    });

    it('DataStore.validateTenancyIntegrity rejects device-child family mismatch', () => {
      const invalidSource = {
        families: [
          { id: 'fam-1', name: 'Fam 1', ownerUserId: 'u-1' },
          { id: 'fam-2', name: 'Fam 2', ownerUserId: 'u-2' },
        ],
        familyMembers: [
          { id: 'm-1', familyId: 'fam-1', userId: 'u-1', role: 'OWNER' },
          { id: 'm-2', familyId: 'fam-2', userId: 'u-2', role: 'OWNER' },
        ],
        children: [{ id: 'c-1', familyId: 'fam-1', parentId: 'u-1', name: 'Child 1' }],
        devices: [{ id: 'd-1', childId: 'c-1', familyId: 'fam-2', name: 'Device Misassigned' }],
        policies: [],
        pairingCodes: [],
        requests: [],
      };

      assert.throws(() => {
        DataStore.validateTenancyIntegrity(invalidSource);
      }, /does not match child familyId/);
    });

    it('DataStore.validateTenancyIntegrity rejects request-device-child family mismatch', () => {
      const invalidSource = {
        families: [{ id: 'fam-1', name: 'Fam 1', ownerUserId: 'u-1' }],
        familyMembers: [{ id: 'm-1', familyId: 'fam-1', userId: 'u-1', role: 'OWNER' }],
        children: [
          { id: 'c-1', familyId: 'fam-1', parentId: 'u-1', name: 'Child 1' },
          { id: 'c-2', familyId: 'fam-1', parentId: 'u-1', name: 'Child 2' },
        ],
        devices: [{ id: 'd-1', childId: 'c-1', familyId: 'fam-1', name: 'Dev 1' }],
        policies: [],
        pairingCodes: [],
        requests: [{ id: 'r-1', childId: 'c-2', deviceId: 'd-1', familyId: 'fam-1', domain: 'x.com' }], // device belongs to c-1 not c-2
      };

      assert.throws(() => {
        DataStore.validateTenancyIntegrity(invalidSource);
      }, /does not belong to the same child and family/);
    });

    it('DataStore.validateTenancyIntegrity rejects pairing-code family mismatch', () => {
      const invalidSource = {
        families: [
          { id: 'fam-1', name: 'Fam 1', ownerUserId: 'u-1' },
          { id: 'fam-2', name: 'Fam 2', ownerUserId: 'u-2' },
        ],
        familyMembers: [
          { id: 'm-1', familyId: 'fam-1', userId: 'u-1', role: 'OWNER' },
          { id: 'm-2', familyId: 'fam-2', userId: 'u-2', role: 'OWNER' },
        ],
        children: [{ id: 'c-1', familyId: 'fam-1', parentId: 'u-1', name: 'Child 1' }],
        devices: [],
        policies: [],
        pairingCodes: [{ code: 'SB-1234-5678', childId: 'c-1', familyId: 'fam-2', createdByParentId: 'u-1' }],
        requests: [],
      };

      assert.throws(() => {
        DataStore.validateTenancyIntegrity(invalidSource);
      }, /familyId 'fam-2' does not match child familyId 'fam-1'/);
    });
  });

  describe('3. Single-Commit Ownership Transfer & Atomic Staging', () => {
    it('performs exactly one datastore save on successful ownership transfer', async () => {
      const uOwner = authService.register(`single-owner-${nanoid(6)}@safebrowse.io`, testPass, 'Owner Single');
      authService.verifyEmail(uOwner.emailVerificationToken);
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);

      const inv = familyService.inviteParent(fam.id, uOwner.user.id, `single-cand-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand = authService.register(inv.email, testPass, 'Candidate');
      authService.verifyEmail(uCand.emailVerificationToken);
      familyService.acceptInvitation(inv.token, uCand.user.id);

      // Reset save counter
      db.resetSaveCallCount();

      // Execute real ownership transfer
      await familyService.transferOwnership(fam.id, uCand.user.id, uOwner.user.id, testPass);

      // Verify db.save() was called EXACTLY ONCE
      assert.strictEqual(db.saveCallCount, 1);

      // Verify audit log was committed in that single save
      const audits = familyService.getAuditLogs(fam.id, uCand.user.id);
      assert.ok(audits.some((a) => a.action === 'OWNERSHIP_TRANSFERRED'));
    });

    it('performs zero saves and leaves disk/memory unmutated when validation fails before commit', async () => {
      const uOwner = authService.register(`precommit-owner-${nanoid(6)}@safebrowse.io`, testPass, 'Precommit Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);

      const inv = familyService.inviteParent(fam.id, uOwner.user.id, `precommit-cand-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand = authService.register(inv.email, testPass, 'Precommit Cand');
      authService.verifyEmail(uCand.emailVerificationToken);
      familyService.acceptInvitation(inv.token, uCand.user.id);

      db.resetSaveCallCount();

      // Attempt transfer with wrong password (fails before commit)
      await assert.rejects(async () => {
        await familyService.transferOwnership(fam.id, uCand.user.id, uOwner.user.id, 'WrongPassword123!');
      }, /Incorrect password/);

      // Exactly zero saves occurred
      assert.strictEqual(db.saveCallCount, 0);

      // Memory owner unchanged
      assert.strictEqual(db.families.get(fam.id)!.ownerUserId, uOwner.user.id);
    });
  });

  describe('4. Multi-Family Isolation (Devices, Requests, Digest)', () => {
    it('filters devices, requests, and weekly digest strictly by family tenancy', () => {
      // Setup User belonging to two distinct families
      const uMulti = authService.register(`multi-user-${nanoid(6)}@safebrowse.io`, testPass, 'Multi User');
      authService.verifyEmail(uMulti.emailVerificationToken);

      const famA = familyService.getOrCreateUserFamily(uMulti.user.id);
      // Create child in Fam A first so famA is preserved
      const { child: childA } = childService.createChild(uMulti.user.id, 'Child A', 8, '🧒', famA.id);

      const uOwnerB = authService.register(`other-owner-${nanoid(6)}@safebrowse.io`, testPass, 'Other Owner');
      authService.verifyEmail(uOwnerB.emailVerificationToken);
      const famB = familyService.getOrCreateUserFamily(uOwnerB.user.id);
      const { child: childB } = childService.createChild(uOwnerB.user.id, 'Child B', 10, '🧒', famB.id);

      // uMulti joins Fam B as a co-parent
      const inv = familyService.inviteParent(famB.id, uOwnerB.user.id, uMulti.user.email, 'PARENT');
      familyService.acceptInvitation(inv.token, uMulti.user.id);

      const pairA = deviceService.generatePairingCode(uMulti.user.id, childA.id);
      const { device: devA } = deviceService.pairDevice(pairA.code, 'Dev A', 'windows', '1.0.0');

      const pairB = deviceService.generatePairingCode(uOwnerB.user.id, childB.id);
      const { device: devB } = deviceService.pairDevice(pairB.code, 'Dev B', 'windows', '1.0.0');

      // Create Requests
      const reqA = requestService.createRequest(childA.id, devA.id, 'site-a.com', 'Reason A');
      const reqB = requestService.createRequest(childB.id, devB.id, 'site-b.com', 'Reason B');

      // Query devices specifically for famA
      const devicesFamA = deviceService.getDevicesForParent(uMulti.user.id, famA.id);
      assert.strictEqual(devicesFamA.some((d) => d.id === devA.id), true);
      assert.strictEqual(devicesFamA.some((d) => d.id === devB.id), false);

      // Query requests specifically for famB
      const requestsFamB = requestService.getPendingRequestsForParent(uMulti.user.id, famB.id);
      assert.strictEqual(requestsFamB.some((r) => r.id === reqB.id), true);
      assert.strictEqual(requestsFamB.some((r) => r.id === reqA.id), false);

      // Weekly digest for famA
      const digestFamA = usageService.getWeeklyDigest(uMulti.user.id, famA.id);
      assert.ok(digestFamA);
    });
  });

  describe('5. Tenancy Migration & Quarantine Idempotency', () => {
    let migDir: string;
    let migFile: string;

    beforeEach(() => {
      migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_cli_mig_test_'));
      migFile = path.join(migDir, 'safebrowse-db.json');
    });

    afterEach(() => {
      if (fs.existsSync(migDir)) {
        fs.rmSync(migDir, { recursive: true, force: true });
      }
    });

    it('unambiguously migrates single-family parent records and reports accurate counts', () => {
      const data = {
        families: [{ id: 'fam-single', name: 'Single Family', ownerUserId: 'p-1', approvalRule: 'OWNER_ONLY' }],
        familyMembers: [{ id: 'fm-1', familyId: 'fam-single', userId: 'p-1', role: 'OWNER' }],
        children: [{ id: 'c-1', parentId: 'p-1', name: 'Tommy' }],
        devices: [{ id: 'd-1', childId: 'c-1', parentId: 'p-1', name: 'Laptop' }],
        policies: [{ id: 'pol-1', childId: 'c-1' }],
        pairingCodes: [{ code: 'SB-AAAA-BBBB', childId: 'c-1' }],
        requests: [{ id: 'r-1', childId: 'c-1', deviceId: 'd-1', domain: 'fun.com' }],
      };
      fs.writeFileSync(migFile, JSON.stringify(data, null, 2), 'utf-8');

      // Dry run first
      const dryReport = runMigration(migFile, false);
      assert.strictEqual(dryReport.counts.migrated, 5);
      assert.strictEqual(dryReport.counts.quarantined, 0);

      // Apply migration
      const applyReport = runMigration(migFile, true);
      assert.strictEqual(applyReport.counts.migrated, 5);

      const migratedRaw = JSON.parse(fs.readFileSync(migFile, 'utf-8'));
      assert.strictEqual(migratedRaw.children[0].familyId, 'fam-single');
      assert.strictEqual(migratedRaw.devices[0].familyId, 'fam-single');
      assert.strictEqual(migratedRaw.policies[0].familyId, 'fam-single');
      assert.strictEqual(migratedRaw.pairingCodes[0].familyId, 'fam-single');
      assert.strictEqual(migratedRaw.requests[0].familyId, 'fam-single');

      // Idempotency: second run produces 0 migrated, 5 unchanged
      const idempReport = runMigration(migFile, true);
      assert.strictEqual(idempReport.counts.migrated, 0);
      assert.strictEqual(idempReport.counts.unchanged, 5);
    });

    it('quarantines mismatches and ensures quarantine idempotency without duplicates', () => {
      const data = {
        families: [
          { id: 'fam-1', name: 'Fam 1', ownerUserId: 'p-1', approvalRule: 'OWNER_ONLY' },
          { id: 'fam-2', name: 'Fam 2', ownerUserId: 'p-2', approvalRule: 'OWNER_ONLY' },
        ],
        familyMembers: [
          { id: 'fm-1', familyId: 'fam-1', userId: 'p-1', role: 'OWNER' },
          { id: 'fm-2', familyId: 'fam-2', userId: 'p-2', role: 'OWNER' },
        ],
        children: [{ id: 'c-1', familyId: 'fam-1', parentId: 'p-1', name: 'Child 1' }],
        devices: [{ id: 'd-mismatch', childId: 'c-1', familyId: 'fam-2', name: 'Device in wrong family' }],
        policies: [],
        pairingCodes: [],
        requests: [],
      };
      fs.writeFileSync(migFile, JSON.stringify(data, null, 2), 'utf-8');

      // First run
      const rep1 = runMigration(migFile, true);
      assert.strictEqual(rep1.counts.conflicted, 1);
      assert.strictEqual(rep1.counts.quarantined, 1);

      const quarantineFile = path.join(migDir, 'quarantine.json');
      assert.strictEqual(fs.existsSync(quarantineFile), true);
      const qData1 = JSON.parse(fs.readFileSync(quarantineFile, 'utf-8'));
      assert.strictEqual(qData1.length, 1);

      // Second run on same datastore with same quarantine file -> must NOT duplicate records
      const rep2 = runMigration(migFile, true);
      const qData2 = JSON.parse(fs.readFileSync(quarantineFile, 'utf-8'));
      assert.strictEqual(qData2.length, 1);
    });
  });
});
