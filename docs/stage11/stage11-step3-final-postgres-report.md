# SafeBrowse Stage 11 — Step 3 Final: PostgreSQL Transactional Persistence and RBAC Certification Report

**Date:** 2026-09-02  
**Branch:** `security/stage11-step3-rbac`  
**Certification Status:** CERTIFIED (PostgreSQL 16+ via Prisma ORM)  
**Working Directory:** `C:\Users\acer\projects\safechild`  

---

## Executive Summary

Stage 11 Step 3 Final completes the transactional persistence and RBAC certification of SafeBrowse by migrating persistence from the JSON datastore to **PostgreSQL 16+** using **Prisma ORM**. 

All production and test persistence requirements have been achieved:
1. **Relational Schema**: 18 Prisma models with non-null `familyId` on all family resources and composite relational foreign keys enforcing complete tenancy alignment across children, devices, policies, pairing codes, and access requests.
2. **Database-Level Single-Owner Invariant**: Partial unique index (`CREATE UNIQUE INDEX "family_members_single_owner_idx" ON "FamilyMember"("familyId") WHERE "role" = 'OWNER';`) preventing multiple owners at the PostgreSQL engine level.
3. **Interactive Transactions with Row-Level Locking**: Family ownership transfer executes in a single interactive transaction with `SELECT ... FOR UPDATE`, validating target active memberships, verifying step-up credentials, atomically consuming recovery codes or recording accepted TOTP timesteps, swapping roles, updating family ownership, and writing audit logs.
4. **Account Deletion Protection**: Transactional account deletion that prevents sole owners from deleting accounts without prior ownership transfer, while allowing non-owners (PARENT/VIEWER) to leave without destroying shared family assets.
5. **Fail-Secure Startup**: Production startup strictly halts if `DATABASE_URL` is missing, PostgreSQL is unreachable, pending migrations exist, or JSON persistence mode is selected.
6. **Data Importer**: CLI importer (`scripts/import-json-to-postgres.ts`) supporting safe dry runs, idempotent upserts, legacy credential hashing, and relationship validation.
7. **Test Infrastructure**: `docker-compose.test.yml` providing a containerized PostgreSQL 16 test database with fast `tmpfs` storage, completely isolated from developer environments.
8. **Certification Probe**: 15/15 conditions confirmed `false` on `scripts/postgres-transaction-probe.ts`.

---

## 1. Technology Baseline & Architecture

- **Database Engine**: PostgreSQL 16+ running in Docker Compose (`docker-compose.test.yml`) on port 5432.
- **ORM & Client**: Prisma ORM v5.22.0 (`@prisma/client` and `prisma`).
- **Environment Configuration**:
  - `DATABASE_URL`: Primary database connection string.
  - `TEST_DATABASE_URL`: Dedicated test database connection string.
  - Safe template provided in `.env.example`.
- **Production Guardrails**:
  - Server boot validates `verifyDatabaseConnection()` in `server.ts`.
  - Rejects boot if `STORAGE_MODE === 'json'`.
  - Requires all migrations in `_prisma_migrations` to be applied.

---

## 2. Relational Schema & Tenancy Enforcement

The 18 Prisma models defined in `prisma/schema.prisma`:
- `User`: Core identity, system roles (`SYSTEM_ADMIN` | `USER`), MFA state, recovery codes, TOTP timesteps.
- `UserSession`: Session tracking, refresh token rotation, replay detection hashes.
- `MfaChallenge`: Temporary MFA tickets with cryptographic claim verification.
- `Family`: Tenancy root entity with `ownerUserId` foreign key.
- `FamilyMember`: Membership linking users to families with roles (`OWNER`, `PARENT`, `VIEWER`).
- `FamilyInvitation`: Single-use invitation tokens.
- `Child`: Child profiles with composite unique `@@unique([familyId, id])`.
- `Device`: Hardware devices with composite foreign key `[familyId, childId]` referencing `Child(familyId, id)`.
- `Policy`: Web filtering policies with composite foreign key `[familyId, childId]` referencing `Child(familyId, id)`.
- `PairingCode`: Cryptographic pairing codes with composite foreign key `[familyId, childId]` referencing `Child(familyId, id)`.
- `AccessRequest`: Domain approval requests with composite foreign key `[familyId, childId]` referencing `Child(familyId, id)`.
- `ChildUsageRecord`: Time-tracking records with composite foreign key `[familyId, childId]` referencing `Child(familyId, id)`.
- `ActivityEvent`: Web activity records with composite foreign key `[familyId, childId]` referencing `Child(familyId, id)`.
- `FamilyAuditLog`: Family-scoped tamper-evident audit logs.
- `SystemAuditLog`: System-administrator operational audit trail.
- `PasswordResetToken`: Single-use password reset tokens.
- `EmailVerificationToken`: Single-use email verification tokens.
- `Referral`: Referral program tracking.

