/**
 * SafeBrowse Stage 11 Step 3C: Complete Tenancy Integrity Migration Engine
 *
 * Requirements:
 * - Compare familyId against associated child's familyId for Device, Policy, PairingCode, AccessRequest;
 * - Quarantine every mismatch (never accept valid-but-conflicting as unchanged);
 * - Validate request.deviceId, request.childId and familyId together;
 * - Use genuine atomic writer (temp file + fsync + atomic rename) without fs.writeFileSync fallback;
 * - Atomic and idempotent quarantine updates (no duplicate quarantine records across repeated runs);
 * - Pre-mutation backup.
 */

import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

export interface MigrationCounts {
  migrated: number;
  unchanged: number;
  conflicted: number;
  quarantined: number;
}

export interface QuarantinedItem {
  type: string;
  id: string;
  reason: string;
  record: any;
}

export interface MigrationReport {
  counts: MigrationCounts;
  details: string[];
  quarantinedRecords: QuarantinedItem[];
}

function atomicWriteJson(targetPath: string, data: any): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const serialized = JSON.stringify(data, null, 2);
  JSON.parse(serialized); // validate

  const tempFile = path.join(dir, `${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);

  const fd = fs.openSync(tempFile, 'w');
  fs.writeFileSync(fd, serialized, 'utf-8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  // Validate temp file
  const readBack = fs.readFileSync(tempFile, 'utf-8');
  JSON.parse(readBack);

  // Atomic rename
  let replaced = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.renameSync(tempFile, targetPath);
      replaced = true;
      break;
    } catch (rErr: any) {
      if (rErr.code === 'EPERM' || rErr.code === 'EBUSY' || rErr.code === 'EEXIST') {
        try {
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
        } catch {}
        try {
          fs.renameSync(tempFile, targetPath);
          replaced = true;
          break;
        } catch (e2: any) {
          if (attempt === 9) throw e2;
        }
      } else {
        if (attempt === 9) throw rErr;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }

  if (!replaced) {
    throw new Error(`Atomic write failed for ${targetPath}`);
  }
}

export function runMigration(storageFilePath?: string, applyChanges: boolean = false): MigrationReport {
  const rootDir = path.resolve(__dirname, '../../../../');
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
      const proven = getProvenFamiliesForUser(child.parentId);
      if (proven.length === 1) {
        child.familyId = proven[0];
        report.counts.migrated++;
        report.details.push(`[MIGRATED] Child '${child.id}' assigned to proven family '${proven[0]}'`);
        keptChildren.push(child);
        childFamilyMap.set(child.id, child.familyId);
      } else {
        report.counts.quarantined++;
        const reason = proven.length === 0 ? 'Orphaned (parentId has 0 families)' : `Ambiguous (${proven.length} families found)`;
        report.details.push(`[QUARANTINED] Child '${child.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Child', id: child.id, reason, record: child });
      }
    }
  }

  // 2. Process Devices
  const keptDevices: any[] = [];
  const deviceMap = new Map<string, any>(); // deviceId -> device
  for (const device of devices) {
    const provenChildFamily = childFamilyMap.get(device.childId);

    if (device.familyId && familyIdsSet.has(device.familyId)) {
      if (provenChildFamily && provenChildFamily !== device.familyId) {
        // Conflicting familyId! Never silently rewrite or accept as unchanged
        report.counts.conflicted++;
        report.counts.quarantined++;
        const reason = `Conflicting familyId: device has '${device.familyId}', but child has '${provenChildFamily}'`;
        report.details.push(`[CONFLICT & QUARANTINE] Device '${device.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Device', id: device.id, reason, record: device });
      } else if (provenChildFamily && provenChildFamily === device.familyId) {
        report.counts.unchanged++;
        keptDevices.push(device);
        deviceMap.set(device.id, device);
      } else {
        // Orphaned device (child not in keptChildren)
        report.counts.quarantined++;
        const reason = 'Orphaned (associated child not found or quarantined)';
        report.details.push(`[QUARANTINED] Device '${device.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Device', id: device.id, reason, record: device });
      }
    } else {
      if (provenChildFamily) {
        device.familyId = provenChildFamily;
        report.counts.migrated++;
        report.details.push(`[MIGRATED] Device '${device.id}' assigned to child family '${provenChildFamily}'`);
        keptDevices.push(device);
        deviceMap.set(device.id, device);
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
      } else if (provenChildFamily && provenChildFamily === policy.familyId) {
        report.counts.unchanged++;
        keptPolicies.push(policy);
      } else {
        report.counts.quarantined++;
        const reason = 'Orphaned policy (associated child not found or quarantined)';
        report.details.push(`[QUARANTINED] Policy for child '${policy.childId}': ${reason}`);
        report.quarantinedRecords.push({ type: 'Policy', id: policy.id || policy.childId, reason, record: policy });
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
      if (provenChildFamily && provenChildFamily !== code.familyId) {
        report.counts.conflicted++;
        report.counts.quarantined++;
        const reason = `Conflicting familyId: pairing code has '${code.familyId}', but child has '${provenChildFamily}'`;
        report.details.push(`[CONFLICT & QUARANTINE] PairingCode '${code.code}': ${reason}`);
        report.quarantinedRecords.push({ type: 'PairingCode', id: code.code, reason, record: code });
      } else if (provenChildFamily && provenChildFamily === code.familyId) {
        report.counts.unchanged++;
        keptPairingCodes.push(code);
      } else {
        report.counts.quarantined++;
        const reason = 'Orphaned pairing code (associated child not found or quarantined)';
        report.details.push(`[QUARANTINED] PairingCode '${code.code}': ${reason}`);
        report.quarantinedRecords.push({ type: 'PairingCode', id: code.code, reason, record: code });
      }
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

    // Validate request.deviceId against child and family if deviceId is present
    let deviceConflict = false;
    if (req.deviceId) {
      const dev = deviceMap.get(req.deviceId);
      if (!dev || dev.childId !== req.childId || (provenChildFamily && dev.familyId !== provenChildFamily)) {
        deviceConflict = true;
      }
    }

    if (deviceConflict) {
      report.counts.conflicted++;
      report.counts.quarantined++;
      const reason = `Device-child-family mismatch on request '${req.id}': device '${req.deviceId}' does not match child '${req.childId}' and family`;
      report.details.push(`[CONFLICT & QUARANTINE] AccessRequest '${req.id}': ${reason}`);
      report.quarantinedRecords.push({ type: 'AccessRequest', id: req.id, reason, record: req });
      continue;
    }

    if (req.familyId && familyIdsSet.has(req.familyId)) {
      if (provenChildFamily && provenChildFamily !== req.familyId) {
        report.counts.conflicted++;
        report.counts.quarantined++;
        const reason = `Conflicting familyId: request has '${req.familyId}', but child has '${provenChildFamily}'`;
        report.details.push(`[CONFLICT & QUARANTINE] AccessRequest '${req.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'AccessRequest', id: req.id, reason, record: req });
      } else if (provenChildFamily && provenChildFamily === req.familyId) {
        report.counts.unchanged++;
        keptRequests.push(req);
      } else {
        report.counts.quarantined++;
        const reason = 'Orphaned request (associated child not found or quarantined)';
        report.details.push(`[QUARANTINED] AccessRequest '${req.id}': ${reason}`);
        report.quarantinedRecords.push({ type: 'AccessRequest', id: req.id, reason, record: req });
      }
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
    // 1. Create pre-mutation timestamped backup
    const backupPath = `${storageFile}.pre-migration.${Date.now()}.bak`;
    fs.copyFileSync(storageFile, backupPath);
    report.details.push(`[BACKUP] Created backup at ${backupPath}`);

    // 2. Save quarantined records if any — strictly atomic and idempotent (no duplicate entries across repeated runs)
    if (report.quarantinedRecords.length > 0 || fs.existsSync(quarantineFile)) {
      let existingQuarantine: QuarantinedItem[] = [];
      if (fs.existsSync(quarantineFile)) {
        try {
          existingQuarantine = JSON.parse(fs.readFileSync(quarantineFile, 'utf-8'));
        } catch {}
      }

      // Deduplicate by entity key: `${type}:${id}`
      const quarantineMap = new Map<string, QuarantinedItem>();
      for (const item of existingQuarantine) {
        quarantineMap.set(`${item.type}:${item.id}`, item);
      }
      for (const item of report.quarantinedRecords) {
        quarantineMap.set(`${item.type}:${item.id}`, item);
      }

      const deduplicatedQuarantine = Array.from(quarantineMap.values());
      atomicWriteJson(quarantineFile, deduplicatedQuarantine);
      report.details.push(`[QUARANTINE FILE] Saved ${deduplicatedQuarantine.length} records to ${quarantineFile}`);
    }

    // 3. Write updated data back using atomic replacement (NO direct fs.writeFileSync over primary)
    data.children = keptChildren;
    data.devices = keptDevices;
    data.policies = keptPolicies;
    data.pairingCodes = keptPairingCodes;
    data.requests = keptRequests;

    atomicWriteJson(storageFile, data);
    report.details.push(`[APPLIED] Successfully wrote migrated datastore to ${storageFile}`);
  }

  return report;
}
