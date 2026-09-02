# SafeBrowse Stage 11 — Step 3C: Single-Commit Transactions and Complete Tenancy Integrity Report

**Date:** 2026-09-02  
**Branch:** `security/stage11-step3-rbac`  
**Commit Baseline:** Single-commit atomic transactions & fail-secure relational tenancy validation  
**Working Directory:** `C:\Users\acer\projects\safechild`  

---

## Executive Summary

Stage 11 Step 3C achieves complete transaction atomicity, genuine single-commit datastore semantics, zero CPU busy-wait retry, fail-secure backup recovery with pre-restore schema/tenancy validation, and comprehensive relational tenancy integrity across families, children, devices, policies, pairing codes, and access requests.

All intermediate save triggers (such as in-flight audit logging) were removed in favor of staged audit mutations (`createAuditEntry` and `appendAuditEntryWithoutSave`), ensuring that complex operations like family ownership transfer invoke `db.save()` **exactly once**. If a transaction aborts or fails before disk commit, zero persistent writes occur, the family-scoped in-memory state is restored, and the system never suppresses rollback or persistence failures.

---

## 1. Clean Test Pipeline & Module Resolution

- **Architecture Fix**: Migrated the core tenancy migration engine into `@safebrowse/backend/src/utils/tenancy-migration.ts`, allowing TypeScript compiler (`tsc`) to bundle it directly into `dist/src/utils/tenancy-migration.js`.
- **Clean Pipeline**: Successfully executed and verified:
  ```bash
  npm ci
  npm run clean
  npm run build
  npm test
  ```
- All 112 automated unit and integration tests across the monorepo pass cleanly (`@safebrowse/backend`: 104, `@safebrowse/shared`: 8).

---

## 2. Exactly One Durable Commit per Ownership Transfer

### 2.1 The Intermediate Save Problem
Prior to Step 3C, `familyService.transferOwnership()` called `this.logAudit()`, which immediately performed an uncoordinated `db.save()`. This created a 2-save sequence:
1. First save: Staged audit record written to disk.
2. Second save: Family ownership & membership roles written to disk.
If the second save failed (e.g. disk full, EPERM), the disk recorded a successful ownership transfer in audit logs while the family owner remained unchanged, leading to permanent memory-disk divergence.

### 2.2 Staging Architecture
Refactored audit logging in `family.service.ts`:
- `familyService.createAuditEntry(...)`: Pure constructor creating an uncommitted audit record.
- `familyService.appendAuditEntryWithoutSave(...)`: Appends the record to the in-memory array without triggering persistence.
- `familyService.logAudit(...)`: Composition helper for non-transactional routines (`create` + `append` + `save`).
- `familyService.transferOwnership(...)`: Acquires lock, validates step-up credentials, stages mutations and audit entry, and calls `db.save()` **exactly once**.

---

## 3. Correct Rollback & Degraded / Read-Only Safety

- **Silent Catch Removal**: Eliminated empty catch blocks across `restoreFamilySnapshot`, `restoreSnapshot`, and migration loading.
- **Fail-Secure Degraded State**: If an in-memory rollback operation itself throws, `db.setDegraded(reason)` places the datastore into a degraded read-only state. Any subsequent mutation attempt throws `FatalConsistencyError`.
- **Durable Disk Invariance**: If commit fails, the previous valid datastore file is preserved without corruption.

---

## 4. Genuinely Atomic Datastore Replacement

1. **Temporary File & fsync**:
   Writes to a PID- and timestamp-isolated temporary file in the same directory (`safebrowse-db.json.tmp.<pid>.<time>.<random>`).
   `fs.fsyncSync(fd)` is enforced. Any fsync failure aborts the commit.
2. **Pre-Commit Verification**:
   Reads back the temporary file and validates its JSON parseability before replacement.
3. **Backup Replacement**:
   Updates `safebrowse-db.json.bak` using an isolated atomic replacement (`.bak.tmp` -> fsync -> atomic rename).
   Configured policy: `backupFailureBlocksCommit = true`.
4. **Zero Live Copy Fallback & Zero CPU Spinning**:
   Prohibited direct copy fallback (`copyFileSync` over primary file).
   Replaced busy-wait polling with non-busy bounded sleeping (`Atomics.wait`).
   On Windows NTFS, handles `EPERM` by safely unlinking obsolete destination targets before renaming.
5. **Directory Sync**:
   Syncs the containing directory descriptor on filesystems where supported.

---

