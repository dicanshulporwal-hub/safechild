# SafeBrowse Stage C.5.3: Windows Named Pipe ACL & Ask Parent Delivery Reliability Report

**Date:** 2026-10-24  
**Classification:** **`READY FOR C5.3 NAMED-PIPE + ASK-PARENT PHYSICAL VALIDATION`**  
*(Strict Notice: DO NOT classify as Pilot Ready until Cloud VM2 deployment, production migration reconciliation, and clean physical laptop validation succeed.)*  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Git Baseline Commit:** `84d9fcc4c4d5ab851af86b16be883e797beb8fcc`  
**Git Source Commit (HEAD):** `6b5413b590c81de7042916eef3387502143a6237`  
**GitHub Actions Build Run:** [#40098647302](https://github.com/dicanshulporwal-hub/safechild/actions/runs/40098647302) (SUCCESS)  
**Candidate Version:** `1.0.4-validation`  
**Windows Protocol Version:** `3`  
**Windows MSI ProductVersion:** `1.0.4.10`  
**Android Release versionCode:** `5` (versionName `1.0.4-validation`)  
**Production Backend URL:** `https://safebrowse.porwal.online`  

---

## 1. Executive Summary & Physical Defect Resolution

During physical Windows validation of Stage C.5.2 on a shared laptop running Fast User Switching:
- Session 4 (`AzureAD\AnshulPorwal`) was `DISCONNECTED`.
- Session 5 (`Anshul\mporwal`) was `ACTIVE CONSOLE` and mapped to child `Manjari`.
- The Windows service correctly identified the active child:
  `Active user 'Anshul\mporwal' mapped to child 'Manjari'`
- The local HTTP block server on `http://127.0.0.1:8880/blocked` was healthy, returning HTTP 200 with the "Ask Parent" interface.
- `SafeBrowseUserHelper.exe` was running non-elevated in Session 5.

**However, block presentation returned `NO_CONNECTED_HELPER`**, and the child never saw the block page open in the browser.

### Root Cause Analysis
1. **Named Pipe DACL Pointer Type Mismatch:**
   In `BlockIpcServer.configureWindowsPipeSecurity()`, the Win32 API `ConvertStringSecurityDescriptorToSecurityDescriptor` returned a pointer to a full `SECURITY_DESCRIPTOR` structure (`pSD`). The code then passed `pSD` directly into `SetNamedSecurityInfo`'s `pDacl` parameter. Because `SetNamedSecurityInfo` expects a pointer to an access control list (`PACL`), passing the `PSECURITY_DESCRIPTOR` header corrupts the DACL pointer. As a result, Windows rejected non-elevated client connections with:
   ```
   System.UnauthorizedAccessException: Access to the path is denied.
   ```
2. **NPFS DACL Container Inheritance Rejection (Win32 Error 87):**
   When invoking `SetNamedSecurityInfo` on a Named Pipe File System (NPFS) path (`\\.\pipe\...`), passing unadorned `DACL_SECURITY_INFORMATION` (4) causes Windows to evaluate container inheritance. Because NPFS does not support container inheritance, Win32 returns error `87` (`ERROR_INVALID_PARAMETER`). To apply DACLs cleanly to named pipes, `PROTECTED_DACL_SECURITY_INFORMATION` (`0x80000000`, making the flag `0x80000004`) must be specified alongside a protected SDDL (`D:P...`).
3. **Premature Debounce Consumption:**
   In `BlockIpcServer.presentBlock()`, the debounce timestamps (`lastDomainTriggerTimes` and `lastGlobalTriggerTime`) were updated *before* evaluating whether any helper was connected. When no helper was connected, `presentBlock` returned `NO_CONNECTED_HELPER` but burned the domain debounce window. When a helper connected shortly thereafter, subsequent block presentations were suppressed with `DOMAIN_DEBOUNCED`.
4. **Helper Connection Error Swallowing & Silent Failure:**
   `SafeBrowseUserHelper.cs` caught pipe connection exceptions without diagnostic logging, making it impossible to determine whether failures were due to missing pipes, DACL denials, or timeout issues. It also lacked handling for `REGISTER_ACK` confirmation.

### Resolution Summary
1. **Win32 PACL Extraction & Multi-Strategy Application:**
   `configureWindowsPipeSecurity()` now explicitly invokes `GetSecurityDescriptorDacl(pSD, out daclPresent, out pDacl, out daclDefaulted)` to extract the true `PACL` pointer before setting security. It applies `0x80000004` (`DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION`), validates return codes, and falls back to handle-based `CreateFile(WRITE_DAC)` + `SetSecurityInfo(SE_KERNEL_OBJECT)` if name-based setting fails. `pSD` is reliably freed via `LocalFree(pSD)` in `finally`.
2. **Debounce Preservation & Bounded Auto-Retry Queue:**
   Debounce timestamps are updated *only* when `targetFound === true`. When no helper is connected, `presentBlock()` enqueues a bounded `PendingBlockPresentation` (15s TTL, max 1 retry per session/domain) and invokes `helperLauncher`. The moment the helper completes `REGISTER_HELPER`, the queue is automatically flushed, delivering the block page without delay.
3. **Safe Diagnostic Logging in Helper:**
   `SafeBrowseUserHelper.cs` writes rolling diagnostic logs (1MB limit) to `%LOCALAPPDATA%\SafeBrowse\logs\user-helper.log`. It logs process startup, session ID, connection attempts, rate-limited errors (10s throttle), registration payloads, `REGISTER_ACK` receipts, and block presentation triggers.

---

## 2. Technical Architecture & Security Model

```
+----------------------------------------------------------------------------------------------------+
|                                    WINDOWS SERVICE (Session 0)                                     |
|                                                                                                    |
|  SafeBrowseServiceHost (LocalSystem)                                                               |
|    +-- BlockIpcServer: \\.\pipe\SafeBrowseBlockPipe                                                |
|          |                                                                                         |
|          +-- configureWindowsPipeSecurity()                                                        |
|          |     - SDDL: D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)(A;;GRGW;;;AU)        |
|          |     - ConvertStringSecurityDescriptorToSecurityDescriptor -> pSD                        |
|          |     - GetSecurityDescriptorDacl(pSD) -> extracted pDacl (PACL)                         |
|          |     - SetNamedSecurityInfo(pipePath, 1, 0x80000004, ..., pDacl)                         |
|          |     - Fallback: CreateFile(WRITE_DAC) -> SetSecurityInfo(hPipe, 6, 0x80000004, ..., pDacl)|
|          |     - LocalFree(pSD) in finally block                                                   |
|          |                                                                                         |
|          +-- presentBlock(domain, policy)                                                          |
|                - If helper not connected:                                                          |
|                |   * Do NOT update debounce timestamps                                             |
|                |   * Enqueue PendingBlockPresentation(sessionId, domain, url, 15s TTL)             |
|                |   * Trigger helperLauncher (WTSQueryUserToken + CreateProcessAsUser)              |
|                - If helper connected:                                                              |
|                |   * Send PRESENT_BLOCK to Session 5 helper                                         |
|                |   * Update lastDomainTriggerTimes & lastGlobalTriggerTime                         |
|                |   * Log [BlockIpcServer] Block presentation for 'domain': PRESENTED (sent=true)  |
+----------------------------------------------------------------------------------------------------+
                                      |   ^
                    Named Pipe Duplex |   | Non-Elevated NamedPipeClientStream
                                      v   |
+----------------------------------------------------------------------------------------------------+
|                                  ACTIVE CONSOLE (Session 5: Child)                                 |
|                                                                                                    |
|  SafeBrowseUserHelper.exe (Non-Elevated, winsta0\default)                                          |
|    +-- Connects to \\.\pipe\SafeBrowseBlockPipe (SUCCESS with IU/AU Read/Write ACL)                |
|    +-- Sends REGISTER_HELPER { account: 'mporwal', pid: 5432, sessionId: 5 }                     |
|    +-- Receives REGISTER_ACK                                                                       |
|    +-- Flushes queued block presentation -> Opens default browser to:                              |
|          http://127.0.0.1:8880/blocked?domain=...&childId=...&reqId=...                            |
|    +-- Logs diagnostics to %LOCALAPPDATA%\SafeBrowse\logs\user-helper.log                          |
+----------------------------------------------------------------------------------------------------+
```

### Named Pipe DACL Rights Summary
| Identity | SID | Right | SDDL Tag | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Network Logon** | `S-1-5-2` | **DENY ALL** | `(D;;GA;;;NU)` | Remote network access is explicitly blocked |
| **LocalSystem** | `S-1-5-18` | **ALLOW FULL** | `(A;;GA;;;SY)` | Windows service host owner full access |
| **Builtin Admins** | `S-1-5-32-544` | **ALLOW FULL** | `(A;;GA;;;BA)` | Administrative troubleshooting |
| **Interactive Users**| `S-1-5-4` | **ALLOW READ/WRITE**| `(A;;GRGW;;;IU)` | Standard non-elevated user helper in active session |
| **Authenticated Users**| `S-1-5-11` | **ALLOW READ/WRITE**| `(A;;GRGW;;;AU)` | Domain / Entra ID interactive user helper |

---

## 3. Implementation Details

### 1. `packages/agent-windows/src/block-ipc.ts`
- **P/Invoke Architecture:**
  - Added P/Invoke for `GetSecurityDescriptorDacl` to extract `pDacl` from `pSD`.
  - Added P/Invoke for `SetSecurityInfo`, `CreateFile`, and `CloseHandle` to support handle-based DACL application.
  - Specified `PROTECTED_DACL_SECURITY_INFORMATION` (`0x80000004`) to prevent NPFS inheritance error 87.
  - Passes `SB_PIPE_PATH` via `process.env` to the PowerShell helper script, preventing CLI quoting and escaping issues.
  - Implemented cleanup in `finally` via `LocalFree(pSD)`.
- **Pending Presentation Queue:**
  ```typescript
  interface PendingBlockPresentation {
    sessionId: number;
    account: string;
    domain: string;
    url: string;
    expiresAt: number;
    retries: number;
  }
  ```
  - When `matchedSockets.length === 0`, presentations are queued with a 15-second TTL.
  - Upon receiving `REGISTER_HELPER`, `flushPendingPresentationsForHelper()` automatically replays any pending presentation for that session.
  - Debounce timestamps are strictly guarded and updated only when presentation succeeds.

### 2. `packages/agent-windows/user-helper/SafeBrowseUserHelper.cs`
- Added rotating local file logger:
  - File: `%LOCALAPPDATA%\SafeBrowse\logs\user-helper.log`
  - Max Size: 1 MB (rotates to `.old`)
  - No secret or token data is logged.
- Enhanced connection loop:
  - Connects to `\\.\pipe\SafeBrowseBlockPipe` with 3000ms timeout.
  - Logs connection failures at most once every 10 seconds to eliminate log spam during boot.
  - Reconnects every 2.5 seconds without exiting or popping up UI.
  - Handles `REGISTER_ACK` and records confirmation.

### 3. Automated Test Suite
- `packages/agent-windows/tests/windows-pipe-acl-native.test.ts`:
  - **Test 1:** Verifies `NO_CONNECTED_HELPER` does NOT consume domain debounce timestamps.
  - **Test 2:** Verifies pending block presentations are automatically retried when a helper registers.
  - **Test 3:** Verifies Fast User Switching isolation (Session 4 Disconnected Parent receives 0 messages, Session 5 Active Child receives block presentation).
  - **Test 4 (Windows Native):** Native test verifying `configureWindowsPipeSecurity()` extracts PACL, applies `0x80000004`, and inspects DACL via `GetNamedSecurityInfo` / `GetSecurityInfo` (confirming `SY` Full, `BA` Full, `IU` Read/Write, `AU` Read/Write, `NU` Deny).
  - **Test 5 (Windows Native):** Native test verifying non-elevated client connects to named pipe and executes full bidirectional JSON handshake (`REGISTER_HELPER` -> `REGISTER_ACK`).

---

## 4. Verification Evidence

### 1. GitHub Actions Windows CI Build
- **Run ID:** `40098647302`
- **Workflow:** `.github/workflows/build-windows-msi.yml`
- **Result:** **SUCCESS** (`✓ Completed job in 6m54s`)
- **Key Steps Passed:**
  - `Verify PowerShell Account Discovery Script Syntax (AST Parser Gate)`: PASSED (2781 lines verified, 0 errors).
  - `Run Windows agent automated tests`: PASSED (All 17 suites, including Test 4 & Test 5 native Windows pipe DACL inspection).
  - `Compile Windows Service Host Wrapper (SafeBrowseServiceHost.exe)`: PASSED.
  - `Build Single Executable Application (SafeBrowseChild-Pilot.exe)`: PASSED.
  - `Build SafeBrowseChild-Pilot.msi via WiX Toolset`: PASSED (ProductVersion `1.0.4.10`).
  - `Upload SafeBrowse Windows Pilot MSI Artifact`: PASSED.

### 2. Full Workspace Regression Suite
| Workspace | Test Command | Result |
| :--- | :--- | :--- |
| `@safebrowse/agent-windows` | `npm test` | **17 suites, 383 tests passed (0 failed)** |
| `@safebrowse/shared` | `npm test` | **12 tests passed (0 failed)** |
| `@safebrowse/protocol` | `npm test` | **10 contracts verified (0 failed)** |
| `@safebrowse/backend` | `npm test` | **48 suites, 264 tests passed (0 failed)** |
| `@safebrowse/parent-web` | `npm run build` | **Vite production build passed in 7.62s** |

---

## 5. Artifact Hashes & Release Manifest

All binaries have been downloaded from CI Run `40098647302`, verified via `sha256sum`, and staged in `release/windows-validation/`:

| Artifact | SHA-256 | Size (bytes) | WiX ProductVersion |
| :--- | :--- | :--- | :--- |
| `SafeBrowseChild-Validation.msi` | `bdffd3cb5932da1d9bd23081efb639347dfb9013d285effaeaf7a15635940ac8` | 23,478,272 | `1.0.4.10` |
| `SafeBrowseChild-Validation.exe` | `8fe9f2cb8f9a354834b47a9257430667c7460e509ef4ceabafb848071a2cf703` | 73,216,000 | `1.0.4.10` |
| `SafeBrowseServiceHost.exe` | `f27a2d3afc378a4b6856996db3f5724449299c324652ac05390751ee85393226` | 43,520 | — |
| `SafeBrowseUserHelper.exe` | `46c93914da5df04a0249647b8e0cfcc5e27b4d0cd5c65e540efa0b5b0ce7b511` | 11,264 | — |
| `SafeBrowseChild-Validation-1.0.4.apk` | `42e782c1de57e4e78e5e85f80ed002e73e54a7fca50eb02699a7d4af46539e9d` | 5,641,147 | versionCode 5 |

Checksums match `release/SHA256SUMS-validation.txt` (`sha256sum -c release/SHA256SUMS-validation.txt` passed).

---

## 6. Physical Windows Validation Procedure

To validate Stage C.5.3 on the physical Windows laptop:

1. **Install Updated MSI:**
   ```powershell
   msiexec /i SafeBrowseChild-Validation.msi /qn
   ```
2. **Verify Service & Helper Status:**
   ```powershell
   Get-Service SafeBrowseChildService
   Get-Process SafeBrowseUserHelper
   ```
3. **Inspect Helper Log File:**
   In the child's session, inspect:
   ```powershell
   Get-Content "$env:LOCALAPPDATA\SafeBrowse\logs\user-helper.log" -Tail 20
   ```
   Confirm entries:
   - `SafeBrowseUserHelper started (PID=..., SessionId=5, User=Anshul\mporwal)`
   - `Connected to named pipe \\.\pipe\SafeBrowseBlockPipe`
   - `Sent registration: account=mporwal, pid=..., sessionId=5`
   - `Received registration acknowledgment (REGISTER_ACK)`
4. **Trigger DNS Block Under Child Session:**
   Under Session 5 (`Anshul\mporwal`), navigate in Edge/Chrome to a blocked site (e.g., `roblox.com` or `tiktok.com`).
5. **Verify Block Page Delivery & Ask Parent:**
   - Confirm browser opens `http://127.0.0.1:8880/blocked?domain=...&childId=...`.
   - Confirm block page displays "Ask Parent" button.
   - Click "Ask Parent" and verify the request is delivered to the Parent Portal.
6. **Confirm Disconnected Parent Session Receives No Block UI:**
   Confirm Session 4 (`AzureAD\AnshulPorwal`) receives zero popups or browser redirects while disconnected.

---

## 7. Final Classification

**Strict Classification:** **`READY FOR C5.3 NAMED-PIPE + ASK-PARENT PHYSICAL VALIDATION`**  
*(Strict Notice: DO NOT classify as Pilot Ready until Cloud VM2 deployment, production migration reconciliation, and clean physical laptop validation succeed.)*
