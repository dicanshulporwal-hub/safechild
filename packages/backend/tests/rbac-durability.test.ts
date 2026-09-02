import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { db, DataStore, DataPersistenceError, DataLoadError, ParentUser, FamilyMember, Family } from '../src/db/store';
import { authService } from '../src/services/auth.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { requestService } from '../src/services/request.service';
import { rbacService } from '../src/services/rbac.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { nanoid } from 'nanoid';

const findMigrationScript = () => {
  const candidates = [
    path.resolve(__dirname, '../../../../scripts/migrate-family-tenancy'),
    path.resolve(process.cwd(), 'scripts/migrate-family-tenancy'),
    path.resolve(process.cwd(), '../../scripts/migrate-family-tenancy'),
    path.resolve(__dirname, '../../../scripts/migrate-family-tenancy'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.ts') || fs.existsSync(c + '.js')) {
      return c;
    }
  }
  return candidates[0];
};

const { runMigration } = require(findMigrationScript());

describe('SafeBrowse Stage 11 Step 3B: Durable Transactions and Fail-Secure Tenancy', () => {
  const testPass = 'SafeBrowse-Durability-Test-Pass1!';

  describe('1. Fail-Secure DataStore Persistence & Load', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_ds_test_'));
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

    it('DataStore.load() recovers from backup when primary file is corrupted', () => {
      const testStore = new DataStore(tempDir);
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
      // Corrupt primary file
      fs.writeFileSync(mainFile, '{"users": [ corrupt-incomplete-json...', 'utf-8');

      // Reload
      const recoveredStore = new DataStore(tempDir);
      assert.strictEqual(recoveredStore.users.has('u-recover'), true);
    });

    it('DataStore.load() throws DataLoadError if primary is corrupt and no backup exists', () => {
      const mainFile = path.join(tempDir, 'safebrowse-db.json');
      fs.writeFileSync(mainFile, 'invalid json content', 'utf-8');

      assert.throws(() => {
        new DataStore(tempDir);
      }, DataLoadError);
    });

    it('DataStore.save() throws DataPersistenceError when writing fails', () => {
      const testStore = new DataStore(tempDir);
      testStore._simulateSaveFailure = true;

      assert.throws(() => {
        testStore.save();
      }, DataPersistenceError);

      testStore._simulateSaveFailure = false;
    });
  });

  describe('2. Fail-Secure Ownership Transfer Durability', () => {
    it('rolls back in-memory and on-disk state completely if save fails during transfer', async () => {
      const uOwner = authService.register(`owner-fail-${nanoid(6)}@safebrowse.io`, testPass, 'Owner');
      authService.verifyEmail(uOwner.emailVerificationToken);
      const fam = familyService.getOrCreateUserFamily(uOwner.user.id);

      const inv = familyService.inviteParent(fam.id, uOwner.user.id, `cand-fail-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand = authService.register(inv.email, testPass, 'Candidate');
      authService.verifyEmail(uCand.emailVerificationToken);
      familyService.acceptInvitation(inv.token, uCand.user.id);

      const ownerBefore = db.families.get(fam.id)!.ownerUserId;
      const auditsBefore = db.familyAuditLogs.filter((a) => a.familyId === fam.id).length;

      // Inject save failure
      db._simulateSaveFailure = true;

      let threw = false;
      try {
        await familyService.transferOwnership(fam.id, uCand.user.id, uOwner.user.id, testPass);
      } catch (e: any) {
        threw = true;
        assert.strictEqual(e instanceof DataPersistenceError || e.name === 'DataPersistenceError', true);
      } finally {
        db._simulateSaveFailure = false;
      }

      assert.strictEqual(threw, true);

      // Assert in-memory state remained completely untouched
      const famAfter = db.families.get(fam.id)!;
      assert.strictEqual(famAfter.ownerUserId, ownerBefore);

      const auditsAfter = db.familyAuditLogs.filter((a) => a.familyId === fam.id).length;
      assert.strictEqual(auditsAfter, auditsBefore);

      const memOwner = Array.from(db.familyMembers.values()).find((m) => m.familyId === fam.id && m.userId === uOwner.user.id)!;
      assert.strictEqual(memOwner.role, 'OWNER');

      const memCand = Array.from(db.familyMembers.values()).find((m) => m.familyId === fam.id && m.userId === uCand.user.id)!;
      assert.strictEqual(memCand.role, 'PARENT');
    });

    it('persists audit event atomically with ownership transfer and survives reload', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_restart_test_'));
      const testStore = new DataStore(tempDir);

      const uOwner: ParentUser = {
        id: `owner-surv-${nanoid(6)}`,
        email: `surv-${nanoid(6)}@safebrowse.io`,
        passwordHash: 'hash',
        name: 'Surviving Owner',
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      testStore.users.set(uOwner.id, uOwner);

      const fam: Family = {
        id: `fam-surv-${nanoid(6)}`,
        name: 'Surviving Family',
        ownerUserId: uOwner.id,
        requireMfa: false,
        approvalRule: 'OWNER_ONLY',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      testStore.families.set(fam.id, fam);

      const memOwner: FamilyMember = {
        id: `fm-surv-1`,
        familyId: fam.id,
        userId: uOwner.id,
        role: 'OWNER',
        joinedAt: new Date().toISOString(),
      };
      testStore.familyMembers.set(memOwner.id, memOwner);

      const uTarget: ParentUser = {
        id: `target-surv-${nanoid(6)}`,
        email: `target-surv-${nanoid(6)}@safebrowse.io`,
        passwordHash: 'hash',
        name: 'Target Parent',
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      testStore.users.set(uTarget.id, uTarget);

      const memTarget: FamilyMember = {
        id: `fm-surv-2`,
        familyId: fam.id,
        userId: uTarget.id,
        role: 'PARENT',
        joinedAt: new Date().toISOString(),
      };
      testStore.familyMembers.set(memTarget.id, memTarget);

      // Perform transfer
      memOwner.role = 'PARENT';
      memTarget.role = 'OWNER';
      fam.ownerUserId = uTarget.id;
      testStore.familyAuditLogs.push({
        id: 'fa-test-1',
        familyId: fam.id,
        actorUserId: uOwner.id,
        actorName: uOwner.name,
        action: 'OWNERSHIP_TRANSFERRED',
        details: 'Transferred',
        timestamp: new Date().toISOString(),
      });
      testStore.save();

      // Simulate complete backend restart
      const reloadedStore = new DataStore(tempDir);
      const reloadedFam = reloadedStore.families.get(fam.id)!;
      assert.strictEqual(reloadedFam.ownerUserId, uTarget.id);

      const audit = reloadedStore.familyAuditLogs.find(
        (a) => a.familyId === fam.id && a.action === 'OWNERSHIP_TRANSFERRED'
      );
      assert.notStrictEqual(audit, undefined);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('cross-family snapshot rollback does not undo another concurrent family transfer', async () => {
      // Family 1
      const uOwner1 = authService.register(`cross1-${nanoid(6)}@safebrowse.io`, testPass, 'Owner 1');
      authService.verifyEmail(uOwner1.emailVerificationToken);
      const fam1 = familyService.getOrCreateUserFamily(uOwner1.user.id);
      const inv1 = familyService.inviteParent(fam1.id, uOwner1.user.id, `crossCand1-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand1 = authService.register(inv1.email, testPass, 'Cand 1');
      authService.verifyEmail(uCand1.emailVerificationToken);
      familyService.acceptInvitation(inv1.token, uCand1.user.id);

      // Family 2
      const uOwner2 = authService.register(`cross2-${nanoid(6)}@safebrowse.io`, testPass, 'Owner 2');
      authService.verifyEmail(uOwner2.emailVerificationToken);
      const fam2 = familyService.getOrCreateUserFamily(uOwner2.user.id);
      const inv2 = familyService.inviteParent(fam2.id, uOwner2.user.id, `crossCand2-${nanoid(6)}@safebrowse.io`, 'PARENT');
      const uCand2 = authService.register(inv2.email, testPass, 'Cand 2');
      authService.verifyEmail(uCand2.emailVerificationToken);
      familyService.acceptInvitation(inv2.token, uCand2.user.id);

      // Successfully transfer Family 1
      await familyService.transferOwnership(fam1.id, uCand1.user.id, uOwner1.user.id, testPass);
      assert.strictEqual(db.families.get(fam1.id)!.ownerUserId, uCand1.user.id);

      // Now Family 2 transfer fails with bad credentials and triggers rollback
      let fam2Failed = false;
      try {
        await familyService.transferOwnership(fam2.id, uCand2.user.id, uOwner2.user.id, 'WrongPass!');
      } catch {
        fam2Failed = true;
      }
      assert.strictEqual(fam2Failed, true);

      // Family 1 must remain transferred to uCand1!
      assert.strictEqual(db.families.get(fam1.id)!.ownerUserId, uCand1.user.id);
      // Family 2 must remain with uOwner2
      assert.strictEqual(db.families.get(fam2.id)!.ownerUserId, uOwner2.user.id);
    });
  });

  describe('3. Mandatory Family Tenancy Enforcement', () => {
    it('rejects child creation without a valid familyId', () => {
      const u = authService.register(`user-nofam-${nanoid(6)}@safebrowse.io`, testPass, 'User');
      authService.verifyEmail(u.emailVerificationToken);

      assert.throws(() => {
        childService.createChild(u.user.id, 'NoFamChild', 10, undefined, '');
      }, /Valid familyId is required/);

      assert.throws(() => {
        childService.createChild(u.user.id, 'NoFamChild', 10, undefined, 'fam-non-existent');
      }, /Referenced family does not exist/);
    });

    it('rejects pairing code generation if child does not belong to a valid family', () => {
      const u = authService.register(`user-pair-${nanoid(6)}@safebrowse.io`, testPass, 'User');
      authService.verifyEmail(u.emailVerificationToken);

      assert.throws(() => {
        deviceService.generatePairingCode(u.user.id, 'non-existent-child');
      }, /Child must belong to a valid family/);
    });

    it('rejects access request creation if child has no valid family', () => {
      assert.throws(() => {
        requestService.createRequest('non-existent-child', 'some-device', 'games.com');
      }, /Child profile not found/);
    });

    it('strict rbacService tenancy resolution uses only validated resource.familyId without fallbacks', () => {
      const testChild = {
        id: `ch-orphan-${nanoid(6)}`,
        parentId: 'parent-with-no-family',
        familyId: '', // missing
        name: 'Orphan Child',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.children.set(testChild.id, testChild as any);

      const resolved = rbacService.getFamilyForChild(testChild.id);
      assert.strictEqual(resolved, undefined);

      db.children.delete(testChild.id);
    });
  });

  describe('4. Explicit Tenancy Migration CLI', () => {
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
        children: [{ id: 'c-1', parentId: 'p-1', name: 'Tommy' }], // missing familyId
        devices: [{ id: 'd-1', childId: 'c-1', parentId: 'p-1', name: 'Laptop' }], // missing familyId
        policies: [{ id: 'pol-1', childId: 'c-1' }], // missing familyId
        pairingCodes: [],
        requests: [],
      };
      fs.writeFileSync(migFile, JSON.stringify(data, null, 2), 'utf-8');

      // Dry run first
      const dryReport = runMigration(migFile, false);
      assert.strictEqual(dryReport.counts.migrated, 3); // child, device, policy
      assert.strictEqual(dryReport.counts.quarantined, 0);

      // File was not modified in dry-run
      const unmigratedRaw = JSON.parse(fs.readFileSync(migFile, 'utf-8'));
      assert.strictEqual(unmigratedRaw.children[0].familyId, undefined);

      // Apply migration
      const applyReport = runMigration(migFile, true);
      assert.strictEqual(applyReport.counts.migrated, 3);

      const migratedRaw = JSON.parse(fs.readFileSync(migFile, 'utf-8'));
      assert.strictEqual(migratedRaw.children[0].familyId, 'fam-single');
      assert.strictEqual(migratedRaw.devices[0].familyId, 'fam-single');
      assert.strictEqual(migratedRaw.policies[0].familyId, 'fam-single');

      // Idempotency: running migration again produces 0 migrated and 3 unchanged
      const idempReport = runMigration(migFile, true);
      assert.strictEqual(idempReport.counts.migrated, 0);
      assert.strictEqual(idempReport.counts.unchanged, 3);
    });

    it('quarantines ambiguous or orphaned records and creates quarantine.json', () => {
      const data = {
        families: [
          { id: 'fam-1', name: 'Fam 1', ownerUserId: 'p-multi', approvalRule: 'OWNER_ONLY' },
          { id: 'fam-2', name: 'Fam 2', ownerUserId: 'p-multi', approvalRule: 'OWNER_ONLY' },
        ],
        familyMembers: [
          { id: 'fm-1', familyId: 'fam-1', userId: 'p-multi', role: 'OWNER' },
          { id: 'fm-2', familyId: 'fam-2', userId: 'p-multi', role: 'OWNER' },
        ],
        children: [
          { id: 'c-ambig', parentId: 'p-multi', name: 'Child with ambiguous parent' },
          { id: 'c-orphan', parentId: 'p-unknown', name: 'Orphan Child' },
        ],
        devices: [],
        policies: [],
        pairingCodes: [],
        requests: [],
      };
      fs.writeFileSync(migFile, JSON.stringify(data, null, 2), 'utf-8');

      const report = runMigration(migFile, true);
      assert.strictEqual(report.counts.quarantined, 2);

      const quarantineFile = path.join(migDir, 'quarantine.json');
      assert.strictEqual(fs.existsSync(quarantineFile), true);

      const quarantined = JSON.parse(fs.readFileSync(quarantineFile, 'utf-8'));
      assert.strictEqual(quarantined.length, 2);
      assert.deepStrictEqual(quarantined.map((q: any) => q.id), ['c-ambig', 'c-orphan']);
    });
  });
});