### Single-Owner Partial Unique Index
Applied via migration `prisma/migrations/20260902093458_init_postgres_tenancy/migration.sql`:
```sql
CREATE UNIQUE INDEX "family_members_single_owner_idx" 
ON "FamilyMember"("familyId") 
WHERE "role" = 'OWNER';
```

---

## 3. Transactional Ownership Transfer & Concurrency Control

Implemented in `familyService.transferOwnership()` using `prisma.$transaction`:
1. **Row-Level Lock**: Executes `SELECT * FROM "Family" WHERE "id" = $1 FOR UPDATE` to serialize concurrent requests.
2. **Target Validation**: Validates target is an active `FamilyMember`.
3. **Step-Up Verification**: Verifies password and MFA (TOTP / Recovery Code) using constant-time comparisons.
4. **Anti-Replay Invariant**:
   - Single-use recovery code atomically removed from `mfaRecoveryCodes`.
   - TOTP timestep stored in `totpLastUsedSteps['family_ownership_transfer']`. Immediate replay rejected.
5. **Role Transition**:
   - Previous owner demoted to `PARENT`.
   - Target member promoted to `OWNER`.
   - `Family.ownerUserId` updated to new owner.
6. **Audit Staging**: Inserts `FamilyAuditLog` entry inside the same transaction.
7. **Post-Commit Invariant**: Asserts exactly one active `OWNER` in PostgreSQL.

---

## 4. Account Deletion & Ownership Protection

Implemented in `profileService.deleteAccount()`:
- Checks if the user is the `OWNER` of any active family.
- If true, blocks deletion with: `Cannot delete account: You are the sole owner of family '...'. You must transfer family ownership before deleting your account.`
- If user is only a `PARENT` or `VIEWER`, cascades personal sessions and tokens, deletes membership rows, and leaves shared family resources completely intact.

---

## 5. PostgreSQL Transaction Probe Certification (All 15 Conditions False)

Executed via `npx ts-node scripts/postgres-transaction-probe.ts`:

| Probe Invariant | Result | Status |
|---|:---:|:---:|
| `ownershipTransferPartiallyCommitted` | **false** | PASSED |
| `multipleOwnersCreated` | **false** | PASSED |
| `recoveryCodeReused` | **false** | PASSED |
| `totpStepReused` | **false** | PASSED |
| `failedTransferCreatedAudit` | **false** | PASSED |
| `crossFamilyResourceAccessed` | **false** | PASSED |
| `crossFamilyResourceModified` | **false** | PASSED |
| `deviceChildFamilyMismatchInserted` | **false** | PASSED |
| `requestDeviceFamilyMismatchInserted` | **false** | PASSED |
| `soleOwnerDeleted` | **false** | PASSED |
| `parentTreatedAsSystemAdmin` | **false** | PASSED |
| `ordinaryUserSelfPromoted` | **false** | PASSED |
| `concurrentTransferBothSucceeded` | **false** | PASSED |
| `sessionlessTokenAccepted` | **false** | PASSED |
| `unverifiedUserAccessedProductRoute` | **false** | PASSED |

---

## 6. Comprehensive Suite Verification

1. **Full Monorepo Build**: `npm run build` $\rightarrow$ 0 errors.
2. **Full Monorepo Unit/Integration Tests**: `npm test` $\rightarrow$ **112 / 112 passed** (0 failures).
3. **Security Probe**: `scripts/security-probe.ts` $\rightarrow$ 11/11 false.
4. **RBAC Probe**: `scripts/rbac-probe.ts` $\rightarrow$ 11/11 false.
5. **RBAC Remediation Probe**: `scripts/rbac-remediation-probe.ts` $\rightarrow$ 8/8 false.
6. **PostgreSQL Transaction Probe**: `scripts/postgres-transaction-probe.ts` $\rightarrow$ 15/15 false.
7. **NPM Audit**: `npm audit --omit=dev` $\rightarrow$ **0 vulnerabilities**.

---

## 7. Migration Importer Verification

Tested `scripts/import-json-to-postgres.ts`:
- Dry-run mode (`--dry`): Simulation with zero mutations.
- Live mode (`--apply`): Successfully migrated 317 users, 145 families, 209 members, 63 children, 26 devices, 63 policies, 27 access requests, and 569 audit logs.
- Idempotency: Running `--apply` a second time produced 0 duplicate rows.
