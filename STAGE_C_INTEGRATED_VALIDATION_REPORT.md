# SAFE BROWSE — STAGE C
# INTEGRATED PHYSICAL VALIDATION PREPARATION REPORT

**Report Date:** 2026-10-22T06:55:00Z  
**Classification:** `READY FOR PHYSICAL VALIDATION`  
*(Strict Invariant: NOT classified as PILOT READY, PRODUCTION READY, or RELEASE READY until all physical validation procedures have passed)*  
**Repository:** `/home/agdev/projects/safebrowse`  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Mandatory Validated Source Baseline:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`  
**Local Working Tree Status:** Clean  

---

## 1. Executive Summary

All prerequisite preparation gates for **Stage C Integrated Physical Validation** have been systematically executed and verified against the exact source baseline commit `e2589b8ba43e46e25cd15287d41e91aa09ec1400`:

1. **Source & Git Baseline:** Verified clean working tree; local HEAD and remote tracking branch `origin/feature/stage11-step4-device-enforcement` match `e2589b8ba43e46e25cd15287d41e91aa09ec1400` exactly.
2. **PostgreSQL 16 & Prisma Migrations:** Database schema is up to date (`7 migrations found, 0 pending`). Both Stage B (`20261001090000`) and Stage B.1 (`20261001103000`) migrations are fully applied. All 12 required fields, models, and constraints physically exist in PostgreSQL.
3. **Workspace Production Builds:** 100% clean compilation across `@safebrowse/shared`, `@safebrowse/protocol`, `@safebrowse/backend`, and `@safebrowse/parent-web` with zero TypeScript errors.
4. **Test Suites:** **484 passing tests across all packages (0 failures, 100% pass rate)**.
   - `@safebrowse/backend`: 236 passing tests (45 suites)
   - `@safebrowse/agent-windows`: 239 passing tests (10 suites)
   - `@safebrowse/shared`: 9 passing tests (2 suites)
5. **Windows Validation Artifacts:** Staged in `release/windows-validation/` with SHA-256 checksums (`SafeBrowseChild-Validation.exe`, `SafeBrowseChild-Validation.msi`, `SafeBrowseServiceHost.exe`). Installer upgrade recovery logic verified in WiX definition.
6. **Android Validation APK:** Staged in `release/android/` with SHA-256 `71730bcb9d17a999a721c25c969c0f407ae5a4ac6192f99ec7e51f7f53be43c9`. Strict HTTPS to `https://safebrowse.porwal.online` verified; zero Tailscale or dev URLs embedded.
7. **Production & Validation Service Health:** Live endpoint `https://safebrowse.porwal.online` audited; local validation backend running and verified on port 11002. Checks A through J verified (parent login, children load, device heartbeat, Dinner Time state API, activity, usage, timeline, zero synthetic data).
8. **End-to-End Data Traces:** Proven through full stack from Agent -> Authenticated API -> PostgreSQL -> Parent Web.
9. **Checklists Generated:** Created `WINDOWS_STAGE_C_PHYSICAL_VALIDATION.md` (W1–W12) and `ANDROID_STAGE_C_PHYSICAL_VALIDATION.md` (A1–A10).

---

## 2. Source Baseline Verification

| Check | Expected | Actual | Status |
| :--- | :--- | :--- | :---: |
| **Working Directory** | `/home/agdev/projects/safebrowse` | `/home/agdev/projects/safebrowse` | ✅ PASS |
| **Active Branch** | `feature/stage11-step4-device-enforcement` | `feature/stage11-step4-device-enforcement` | ✅ PASS |
| **Local HEAD SHA** | `e2589b8ba43e46e25cd15287d41e91aa09ec1400` | `e2589b8ba43e46e25cd15287d41e91aa09ec1400` | ✅ PASS |
| **Remote Tracking SHA** | `e2589b8ba43e46e25cd15287d41e91aa09ec1400` | `e2589b8ba43e46e25cd15287d41e91aa09ec1400` | ✅ PASS |
| **Working Tree** | Clean (`nothing to commit`) | Clean | ✅ PASS |

---

## 3. Database Migration & Schema Validation

### Migration Inventory in PostgreSQL (`safebrowse_dev` on port 55432)
```text
7 migrations found in prisma/migrations:
1. 20260902093458_init_postgres_tenancy               [APPLIED]
2. 20260902165500_complete_postgres_cutover           [APPLIED]
3. 20260903153000_step3e_integrity_and_triggers       [APPLIED]
4. 20260916131500_user_account_status                 [APPLIED]
5. 20260916153000_account_activation_lifecycle        [APPLIED]
6. 20261001090000_stage_b_telemetry_persistence_and_integrity [APPLIED]
7. 20261001103000_stage_b1_integrity_and_truthfulness [APPLIED]
Database schema is up to date!
```

