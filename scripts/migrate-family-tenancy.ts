#!/usr/bin/env ts-node

/**
 * SafeBrowse Stage 11 Step 3B: Explicit Legacy Family Tenancy Migration Script
 *
 * Requirements:
 * - Run explicitly before application startup;
 * - Generate dry-run report by default (use --apply or --execute to commit mutations);
 * - Resolve legacy records ONLY when exactly ONE family can be unambiguously proven;
 * - Quarantine ambiguous (2+ families) or orphaned (0 families) records;
 * - Never assign 'fam-default' or fabricated identifiers;
 * - Never silently rewrite conflicting familyId values;
 * - Create a backup before any mutations;
 * - Produce precise counts for migrated, unchanged, conflicted, and quarantined records;
 * - Idempotent across multiple runs.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface MigrationCounts {
  migrated: number;
  unchanged: number;
  conflicted: number;
  quarantined: number;
}

export interface MigrationReport {
  counts: MigrationCounts;
  details: string[];
  quarantinedRecords: Array<{ type: string; id: string; reason: string; record: any }>;
}

export function runMigration(storageFilePath?: string, applyChanges: boolean = false): MigrationReport {
  const rootDir = path.resolve(__dirname, '..');
  const storageFile = storageFilePath || path.join(rootDir, 'data', 'safebrowse-db.json');
  const quarantineFile = path.join(path.dirname(storageFile), 'quarantine.json');

  const report: MigrationReport = {
    counts: { migrated: 0, unchanged: 0, conflicted: 0, quarantined: 0 },
    details: [],
    quarantinedRecords: [],
  };

  if (!fs.existsSync(storageFile)) {
    report.details.push(`Storage file not found at ${storageFile}. No action taken.`);
    return report;
  }

  const raw = fs.readFileSync(storageFile, 'utf-8');
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Cannot parse datastore JSON: ${e.message}`);
  }

  const families: any[] = data.families || [];
  const familyMembers: any[] = data.familyMembers || [];
  const children: any[] = data.children || [];
  const devices: any[] = data.devices || [];
  const policies: any[] = data.policies || [];
  const pairingCodes: any[] = data.pairingCodes || [];
  const requests: any[] = data.requests || [];

  const familyIdsSet = new Set<string>(families.map((f: any) => f.id));

  // Helper: Find all proven families for a user ID
  function getProvenFamiliesForUser(userId: string): string[] {
    const owned = families.filter((f: any) => f.ownerUserId === userId).map((f: any) => f.id);
    const memberOf = familyMembers.filter((m: any) => m.userId === userId).map((m: any) => m.familyId);
    return Array.from(new Set([...owned, ...memberOf])).filter((fid) => familyIdsSet.has(fid));
  }

  const keptChildren: any[] = [];
  const childFamilyMap = new Map<string, string>(); // childId -> validated familyId

  // 1. Process Children
  for (const child of children) {
    if (child.familyId && child.familyId !== 'fam-default' && familyIdsSet.has(child.familyId)) {
      report.counts.unchanged++;
      keptChildren.push(child);
      childFamilyMap.set(child.id, child.familyId);
    } else {
      // Legacy or invalid familyId
      const proven = getProvenFamiliesForUser(child.parentId);
      if (proven.length === 1) {
        // Unambiguously proven
        child.familyId = proven[0];
        report.counts.migrated++;
        report.details.push(`[MIGRATED] Child '${child.id}' assigned to proven family '${proven[0]}'`);
        keptChildren.push(child);
        childFamilyMap.set(child.id, child.familyId);
      } else {
        // Ambiguous (>= 2) or orphaned (0)
        report.counts.quarantined++;
        const reason = proven.length === 0 ? 'Orphaned (parentId has 0 families)' : `Ambiguous (${proven.length} families found)`;
        report.details.push(`[QUARANTINED] Child '${child.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Child', id: child.id, reason, record: child });
      }
    }
  }

  // 2. Process Devices
  const keptDevices: any[] = [];
  for (const device of devices) {
    const provenChildFamily = childFamilyMap.get(device.childId);

    if (device.familyId && familyIdsSet.has(device.familyId)) {
      if (provenChildFamily && provenChildFamily !== device.familyId) {
        // Conflicting familyId! Never silently rewrite
        report.counts.conflicted++;
        report.counts.quarantined++;
        const reason = `Conflicting familyId: device has '${device.familyId}', but child has '${provenChildFamily}'`;
        report.details.push(`[CONFLICT & QUARANTINE] Device '${device.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Device', id: device.id, reason, record: device });
      } else {
        report.counts.unchanged++;
        keptDevices.push(device);
      }
    } else {
      // Missing or invalid familyId on device
      if (provenChildFamily) {
        device.familyId = provenChildFamily;
        report.counts.migrated++;
        report.details.push(`[MIGRATED] Device '${device.id}' assigned to child family '${provenChildFamily}'`);
        keptDevices.push(device);
      } else {
        report.counts.quarantined++;
        const reason = 'Orphaned (associated child not found or quarantined)';
        report.details.push(`[QUARANTINED] Device '${device.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Device', id: device.id, reason, record: device });
      }
    }
  }

  // 3. Process Policies
  const keptPolicies: any[] = [];
  for (const policy of policies) {
    const provenChildFamily = childFamilyMap.get(policy.childId);

    if (policy.familyId && familyIdsSet.has(policy.familyId)) {
      if (provenChildFamily && provenChildFamily !== policy.familyId) {
        report.counts.conflicted++;
        report.counts.quarantined++;
        const reason = `Conflicting familyId: policy has '${policy.familyId}', but child has '${provenChildFamily}'`;
        report.details.push(`[CONFLICT & QUARANTINE] Policy for child '${policy.childId}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Policy', id: policy.id || policy.childId, reason, record: policy });
      } else {
        report.counts.unchanged++;
        keptPolicies.push(policy);
      }
    } else {
      if (provenChildFamily) {
        policy.familyId = provenChildFamily;
        report.counts.migrated++;
        report.details.push(`[MIGRATED] Policy for child '${policy.childId}' assigned to family '${provenChildFamily}'`);
        keptPolicies.push(policy);
      } else {
        report.counts.quarantined++;
        const reason = 'Orphaned policy (associated child not found or quarantined)';
        report.details.push(`[QUARANTINED] Policy for child '${policy.childId}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Policy', id: policy.id || policy.childId, reason, record: policy });
      }
    }
  }

  // 4. Process Pairing Codes
  const keptPairingCodes: any[] = [];
  for (const code of pairingCodes) {
    const provenChildFamily = childFamilyMap.get(code.childId);
    if (code.familyId && familyIdsSet.has(code.familyId)) {
      report.counts.unchanged++;
      keptPairingCodes.push(code);
    } else if (provenChildFamily) {
      code.familyId = provenChildFamily;
      report.counts.migrated++;
      keptPairingCodes.push(code);
    } else {
      report.counts.quarantined++;
      report.quarantinedRecords.push({ type: 'PairingCode', id: code.code, reason: 'Orphaned pairing code', record: code });
    }
  }

  // 5. Process Access Requests
  const keptRequests: any[] = [];
  for (const req of requests) {
    const provenChildFamily = childFamilyMap.get(req.childId);
    if (req.familyId && familyIdsSet.has(req.familyId)) {
      report.counts.unchanged++;
      keptRequests.push(req);
    } else if (provenChildFamily) {
      req.familyId = provenChildFamily;
      report.counts.migrated++;
      keptRequests.push(req);
    } else {
      report.counts.quarantined++;
      report.quarantinedRecords.push({ type: 'AccessRequest', id: req.id, reason: 'Orphaned request', record: req });
    }
  }

  if (applyChanges) {
    // 1. Create pre-migration timestamped backup
    const backupPath = `${storageFile}.pre-migration.${Date.now()}.bak`;
    fs.copyFileSync(storageFile, backupPath);
    report.details.push(`[BACKUP] Created backup at ${backupPath}`);

    // 2. Save quarantined records if any
    if (report.quarantinedRecords.length > 0) {
      let existingQuarantine: any[] = [];
      if (fs.existsSync(quarantineFile)) {
        try {
          existingQuarantine = JSON.parse(fs.readFileSync(quarantineFile, 'utf-8'));
        } catch {}
      }
      const updatedQuarantine = [...existingQuarantine, ...report.quarantinedRecords];
      fs.writeFileSync(quarantineFile, JSON.stringify(updatedQuarantine, null, 2), 'utf-8');
      report.details.push(`[QUARANTINE FILE] Saved ${report.quarantinedRecords.length} records to ${quarantineFile}`);
    }

    // 3. Write updated data back to storageFile
    data.children = keptChildren;
    data.devices = keptDevices;
    data.policies = keptPolicies;
    data.pairingCodes = keptPairingCodes;
    data.requests = keptRequests;

    fs.writeFileSync(storageFile, JSON.stringify(data, null, 2), 'utf-8');
    report.details.push(`[APPLIED] Successfully wrote migrated datastore to ${storageFile}`);
  }

  return report;
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const applyChanges = args.includes('--apply') || args.includes('--execute');

  console.log(`\n=== SafeBrowse Family Tenancy Migration (${applyChanges ? 'APPLY MODE' : 'DRY RUN'}) ===\n`);

  try {
    const report = runMigration(undefined, applyChanges);

    console.log('Migration Counts Summary:');
    console.log(`  - Migrated:    ${report.counts.migrated}`);
    console.log(`  - Unchanged:   ${report.counts.unchanged}`);
    console.log(`  - Conflicted:  ${report.counts.conflicted}`);
    console.log(`  - Quarantined: ${report.counts.quarantined}`);

    if (report.details.length > 0) {
      console.log('\nDetails:');
      report.details.forEach((d) => console.log(`  ${d}`));
    }

    if (!applyChanges && (report.counts.migrated > 0 || report.counts.quarantined > 0)) {
      console.log('\n[INFO] This was a dry run. To apply mutations and backup, run:');
      console.log('       npx ts-node scripts/migrate-family-tenancy.ts --apply\n');
    } else {
      console.log('\n✅ Tenancy migration completed cleanly.\n');
    }
  } catch (err: any) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}
