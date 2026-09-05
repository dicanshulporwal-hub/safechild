# SafeBrowse Stage 11: Add Child PostgreSQL Error Root Cause Analysis & Fix Report

**Branch:** `feature/stage11-step4-device-enforcement`  
**Evaluation Status:** `VERIFIED — PASSED`  
**Single System of Record:** PostgreSQL 16+ via Prisma ORM  
**Date:** 2026-09-05  

---

## 1. Exact Root Cause Analysis

### Identified Failure Mechanism
When adding a child profile through the Parent Portal UI (`packages/parent-web/src/api/client.ts`), the web client submits:
```json
{
  "name": "Liam",
  "age": 12,
  "avatar": "🧒"
}
```
In `packages/backend/src/routes/child.routes.ts`, the `POST /api/children` endpoint strictly required `familyId` in the request body:
```typescript
const { name, age, avatar, familyId } = req.body;
if (!familyId || typeof familyId !== 'string' || !familyId.trim()) {
  return res.status(400).json({ error: 'Mandatory tenancy error: Valid familyId is required to create a child profile.' });
}
```
Because the parent web interface relies on the backend session/user tenancy context to associate the child with the parent's active family (as done gracefully in `GET /api/children`), the creation request failed with **HTTP 400 Bad Request** (`Mandatory tenancy error: Valid familyId is required to create a child profile.`).

Additionally, in `packages/backend/src/services/child.service.ts`, `Child.parentId` was hardcoded to `family.ownerUserId` rather than the authenticated caller's `parentId`, preventing verified co-parents with `CHILD_MANAGE` permissions from correctly attributing child creation to their user record.

### Failed Endpoint Details
- **Endpoint:** `POST /api/children`
- **HTTP Status (Before Fix):** `400 Bad Request`
- **Application Error:** `Mandatory tenancy error: Valid familyId is required to create a child profile.`
- **PostgreSQL Migrations / Engine State:** 
  - Database schema (`prisma/schema.prisma`) and migrations (`0_init`, `step3e_durability_indexes`, `step3f_deferred_triggers`) were completely up to date.
  - Foreign key and owner invariant triggers were valid; no database reset or schema mutation was required.

---

## 2. Implemented Fix

### Smallest Correct Fix Applied
1. **Tenancy Resolution in Route (`packages/backend/src/routes/child.routes.ts`)**:
   - If `familyId` is provided in the request body, the backend verifies that the authenticated user is an active member of that family (`rbacService.getFamilyMembership`). If not, it returns `403 Forbidden` (cross-family tampering protection).
   - If `familyId` is omitted, the backend derives the user's family tenancy from authenticated membership via `familyService.getOrCreateUserFamily(req.userId!)`.
   - Validates that the user has `FamilyPermission.CHILD_MANAGE` in the target family (OWNER and PARENT have permission; VIEWER receives `403 Forbidden`).
   - Validates input: `name` (required non-empty string) and `age` (optional integer between 1 and 18).
2. **Atomic Child & Policy Creation (`packages/backend/src/services/child.service.ts`)**:
   - Assigns `Child.parentId` to the authenticated caller (`parentId`).
   - Validates family membership inside the Prisma transaction.
   - Atomically creates `Child`, default `Policy` (with matching `familyId` and `childId`), and `FamilyAuditLog` (`CHILD_CREATED`).
   - Transaction ensures all-or-nothing atomicity with automatic rollback on failure.

---

## 3. Files Changed

| File Path | Description of Change |
|---|---|
| [`packages/backend/src/routes/child.routes.ts`](file:///c:/Users/acer/projects/safechild/packages/backend/src/routes/child.routes.ts) | Added tenancy derivation when `familyId` is omitted, input validation, and RBAC permission checks. |
| [`packages/backend/src/services/child.service.ts`](file:///c:/Users/acer/projects/safechild/packages/backend/src/services/child.service.ts) | Set `Child.parentId` to authenticated user, added transaction-level membership validation. |
| [`packages/backend/tests/rbac-authorization.test.ts`](file:///c:/Users/acer/projects/safechild/packages/backend/tests/rbac-authorization.test.ts) | Added regression tests for OWNER, PARENT, VIEWER, cross-family tampering, unverified users, invalid inputs, and atomic rollback. |

*No new PostgreSQL migrations were required as existing schema and triggers are fully sound.*

---

## 4. Regression Test Results

### Automated Test Suites
```bash
> safebrowse-platform@1.0.0 test
> node --test dist/tests/**/*.test.js

✔ SafeBrowse Backend Service Integration Tests (2068ms)
✔ SafeBrowse Stage 11 Step 3F: Real PostgreSQL API Integration & E2E Suite (22644ms)
✔ SafeBrowse Stage 11 Step 3: System Admin RBAC & Family Authorization Suite (7601ms)
  ✔ 6c. should allow verified OWNER to create child without explicit familyId (derived tenancy)
  ✔ 6d. should allow verified PARENT with CHILD_MANAGE to create child
  ✔ 6e. should reject VIEWER creating child profile with 403 Forbidden
  ✔ 6f. should reject cross-family familyId tampering with 403 Forbidden
  ✔ 6g. should reject missing name or invalid age with 400 Bad Request
  ✔ 6h. should reject unverified parent from creating child profile with 403
  ✔ 6i. should atomically roll back child if policy creation fails
✔ SafeBrowse Security, Edge Cases & Threat Model Test Suite (8740ms)
✔ SafeBrowse Test Database Safety Guard Unit Tests (23ms)
✔ SafeBrowse Policy Engine & Precedence Tests (28ms)

ℹ tests 85 passed, 0 failed
```

### Dedicated PostgreSQL E2E Suite
```bash
> safebrowse-platform@1.0.0 test:postgres:e2e
> node --test packages/backend/dist/tests/postgres-e2e.test.js

ℹ tests 30 passed, 0 failed (including mid-mutation atomic rollback and connection failure abort)
```

---

## 5. Manual Verification Protocol Results

Executed full end-to-end simulation on port 1002 matching the live application environment:
1. **Parent Registration & Email Verification**: Succeeded (`200 OK`).
2. **Parent Login**: Succeeded (`200 OK`, `emailVerified: true`).
3. **Add Child via Parent Portal Payload** (`{ name: 'Liam', age: 12, avatar: '🧒' }`): Succeeded (`200 OK`, child ID: `child-eYMLcgKy`, policy ID: `policy-mH8eI-l2`).
4. **Immediate Dashboard Reflection**: `GET /api/children` immediately returned the newly created child profile.
5. **Backend Restart Durability**: Backend server stopped and restarted; `GET /api/children` confirmed complete persistence in PostgreSQL without data loss.

---

## 6. Verification Commands & Clean Working Tree

- `npx prisma validate` -> Schema valid 🚀
- `npx prisma migrate status` -> Database schema up to date (3 migrations)
- `npm run verify:postgres-cutover` -> PASSED (0 JSON DataStore usages)
- `npm run clean && npm run build` -> Clean workspace build PASSED
- `npm test` -> 85/85 tests passed
- `npm run test:postgres:e2e` -> 30/30 E2E tests passed