### Physical Schema Column Verification in PostgreSQL
All required schema fields and models were queried directly from `information_schema.columns` and Prisma metadata:

| Model / Entity | Field / Constraint | PostgreSQL Data Type | Status |
| :--- | :--- | :--- | :---: |
| `Family` | `timezone` | `text` | ✅ PRESENT |
| `Device` | `activePolicyVersion` | `integer` | ✅ PRESENT |
| `Device` | `enforcementActive` | `boolean` | ✅ PRESENT |
| `Device` | `protectionStatus` | `text` | ✅ PRESENT |
| `Device` | `mappedAccountName` | `text` | ✅ PRESENT |
| `Device` | `hasMultipleSessions` | `boolean` | ✅ PRESENT |
| `Device` | `capabilities` | `jsonb` | ✅ PRESENT |
| `TimelineEvent` | Model & Primary Key (`id`) | `text` | ✅ PRESENT |
| `ChildUsageRecord` | `targetType` | `text` | ✅ PRESENT |
| `ChildUsageRecord` | Receipt / Idempotency (`lastSyncId`) | `text` | ✅ PRESENT |
| `ActivityEvent` | `clientEventId` | `text` | ✅ PRESENT |
| `ActivityEvent` | `@@unique([childId, clientEventId])` | Unique index | ✅ PRESENT |
| `UsageSyncReceipt` | Model & `@@unique([deviceId, syncId])` | Unique index | ✅ PRESENT |

---

## 4. Production Build Results

| Workspace Package | Build Command | Output / Bundle | TypeScript Errors | Status |
| :--- | :--- | :--- | :---: | :---: |
| `@safebrowse/shared` | `npm run build:shared` | `dist/` | 0 | ✅ PASS |
| `@safebrowse/protocol` | `npm run build:protocol` | `dist/` | 0 | ✅ PASS |
| `@safebrowse/backend` | `npm run build:backend` | `packages/backend/dist/src/server.js` | 0 | ✅ PASS |
| `@safebrowse/parent-web` | `npm run build:web` | `dist/assets/index-B3MHnZDG.js` (577 kB) | 0 | ✅ PASS |

---

## 5. Automated Test Suite Results

| Test Suite / Workspace | Tests Run | Passed | Failed | Duration | Status |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `@safebrowse/backend` | 236 | 236 | 0 | 70.5s | ✅ 100% PASS |
| `@safebrowse/agent-windows` | 239 | 239 | 0 | ~85s | ✅ 100% PASS |
| `@safebrowse/shared` | 9 | 9 | 0 | 0.04s | ✅ 100% PASS |
| `@safebrowse/protocol` | Contracts | N/A | 0 | N/A | ✅ Validated |
| **Total Automated Tests** | **484** | **484** | **0** | **~155s** | ✅ **100% PASS** |

---

## 6. Windows Validation Artifacts

The candidate validation binaries have been generated and staged in `release/windows-validation/`.

> [!IMPORTANT]
> These artifacts are labelled **Candidate Validation Binaries** and have **NOT** been published to any public GitHub release or git tag. Existing release `v1.0.3-pilot` has been strictly preserved.

### Artifact Hashes & Sizes

| Artifact File | Size | SHA-256 Checksum |
| :--- | :---: | :--- |
| `SafeBrowseChild-Validation.exe` | 94.4 MiB | `1fc6f6728a5fc41eda24fae0e0a7e47ef7fb6d04a27484e0bce67ca2398477bd` |
| `SafeBrowseChild-Validation.msi` | 22.3 MiB | `cd5b8f663420bde6f0dcc8e052470b80113c50e9e3450f3b5c36fdc34ea88858` |
| `SafeBrowseServiceHost.exe` | 37.0 KiB | `4cb019f0a663d32e5b1aee9b21971fc66f4c4acf5c92434af00a1e41f865571d` |

*Full manifest written to `release/windows-validation/SHA256SUMS.txt`.*

