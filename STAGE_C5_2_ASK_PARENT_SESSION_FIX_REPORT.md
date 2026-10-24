# SafeBrowse Stage C.5.2: Ask Parent + Active Windows Session Correction Report

**Date:** 2026-10-24  
**Classification:** **`READY FOR ASK PARENT + FAST USER SWITCHING PHYSICAL VALIDATION`**  
*(Strict Notice: DO NOT classify as Pilot Ready until Cloud VM2 deployment, production migration reconciliation, and clean physical laptop validation succeed.)*  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Git Baseline Commit:** `3b8d125a1e9d737cfb2e8767372f8f0bc1672927`  
**Git Source Commit (HEAD):** `0514feb48e6467389a95781a967f6cfb71e84dfa`  
**GitHub Actions Build Run:** [#40092390551](https://github.com/dicanshulporwal-hub/safechild/actions/runs/40092390551) (SUCCESS)  
**Candidate Version:** `1.0.4-validation`  
**Windows Protocol Version:** `3`  
**Windows MSI ProductVersion:** `1.0.4.9`  
**Android Release versionCode:** `5` (versionName `1.0.4-validation`)  
**Production Backend URL:** `https://safebrowse.porwal.online`  

---

## 1. Executive Summary

During physical Windows validation of Stage C.5.1 on a shared family laptop, an essential parental-control workflow failed:
When a parent switched users to a child account via **Fast User Switching (FUS)**:
- Blocked websites were filtered correctly at the DNS level (returning authoritative `NXDOMAIN`).
- **However, the active child never received the SafeBrowse block page containing the "Ask Parent" button.**

Inspection of the physical machine revealed:
```
quser output:
USERNAME        SESSIONNAME    ID    STATE
anshulporwal                   4     Disc
mporwal         console        5     Active
```
And `SafeBrowseUserHelper.exe` was running in both Session 4 and Session 5.

### Root Cause
1. **Flawed Concurrency Detection:** `WindowsAccountManager.detectMultipleInteractiveSessions()` previously counted distinct `explorer.exe` process owners via `Get-Process explorer -IncludeUserName`. In Windows Fast User Switching, a disconnected or switched-out user session retains its `explorer.exe` process tree in memory. Counting process owners incorrectly flagged the system as having multiple concurrent interactive users (`hasMultipleSessions = true`).
2. **False Safety Hold:** `BlockIpcServer.presentBlock()` suppressed block presentation with `CONCURRENT_SESSIONS_SAFETY_HOLD` whenever `hasMultipleSessions` was true, preventing block UI display in the active child session.
3. **Session-Blind IPC Handshake:** `SafeBrowseUserHelper` sent only its Windows account name and PID during `REGISTER_HELPER` handshake, omitting its Terminal Services `SessionId`. Consequently, the service could not disambiguate between helper instances across switched user sessions.
4. **Session 0 Self-Healing Gap:** If `SafeBrowseUserHelper.exe` was terminated or failed to launch via the Run key upon Fast User Switching, the service lacked an automated mechanism to spawn the helper into the active console session.

### Resolution Summary
Stage C.5.2 completely eliminates these issues by transitioning from process-heuristic session tracking to **authoritative Windows Terminal Services API state**:
1. **Terminal Services Session State Truth:** `SafeBrowseServiceHost.cs` and `WindowsAccountManager` now query native Terminal Services APIs (`WTSEnumerateSessions`, `WTSQuerySessionInformation`, `WTSGetActiveConsoleSessionId`) or parse `quser.exe`. Sessions are strictly partitioned into `ACTIVE` (`WTSActive`) versus `DISCONNECTED` (`WTSDisconnected`).
2. **Disconnected Sessions Never Trigger Safety Hold:** Disconnected user sessions do not occupy the physical display or input devices. They do not trigger `CONCURRENT_SESSIONS_SAFETY_HOLD` or `ATTENTION_REQUIRED`. Safety holds are strictly reserved for genuine simultaneous active sessions (e.g. concurrent Active Console + Active RDP).
3. **Session-Targeted Block Presentation:** `SafeBrowseUserHelper` transmits `Process.GetCurrentProcess().SessionId` during handshake. When presenting a block page, `BlockIpcServer` targets the helper instance matching the active console `policy.sessionId`. Disconnected sessions receive zero presentation messages.
4. **Session 0 Self-Healing User Helper Spawning:** Running as `LocalSystem` in Session 0, `SafeBrowseServiceHost.cs` uses `WTSQueryUserToken` and `CreateProcessAsUser` to launch `SafeBrowseUserHelper.exe` silently into `winsta0\default` of the active console session if it is not already running.
5. **End-to-End Ask Parent Attribution:** The active child (`mporwal` mapped to child `Rahul`) is correctly reflected in the local block server provider (`blockServer.setActiveChildProvider`). Clicking "Ask Parent" submits the request to the cloud with the active child's ID, which immediately appears in the Parent Portal for 1-click approval.

---

## 2. Technical Architecture & Terminal Services Model

### 2.1. Fast User Switching (FUS) State Model

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Physical Hardware Console                       │
│                         (Display / Keyboard / Mouse)                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                         Active Console Session = 5
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Session 5: Child (mporwal -> Rahul)                   │
│  State: WTSActive | Console: YES                                       │
│  - explorer.exe (Desktop GUI)                                          │
│  - SafeBrowseUserHelper.exe (PID 8412, SessionId: 5)                   │
│      └── Connected to \\.\pipe\SafeBrowseBlockPipe                     │
│  - Default Browser (Edge / Chrome)                                     │
│      └── Receives PRESENT_BLOCK -> Launches 127.0.0.1:8880/blocked    │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                Session 4: Parent (anshulporwal -> Unmanaged)           │
│  State: WTSDisconnected | Console: NO                                  │
│  - explorer.exe (Retained in RAM, switched out)                        │
│  - SafeBrowseUserHelper.exe (PID 6120, SessionId: 4)                   │
│      └── Connected to \\.\pipe\SafeBrowseBlockPipe                     │
│      └── Suppressed: 0 block presentations routed                      │
└────────────────────────────────────────────────────────────────────────┘

                                    ▲
                                    │ Named Pipe IPC (SessionId Targeted)
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│                    Windows Service (Session 0 - LocalSystem)           │
│  SafeBrowseServiceHost.cs / Node.js Engine                             │
│  - WTSGetActiveConsoleSessionId() -> 5                                 │
│  - WTSEnumerateSessions() -> Session 5: Active, Session 4: Disc        │
│  - state/active-session.json:                                          │
│      { activeConsoleSessionId: 5, activeSessions: [...], ... }         │
│  - Policy Resolver: maps Session 5 to childId "child-rahul-101"        │
│  - BlockLandingServer: serves Ask Parent for "child-rahul-101"         │
│  - BlockIpcServer: routes block presentation strictly to SessionId 5   │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2. Session Classification & Concurrency Logic

| Session State | WTS State Code | Console Attached? | Treats as Concurrent Active User? | Block Page Behavior |
|---|---|---|---|---|
| **Active Console** | `WTSActive` (0) | Yes (`WTSGetActiveConsoleSessionId()`) | **Active Single User** | Block presented to this session's helper |
| **Disconnected** | `WTSDisconnected` (4) | No | **Ignored for Concurrency** | Block presentation suppressed |
| **Active RDP + Active Console** | `WTSActive` (0) x2 | Console + Remote | **True Concurrency (>1 Active)** | Safety hold engaged (`CONCURRENT_SESSIONS_SAFETY_HOLD`) |
| **Service / System** | `WTSActive` (0) | Session 0 | **Ignored** (Non-interactive) | Ignored |

---

## 3. Implementation Details

### 3.1. `packages/agent-windows/src/account-manager.ts`
- **Native Session File Integration:** Reads `state/active-session.json` written atomically by `SafeBrowseServiceHost.cs`.
- **`MultiSessionCheckResult` Interface:**
  ```typescript
  export interface MultiSessionCheckResult {
    hasMultipleSessions: boolean;
    hasMultipleActiveInteractiveSessions?: boolean;
    activeSessions: string[];
    activeInteractiveSessions?: InteractiveSessionInfo[];
    disconnectedSessions?: DisconnectedSessionInfo[];
    rawOutput?: string;
  }
  ```
- **Terminal Services Fallback Parser:** If `active-session.json` is absent, invokes `quser.exe` and categorizes sessions by `STATE` (`Active` vs `Disc`).
- **`getActiveConsoleSession()` & `resolveUserPolicy()`:** Propagates `sessionId: number | null` in `ResolvedUserPolicy`, linking the active Windows account directly to its Terminal Services session ID.

### 3.2. `packages/agent-windows/src/block-ipc.ts`
- **Helper Registration with Session ID:**
  ```typescript
  export interface HelperRegisterMessage {
    type: 'REGISTER_HELPER';
    accountName: string;
    pid: number;
    sessionId?: number;
  }
  ```
- **Concurrency Safety Hold Correction:**
  Checks `multiSession.hasMultipleActiveInteractiveSessions ?? (multiSession.activeInteractiveSessions ? multiSession.activeInteractiveSessions.length > 1 : multiSession.hasMultipleSessions)`. Switched-out disconnected sessions do not trigger safety hold.
- **Session-Targeted Routing:**
  Prioritizes exact `sessionId` matching:
  ```typescript
  const targetHelper = (targetSessionId !== null && targetSessionId !== undefined)
    ? this.connectedHelpers.find(h => h.sessionId === targetSessionId)
      ?? this.findHelperForAccount(activeAccount)
    : this.findHelperForAccount(activeAccount);
  ```
- **Self-Healing Callback:** Added `setHelperLauncher()` to trigger immediate spawning if no helper is connected for the active session.

### 3.3. `packages/agent-windows/user-helper/SafeBrowseUserHelper.cs`
- Transmits native `Process.GetCurrentProcess().SessionId` in the `REGISTER_HELPER` JSON payload upon connecting to `\\.\pipe\SafeBrowseBlockPipe`.

### 3.4. `packages/agent-windows/service-host/SafeBrowseServiceHost.cs`
- **P/Invoke Terminal Services:** Imported `WTSEnumerateSessions`, `WTSQuerySessionInformation`, `WTSFreeMemory`, `WTSGetActiveConsoleSessionId`, and `WTSQueryUserToken`.
- **`UpdateActiveConsoleSession()`:**
  - Queries active console session ID from Windows kernel.
  - Enumerates all sessions, resolving username, domain, and connection state (`WTSActive` vs `WTSDisconnected`).
  - Writes `active-session.json` atomically with `activeConsoleSessionId`, `activeSessions`, and `disconnectedSessions`.
- **`EnsureUserHelperRunning(uint sessionId)`:**
  - Checks if `SafeBrowseUserHelper` process exists in the target session.
  - If not running, obtains user primary token via `WTSQueryUserToken(sessionId, out hUserToken)`.
  - Spawns `SafeBrowseUserHelper.exe` using `CreateProcessAsUser` into desktop `winsta0\default` with `CREATE_NO_WINDOW`.
  - Triggered in `OnSessionChange` (SessionLogon, SessionUnlock, ConsoleConnect), `OnStart`, and the 5-second service worker loop.

---

## 4. Automated Verification & Test Results

### 4.1. Unit and Integration Test Results

All test suites passed 100% across the workspace:

```
Test Suites: 16 passed, 16 total
Tests:       272 passed, 272 total
Snapshots:   0 total
Time:        4.571 s
```

Key integration tests added in `packages/agent-windows/tests/service-block-ipc-integration.test.ts`:
- **Test 7 (FUS Disconnected Session):** Active console child session 5 with disconnected parent session 4 correctly resolves `hasMultipleActiveInteractiveSessions: false` and routes block page strictly to Session 5 helper.
- **Test 8 (Real Concurrency Hold):** Active console child session 5 with concurrent Active RDP session 6 correctly triggers `CONCURRENT_SESSIONS_SAFETY_HOLD`.
- **Test 9 (Sequential User Switching):** Parent switches to Child -> Block presented. Child switches back to Parent -> Block presentation suppressed.
- **Test 10 (Multi-Session Same User):** Reroutes cleanly to console session instance.
- **Test 11 (Helper Self-Healing Trigger):** Verifies service host triggers user helper launch when no helper is connected in the active console session.
- **Test 12 (Ask Parent E2E Attribution):** End-to-end test verifying block server serves block page with `childId: "child-rahul-101"`, submits request, and Parent Portal approves access.

Full regression tests passed:
- `@safebrowse/agent-windows`: 16 suites (272 tests)
- `@safebrowse/backend`: 48 suites (264 tests)
- `@safebrowse/shared`: 1 suite (12 tests)
- `@safebrowse/protocol`: 2 suites (10 tests)
- `@safebrowse/parent-web`: Vite build clean (0 errors, 9.97s)

### 4.2. GitHub Actions CI Build Run

- **Run ID:** `40092390551`
- **Workflow:** `build-windows-msi.yml` ("Windows MSI Pilot Packaging")
- **Trigger Commit:** `0514feb48e6467389a95781a967f6cfb71e84dfa`
- **Duration:** 6m 56s
- **Status:** **SUCCESS**
- **Artifact:** `SafeBrowseChild-Pilot-MSI` (Contains MSI, single-exe bundle, service host, and user helper)

---

## 5. Build Artifacts & Provenance Manifest

| Artifact File | Size (Bytes) | SHA-256 Checksum |
|---|---|---|
| `release/windows-validation/SafeBrowseChild-Validation.msi` | 23,457,792 | `a055d48bf67e92aa1fe93c5393e4f913351edcbcb52097d6fd0e5dcd0ecf6e0c` |
| `release/windows-validation/SafeBrowseChild-Validation.exe` | 73,208,832 | `027e95de2293d86d9f6b88217c6b2df71722e2e6284479ae692b7c55d3badf55` |
| `release/windows-validation/SafeBrowseServiceHost.exe` | 43,520 | `dd70449c173ea140b522a241dba2c23b21ead020559e3874347bc9aad3532a7a` |
| `release/windows-validation/SafeBrowseUserHelper.exe` | 7,168 | `b1f6cf1fc233c5ef7d36cf16a8c22f189c35e210e444dcdcbc7c6b862af23b10` |
| `release/android/SafeBrowseChild-Validation-1.0.4.apk` | 5,641,147 | `42e782c1de57e4e78e5e85f80ed002e73e54a7fca50eb02699a7d4af46539e9d` |

All checksums verified via `sha256sum -c release/SHA256SUMS-validation.txt`.

---

## 6. Physical Laptop Validation Runbook

Follow these exact steps on the physical family Windows laptop (`LAPTOP-AAN0K715`):

### Step 1: Install Update
1. Copy `release/windows-validation/SafeBrowseChild-Validation.msi` (ProductVersion `1.0.4.9`) to the physical laptop.
2. In an elevated Administrator PowerShell prompt:
   ```powershell
   msiexec /i SafeBrowseChild-Validation.msi /qn /l*v install-c52.log
   ```
3. Verify service is running:
   ```powershell
   Get-Service SafeBrowseChildService
   ```

### Step 2: Establish Fast User Switching Scenario
1. Log into the parent account (`anshulporwal`).
2. Switch user to the child account (`mporwal` mapped to Rahul) via Start Menu -> User Profile -> Switch User.
3. Open an administrative command prompt or PowerShell and verify session states:
   ```powershell
   quser
   ```
   **Expected Output:**
   - Parent (`anshulporwal`): State `Disc`
   - Child (`mporwal`): State `Active`, Session `console`
4. Verify `SafeBrowseUserHelper.exe` is running in child session 5:
   ```powershell
   Get-Process SafeBrowseUserHelper -IncludeUserName
   ```

### Step 3: Trigger DNS Block & Verify Block Page
1. While logged into child session (`mporwal`), open Microsoft Edge or Google Chrome.
2. Navigate to a blocked domain (e.g. `http://tiktok.com` or `http://badsite.com`).
3. **Observed Pass Criteria:**
   - DNS query fails as expected.
   - Browser automatically navigates to `http://127.0.0.1:8880/blocked?domain=tiktok.com&reason=category_blocked`.
   - SafeBrowse Block Page is presented prominently on the active desktop.
   - The block page displays "Ask Parent" button and identifies child as Rahul.
   - Parent's disconnected session does NOT open any block pages.

### Step 4: Validate Ask Parent End-to-End
1. On the block page in child session, click **"Ask Parent"**.
2. Enter an optional reason: "Need this for homework".
3. Submit the request.
4. Open the Parent Portal on phone or parent PC (`https://safebrowse.porwal.online`).
5. Verify the request appears instantly under **Access Requests** for child Rahul on `LAPTOP-AAN0K715`.
6. Click **"Approve (15 Minutes)"**.
7. Return to the child's browser, refresh `http://tiktok.com`.
8. Verify domain now loads normally.

---

## 7. Next Stage Gate Criteria

| Gate Item | Status | Notes |
|---|---|---|
| FUS Concurrency Detection Fix | **COMPLETE** | Uses Terminal Services API (`WTSActive` vs `WTSDisconnected`) |
| Session-Aware Block Presentation | **COMPLETE** | Routes block to helper matching active console session ID |
| Session 0 Self-Healing Launch | **COMPLETE** | Spawns helper via `WTSQueryUserToken` + `CreateProcessAsUser` |
| Automated Integration Suite | **COMPLETE** | 12/12 integration tests passed, 272/272 windows agent tests passed |
| Windows MSI Build 1.0.4.9 | **COMPLETE** | CI Run `40092390551` SUCCESS |
| Physical Laptop FUS Validation | **PENDING** | Ready for execution via Section 6 runbook |
| Production VM2 Deployment | **HOLD** | Do NOT deploy until physical validation succeeds |
| Release Classification | **STRICT** | **`READY FOR ASK PARENT + FAST USER SWITCHING PHYSICAL VALIDATION`** |
