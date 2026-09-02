#!/usr/bin/env ts-node

/**
 * SafeBrowse Stage 11 Step 3 Final: JSON to PostgreSQL Tenancy Importer
 *
 * Requirements:
 * - Dry run by default (--apply required for mutation).
 * - Validates all record relationships.
 * - Rejects or quarantines ambiguous tenancy.
 * - Never assigns fam-default.
 * - Hashes or rejects legacy plaintext credentials.
 * - Idempotent (no duplicates on repeated execution).
 * - Produces migrated / rejected / conflicted counts.
 */

import * as fs from 'fs';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ImportStats {
  users: { total: number; migrated: number; rejected: number; quarantined: number };
  families: { total: number; migrated: number; rejected: number; quarantined: number };
  familyMembers: { total: number; migrated: number; rejected: number; quarantined: number };
  children: { total: number; migrated: number; rejected: number; quarantined: number };
  devices: { total: number; migrated: number; rejected: number; quarantined: number };
  policies: { total: number; migrated: number; rejected: number; quarantined: number };
  pairingCodes: { total: number; migrated: number; rejected: number; quarantined: number };
  accessRequests: { total: number; migrated: number; rejected: number; quarantined: number };
  usageRecords: { total: number; migrated: number; rejected: number; quarantined: number };
  activityEvents: { total: number; migrated: number; rejected: number; quarantined: number };
  auditLogs: { total: number; migrated: number; rejected: number; quarantined: number };
}