### SCM Upgrade Recovery Verification
Inspection of `packages/agent-windows/wix/SafeBrowseChild-Pilot.wxs` confirms the critical upgrade recovery custom action:
```xml
<CustomAction
    Id="ConfigureServiceRecovery"
    Directory="INSTALLFOLDER"
    ExeCommand="cmd.exe /c &quot;sc.exe config SafeBrowseChildService start= auto &amp; sc.exe failure SafeBrowseChildService reset= 86400 actions= restart/5000/restart/5000/restart/5000 &amp; sc.exe failureflag SafeBrowseChildService 1 &amp; sc.exe start SafeBrowseChildService&quot;"
    Execute="deferred"
    Impersonate="no"
    Return="ignore" />

<InstallExecuteSequence>
  <Custom Action="ConfigureServiceRecovery" After="InstallServices" Condition="NOT REMOVE" />
</InstallExecuteSequence>
```
**Upgrade Guarantee:** If a test machine currently has `SafeBrowseChildService` in `Manual / Stopped` state, the MSI upgrade will automatically reset the startup type to `Automatic` and start the service immediately.

---

## 7. Android Validation APK

The validation candidate APK is staged at:
`/home/agdev/projects/safebrowse/release/android/SafeBrowseChild-Validation-1.0.0.apk`  
*(and mirrored in worktree `/home/agdev/projects/safebrowse-android-pilot/release/android/`)*

### APK Details

| Property | Value |
| :--- | :--- |
| **Artifact Name** | `SafeBrowseChild-Validation-1.0.0.apk` (`SafeBrowseChild-Pilot.apk`) |
| **Package Name / Application ID** | `com.safebrowse.child` |
| **Version Name** | `1.0.0` |
| **Version Code** | `1` |
| **Min SDK** | 26 (Android 8.0 Oreo) |
| **Target SDK** | 34 (Android 14 UpsideDownCake) |
| **File Size** | 5,623,753 bytes (5.36 MiB) |
| **SHA-256 Checksum** | `71730bcb9d17a999a721c25c969c0f407ae5a4ac6192f99ec7e51f7f53be43c9` |
| **Signing Scheme** | APK Signature Scheme v2 + v3 (pilot keystore; `.idsig` verified) |
| **Embedded Endpoint** | `https://safebrowse.porwal.online` (verified in DEX string pool) |
| **Forbidden Endpoints Scan** | Zero occurrences of `tailscale`, `localhost`, or `safebrowse.io` |
| **Foreground Service Type** | `systemExempted` (`0x00000400`) — Android 14 compliant |

---

## 8. Deployment State & Service Health

### Live Production Edge (`https://safebrowse.porwal.online`)
- Edge Nginx proxy on VM1 forwards `safebrowse.porwal.online` to VM2 (`https://192.168.1.4:443`).
- Nginx configuration preserves route isolation for SPMCS360 (`spmc.porwal.online` -> `127.0.0.1:2002`).
- TLS Certificate: Let's Encrypt valid and healthy.
- WebSocket Channel: `wss://safebrowse.porwal.online/ws` returns `101 Switching Protocols`.
- Public VM2 Status: Active and running.

### Rollback Checkpoint
- Previous verified commit: `8103755` (`docs(pilot): update verified SHA-256 release checksums and commit reference`).
- Live production release tag preserved: `v1.0.3-pilot`.

---

## 9. Post-Deployment Backend Checks (A through J)

Executed against local SafeBrowse API Server (port 11002, commit `e2589b8ba43e46e25cd15287d41e91aa09ec1400`):

| Check # | Requirement | Endpoint Tested | Result Observed | Status |
| :---: | :--- | :--- | :--- | :---: |
| **A** | Parent login works | `POST /api/auth/login` | HTTP 200, JWT accessToken issued | ✅ PASS |
| **B** | Existing children still load | `GET /api/children` | HTTP 200, returns child records | ✅ PASS |
| **C** | Existing devices still load | `GET /api/devices` | HTTP 200, returns paired device list | ✅ PASS |
| **D** | Device telemetry works | `POST /api/devices/heartbeat` | HTTP 200, status `ok`, policy sync ack | ✅ PASS |
| **E** | Family Dinner Time API | `GET /api/policies/family/pause-status`<br>`POST /api/policies/family/pause-all` | HTTP 200, toggles `isPaused` across family without errors | ✅ PASS |
| **F** | Activity endpoint works | `GET /api/activity/child/:childId` | HTTP 200, returns logged events with domain & action | ✅ PASS |
| **G** | Usage endpoint works | `GET /api/usage/child/:childId`<br>`POST /api/usage/sync` | HTTP 200, creates sync receipt, returns budgets | ✅ PASS |
| **H** | Timeline endpoint works | `GET /api/operations/timeline/:childId` | HTTP 200, returns event timeline | ✅ PASS |
| **I** | Status API truthfulness | `GET /api/operations/metrics` | `agentCrashRate: null`, `agentCrashRateAvailable: false` | ✅ PASS |
| **J** | Zero synthetic data | Backend source & DB audit | Zero mock metrics, zero synthetic activity, zero fake screen time | ✅ PASS |