## 5. Fail-Secure Backup Recovery

Before restoring `safebrowse-db.json.bak`:
1. Parse JSON syntax.
2. Validate complete schema and relational tenancy integrity via `DataStore.validateTenancyIntegrity(bakData)`.
3. If valid, restore using atomic replacement (write temp -> fsync -> rename).
4. If invalid or corrupt, abort startup with `DataLoadError`. A syntactically valid but structurally invalid backup will never start the application.

---

## 6. Complete Relational Tenancy Integrity Invariants

Implemented in `DataStore.validateTenancyIntegrity()` and enforced at production startup (`NODE_ENV === 'production'`):
1. **Single-Owner Invariant**: Every family has exactly one `OWNER` membership in `familyMembers`.
2. **Owner User Alignment**: `family.ownerUserId` matches that `OWNER` membership user.
3. **Child Tenancy**: Every `child.familyId` references an existing family.
4. **Device Tenancy**: Every device has an existing child, and `device.familyId === child.familyId`.
5. **Policy Tenancy**: Every policy has an existing child, and `policy.familyId === child.familyId`.
6. **Pairing Code Tenancy**: Every pairing code has an existing child, and `code.familyId === child.familyId`.
7. **Access Request Tenancy**: Every request has an existing child, and `request.familyId === child.familyId`.
8. **Request Device Cross-Check**: If `request.deviceId` is specified, the device must belong to the exact same child and family.

---

## 7. Migration Conflict Handling & Idempotency

- **Cross-Checks**: Devices, Policies, Pairing Codes, and Access Requests are checked against the associated child's validated `familyId`.
- **Conflict Quarantine**: Conflicting `familyId` records are never silently overwritten or accepted as unchanged; they are routed to quarantine.
- **Idempotency**: Quarantine updates use entity-key deduplication (`${type}:${id}`), guaranteeing repeated runs do not duplicate quarantine records.
- **Atomic Apply**: Migration apply writes both the primary datastore and `quarantine.json` using atomic temporary file creation, fsync, and atomic rename.

---

## 8. Tenancy Inference Elimination

Removed all `getOrCreateUserFamily` and `child.parentId` fallbacks from:
- `deviceService.getDevicesForParent(parentId, familyId?)` & `GET /api/devices`
- `requestService.getPendingRequestsForParent(parentId, familyId?)` & `GET /api/requests/pending`
- `usageService.getWeeklyDigest(userId, familyId?)` & `GET /api/usage/digest`
- Usage clock-tamper audit attribution (`usage.service.ts`)
- Screen time and safe-search update audit attribution (`usage.service.ts`)
- Child profile deletion audit attribution (`child.service.ts`)
- Notification family filtering (`notification.service.ts`)

---

## 9. Persistent Pairing Codes (Option A)

Formally persisted `pairingCodes` with mandatory `familyId` in `safebrowse-db.json`.
On startup load, `DataStore.load()` safely prunes expired codes (`new Date(code.expiresAt).getTime() <= Date.now()`).

---

## 10. Durability Probe Metrics (All 15 False)

All 15 durability probe conditions were executed using real `familyService.transferOwnership()` transactions:

| Probe Metric | Result | Status |
|---|:---:|:---:|
| `ownershipTransferSucceededWhenSaveFailed` | **false** | PASSED |
| `recoveryCodeReusableAfterSuccessfulRestart` | **false** | PASSED |
| `totpReplayStateLostAfterRestart` | **false** | PASSED |
| `auditEventLostAfterSuccessfulResponse` | **false** | PASSED |
| `failedTransactionChangedMemory` | **false** | PASSED |
| `failedTransactionChangedDisk` | **false** | PASSED |
| `crossFamilyRollbackUndidSuccessfulTransfer` | **false** | PASSED |
| `missingFamilyIdAccepted` | **false** | PASSED |
| `ambiguousLegacyRecordAutoAssigned` | **false** | PASSED |
| `malformedDatastoreStartedNormally` | **false** | PASSED |
| `ownershipTransferPerformedMultipleSaves` | **false** | PASSED |
| `apiFailedButDiskCommittedOwnership` | **false** | PASSED |
| `apiFailedButDiskContainsSuccessAudit` | **false** | PASSED |
| `memoryDiskOwnerDiverged` | **false** | PASSED |
| `rollbackPersistenceFailureSuppressed` | **false** | PASSED |

---

## 11. Security Audit Results

```bash
$ npm audit --omit=dev
found 0 vulnerabilities
```