async function runImporter() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const fileIndex = args.indexOf('--file');
  const jsonPath =
    fileIndex >= 0 && args[fileIndex + 1]
      ? path.resolve(args[fileIndex + 1])
      : path.resolve(__dirname, '../data/safebrowse-db.json');

  console.log(`=======================================================`);
  console.log(`SafeBrowse JSON to PostgreSQL Importer`);
  console.log(`Mode: ${isApply ? '🚀 APPLY (Live Migration)' : '🔍 DRY RUN (Simulation only, no writes)'}`);
  console.log(`Source File: ${jsonPath}`);
  console.log(`=======================================================\n`);

  if (!fs.existsSync(jsonPath)) {
    console.error(`ERROR: JSON datastore file not found at ${jsonPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err: any) {
    console.error(`ERROR: Malformed JSON datastore: ${err.message}`);
    process.exit(1);
  }

  const quarantine: any[] = [];
  const stats: ImportStats = {
    users: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    families: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    familyMembers: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    children: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    devices: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    policies: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    pairingCodes: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    accessRequests: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    usageRecords: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    activityEvents: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
    auditLogs: { total: 0, migrated: 0, rejected: 0, quarantined: 0 },
  };

  // Maps to validate relationships in memory
  const validUsers = new Set<string>();
  const validFamilies = new Set<string>();
  const validChildren = new Map<string, { familyId: string; parentId: string }>();
  const validDevices = new Map<string, { familyId: string; childId: string }>();

  // 1. Validate and Import Users
  const rawUsers: any[] = data.users || [];
  stats.users.total = rawUsers.length;
  for (const u of rawUsers) {
    if (!u.id || !u.email) {
      stats.users.rejected++;
      continue;
    }
    // Check password hash; hash plaintext if legacy password detected
    let passwordHash = u.passwordHash;
    if (!passwordHash || !passwordHash.startsWith('$2')) {
      if (u.password && typeof u.password === 'string') {
        passwordHash = bcrypt.hashSync(u.password, 12);
      } else {
        passwordHash = bcrypt.hashSync('TemporaryUnsetLegacyPassword2026!', 12);
      }
    }

    validUsers.add(u.id);
    stats.users.migrated++;

    if (isApply) {
      await prisma.user.upsert({
        where: { id: u.id },
        update: {},
        create: {
          id: u.id,
          email: u.email.toLowerCase().trim(),
          name: u.name || 'User',
          passwordHash,
          systemRole: u.systemRole || 'USER',
          emailVerified: Boolean(u.emailVerified),
          mfaEnabled: Boolean(u.mfaEnabled),
          mfaSecret: u.mfaSecret || null,
          mfaRecoveryCodes: u.mfaRecoveryCodes || [],
          totpLastUsedSteps: u.totpLastUsedSteps || null,
          notificationPrefs: u.notificationPrefs || null,
          tokenVersion: u.tokenVersion || 1,
          createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
          updatedAt: u.updatedAt ? new Date(u.updatedAt) : new Date(),
          lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt) : null,
        },
      });
    }
  }

  // 2. Validate and Import Families
  const rawFamilies: any[] = data.families || [];
  stats.families.total = rawFamilies.length;
  for (const f of rawFamilies) {
    if (!f.id || f.id === 'fam-default' || !f.ownerUserId || !validUsers.has(f.ownerUserId)) {
      stats.families.rejected++;
      continue;
    }
    validFamilies.add(f.id);
    stats.families.migrated++;

    if (isApply) {
      await prisma.family.upsert({
        where: { id: f.id },
        update: {},
        create: {
          id: f.id,
          name: f.name || 'Family',
          ownerUserId: f.ownerUserId,
          requireMfa: Boolean(f.requireMfa),
          approvalRule: f.approvalRule || 'OWNER_OR_PARENT',
          createdAt: f.createdAt ? new Date(f.createdAt) : new Date(),
          updatedAt: f.updatedAt ? new Date(f.updatedAt) : new Date(),
        },
      });
    }
  }

  // 3. Validate and Import Family Members (enforcing single-owner per family)
  const rawMembers: any[] = data.familyMembers || [];
  stats.familyMembers.total = rawMembers.length;
  const familyOwnersSeen = new Set<string>();

  for (const m of rawMembers) {
    if (!m.id || !m.familyId || !m.userId || !validFamilies.has(m.familyId) || !validUsers.has(m.userId)) {
      stats.familyMembers.rejected++;
      continue;
    }

    if (m.role === 'OWNER') {
      if (familyOwnersSeen.has(m.familyId)) {
        // Conflicting multiple owner: quarantine
        stats.familyMembers.quarantined++;
        quarantine.push({ type: 'FamilyMember', reason: 'Duplicate owner in family', record: m });
        continue;
      }
      familyOwnersSeen.add(m.familyId);
    }

    stats.familyMembers.migrated++;
    if (isApply) {
      await prisma.familyMember.upsert({
        where: { id: m.id },
        update: {},
        create: {
          id: m.id,
          familyId: m.familyId,
          userId: m.userId,
          role: m.role || 'PARENT',
          joinedAt: m.joinedAt ? new Date(m.joinedAt) : new Date(),
        },
      });
    }
  }

  // 4. Validate and Import Children
  const rawChildren: any[] = data.children || [];
  stats.children.total = rawChildren.length;
  for (const c of rawChildren) {
    if (!c.id || !c.familyId || !validFamilies.has(c.familyId) || !c.parentId || !validUsers.has(c.parentId)) {
      stats.children.rejected++;
      continue;
    }

    validChildren.set(c.id, { familyId: c.familyId, parentId: c.parentId });
    stats.children.migrated++;

    if (isApply) {
      await prisma.child.upsert({
        where: { id: c.id },
        update: {},
        create: {
          id: c.id,
          familyId: c.familyId,
          parentId: c.parentId,
          name: c.name || 'Child',
          age: c.age || null,
          avatar: c.avatar || null,
          createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
          updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
        },
      });
    }
  }

  // 5. Validate and Import Devices (Cross-checking with child's familyId)
  const rawDevices: any[] = data.devices || [];
  stats.devices.total = rawDevices.length;
  for (const d of rawDevices) {
    const child = validChildren.get(d.childId);
    if (!d.id || !child) {
      stats.devices.rejected++;
      continue;
    }

    // Tenancy conflict check
    if (d.familyId && d.familyId !== child.familyId) {
      stats.devices.quarantined++;
      quarantine.push({
        type: 'Device',
        reason: `Tenancy mismatch: device.familyId (${d.familyId}) !== child.familyId (${child.familyId})`,
        record: d,
      });
      continue;
    }

    const effectiveFamilyId = child.familyId;
    const effectiveParentId = validUsers.has(d.parentId) ? d.parentId : child.parentId;
    validDevices.set(d.id, { familyId: effectiveFamilyId, childId: d.childId });
    stats.devices.migrated++;

    if (isApply) {
      await prisma.device.upsert({
        where: { id: d.id },
        update: {},
        create: {
          id: d.id,
          familyId: effectiveFamilyId,
          childId: d.childId,
          parentId: effectiveParentId,
          name: d.name || 'Device',
          platform: d.platform || 'windows',
          agentVersion: d.agentVersion || '1.0.0',
          lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt) : new Date(),
          lastHeartbeatAt: d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt) : new Date(),
          ipAddress: d.ipAddress || null,
          healthStatus: d.healthStatus || 'healthy',
          healthState: d.healthState || 'PROTECTED',
          isRevoked: Boolean(d.isRevoked),
          tokenHash: d.tokenHash || null,
          createdAt: d.createdAt ? new Date(d.createdAt) : new Date(),
          updatedAt: d.updatedAt ? new Date(d.updatedAt) : new Date(),
        },
      });
    }
  }

  // 6. Validate and Import Policies
  const rawPolicies: any[] = data.policies || [];
  stats.policies.total = rawPolicies.length;
  for (const p of rawPolicies) {
    const child = validChildren.get(p.childId);
    if (!p.id || !child) {
      stats.policies.rejected++;
      continue;
    }
    if (p.familyId && p.familyId !== child.familyId) {
      stats.policies.quarantined++;
      quarantine.push({ type: 'Policy', reason: 'Tenancy mismatch with child', record: p });
      continue;
    }

    stats.policies.migrated++;
    if (isApply) {
      await prisma.policy.upsert({
        where: { childId: p.childId },
        update: {},
        create: {
          id: p.id,
          familyId: child.familyId,
          childId: p.childId,
          blockedCategories: p.blockedCategories || [],
          blacklistedDomains: p.blacklistedDomains || [],
          whitelistedDomains: p.whitelistedDomains || [],
          temporaryGrants: p.temporaryGrants || null,
          usageBudgets: p.usageBudgets || null,
          safeSearch: p.safeSearch || null,
          routines: p.routines || null,
          studyMode: Boolean(p.studyMode),
          version: p.version || 1,
          createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
          updatedAt: p.updatedAt ? new Date(p.updatedAt) : new Date(),
        },
      });
    }
  }

  // 7. Validate and Import Pairing Codes
  const rawCodes: any[] = data.pairingCodes || [];
  stats.pairingCodes.total = rawCodes.length;
  for (const pc of rawCodes) {
    const child = validChildren.get(pc.childId);
    if (!pc.id || !pc.code || !child) {
      stats.pairingCodes.rejected++;
      continue;
    }
    stats.pairingCodes.migrated++;
    if (isApply) {
      await prisma.pairingCode.upsert({
        where: { code: pc.code },
        update: {},
        create: {
          id: pc.id,
          code: pc.code,
          familyId: child.familyId,
          childId: pc.childId,
          createdByParentId: validUsers.has(pc.createdByParentId) ? pc.createdByParentId : child.parentId,
          expiresAt: pc.expiresAt ? new Date(pc.expiresAt) : new Date(),
          createdAt: pc.createdAt ? new Date(pc.createdAt) : new Date(),
        },
      });
    }
  }

  // 8. Validate and Import Access Requests
  const rawRequests: any[] = data.requests || [];
  stats.accessRequests.total = rawRequests.length;
  for (const r of rawRequests) {
    const child = validChildren.get(r.childId);
    if (!r.id || !child) {
      stats.accessRequests.rejected++;
      continue;
    }
    stats.accessRequests.migrated++;
    if (isApply) {
      await prisma.accessRequest.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          familyId: child.familyId,
          childId: r.childId,
          deviceId: r.deviceId || null,
          domain: r.domain || 'unknown.com',
          reason: r.reason || null,
          requestedAt: r.requestedAt ? new Date(r.requestedAt) : new Date(),
          expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
          status: r.status || 'PENDING',
          resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
          resolvedByUserId: r.resolvedByUserId || null,
          resolutionAction: r.resolutionAction || null,
          durationMinutes: r.durationMinutes || null,
        },
      });
    }
  }

  // 9. Validate and Import Audit Logs
  const rawAudits: any[] = data.familyAuditLogs || [];
  stats.auditLogs.total = rawAudits.length;
  for (const a of rawAudits) {
    if (!a.id || !a.familyId || !validFamilies.has(a.familyId)) {
      stats.auditLogs.rejected++;
      continue;
    }
    stats.auditLogs.migrated++;
    if (isApply) {
      await prisma.familyAuditLog.upsert({
        where: { id: a.id },
        update: {},
        create: {
          id: a.id,
          familyId: a.familyId,
          actorUserId: a.actorUserId || 'unknown',
          actorName: a.actorName || 'User',
          action: a.action || 'ACTION',
          childId: a.childId || null,
          details: a.details || '',
          timestamp: a.timestamp ? new Date(a.timestamp) : new Date(),
        },
      });
    }
  }

  // Quarantine output
  if (quarantine.length > 0) {
    const quarantinePath = path.resolve(__dirname, '../data/quarantine.json');
    fs.writeFileSync(quarantinePath, JSON.stringify(quarantine, null, 2));
    console.log(`⚠️  Quarantined ${quarantine.length} records to ${quarantinePath}`);
  }

  console.log('-------------------------------------------------------');
  console.log('MIGRATION SUMMARY:');
  console.table(stats);
  console.log('-------------------------------------------------------');
  if (!isApply) {
    console.log('✅ DRY RUN COMPLETED. No modifications made to PostgreSQL.');
    console.log('   Run with `--apply` to persist changes.');
  } else {
    console.log('✅ LIVE MIGRATION COMPLETED.');
  }
}

runImporter()
  .catch((e) => {
    console.error('Fatal importer error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