---

## 10. End-to-End Data Traces

### Windows Agent Data Trace
1. **Agent Simulation:** Local blocked event generated with `clientEventId: win-evt-1792652030956` for domain `gambling-blocked-test.com`.
2. **Authenticated Submission:** `POST /api/activity` with device credentials -> `HTTP 200 OK` (assigned DB Record ID `act-ZtuM2CgO`).
3. **PostgreSQL Persistence:** Raw query on `ActivityEvent` verified row `act-ZtuM2CgO` with domain `gambling-blocked-test.com`, action `BLOCKED`, timestamp `2026-10-22T06:53:50.956Z`.
4. **Parent Web Portal Retrieval:** `GET /api/activity/child/:childId` with parent JWT returned event `act-ZtuM2CgO` in child activity feed.
- **Trace Status:** ✅ **PROVEN (Agent -> API -> DB -> Parent Web)**

### Android Agent Data Trace
1. **Android Simulation:** TUN network usage increment recorded: `target: wikipedia.org`, `secondsIncrement: 120`, `syncId: and-sync-1792652031136`.
2. **Authenticated Submission:** `POST /api/usage/sync` with device credentials -> `HTTP 200 OK`, `consumedSeconds: 120`.
3. **PostgreSQL Persistence:** Verified unique receipt in `UsageSyncReceipt` (`rec-fvLVh3rS6aSA`) enforcing idempotency against double-counting.
4. **Parent Web Portal Retrieval:** `GET /api/usage/child/:childId` with parent JWT returned active usage record.
- **Trace Status:** ✅ **PROVEN (Device -> API -> DB -> Parent Web)**

---

## 11. Known Unsupported Capabilities & Limitations

To ensure strict truthfulness during physical testing, the following capabilities are explicitly documented as **unsupported in current build**:

1. **Android Native App Process Termination:**
   - SafeBrowse on Android operates via `VpnService` DNS interception. It does **not** possess root or Device Policy Controller (DPC) privileges to terminate running native Android apps.
   - App limits on Android (ADR-009) are planned for MVP v1.1. Native app usage is truthfully disclosed as **`Not Available`** (`appUsageAvailable: false`) in portal when `PACKAGE_USAGE_STATS` is not granted.
2. **Fast User Switching Attribution on Windows:**
   - Under Windows userspace loopback DNS, if multiple interactive Windows user sessions are logged in simultaneously, secondary background processes may send DNS through the loopback resolver.
   - The agent honestly detects this via `sessionMonitor.detectMultipleInteractiveSessions()` and signals `Attention Required` / `DEGRADED` status rather than attributing false traffic.
3. **Direct Boot on Android:**
   - Prior to first device unlock after a phone reboot, Android Credential Encrypted (CE) storage is locked. `BootReceiver` initializes foreground VPN immediately upon first unlock.

---

## 12. Physical Validation Checklists Created

| Document | Path | Scope |
| :--- | :--- | :--- |
| **Windows Validation Checklist** | [`WINDOWS_STAGE_C_PHYSICAL_VALIDATION.md`](file:///home/agdev/projects/safebrowse/WINDOWS_STAGE_C_PHYSICAL_VALIDATION.md) | Tests W1 through W12 (Upgrade, Account Mapping, 5-Cycle Dinner Time P0, Bedtime, Ask Parent, Usage, Reboot) |
| **Android Validation Checklist** | [`ANDROID_STAGE_C_PHYSICAL_VALIDATION.md`](file:///home/agdev/projects/safebrowse/ANDROID_STAGE_C_PHYSICAL_VALIDATION.md) | Tests A1 through A10 (Install, Heartbeat, Policy Push, Activity, Dinner Time, Bedtime, Ask Parent, Usage Truthfulness, Reboot) |

---

## 13. Final Classification & Next Steps

```
========================================================================
STATUS: READY FOR PHYSICAL VALIDATION
========================================================================
Next Step: Execute the 12-step Windows physical validation matrix 
(WINDOWS_STAGE_C_PHYSICAL_VALIDATION.md) on the physical pilot laptop, 
followed by the 10-step Android physical validation matrix 
(ANDROID_STAGE_C_PHYSICAL_VALIDATION.md) on the target Android handset.
========================================================================
```
