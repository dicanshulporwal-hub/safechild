# SafeBrowse — Stage C.3.1: Block IPC Service Wiring Report

## Executive Summary
- **Classification:** `READY FOR BLOCK-PAGE PHYSICAL RETEST` *(Strictly not classified as Pilot Ready until physical device retest succeeds)*
- **Git Commit:** `1ad8b455165168862a08fa530be8401638db5878`
- **Parent Commit:** `e314b2ebb71c64f5fb493ed065e9d853d057ba78`
- **Baseline Commit:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`
- **Branch:** `feature/stage11-step4-device-enforcement`
- **Candidate Semantic Version:** `1.0.4-validation`
- **Windows MSI ProductVersion:** `1.0.4.2` (with `AllowSameVersionUpgrades="yes"`)
- **Android Version:** `versionName = 1.0.4-validation`, `versionCode = 4`
- **Target Backend:** `https://safebrowse.porwal.online`

---

## 1. Root Cause Analysis
During physical validation on `LAPTOP-AAN0K715`:
1. `SafeBrowseUserHelper.exe` was running in the interactive child session (`Manjari`).
2. The local block page server was functional at `http://127.0.0.1:8880/blocked?domain=example.com&reason=TEST`.
3. Blocked domains correctly returned `NXDOMAIN`.
4. However, the block page was still not automatically presented in the child's browser.

**Source-Level Defect Confirmed:**
- In `agent-cli.ts`, while policy and multi-session providers were configured on `blockIpcServer`, the service startup sequence **never called `await blockIpcServer.start()`**. Consequently, no named pipe server was ever created on the physical machine, leaving `SafeBrowseUserHelper.exe` in a persistent connection-retry loop.
- In `agent-cli.ts`, `dnsProxy.setOnBlockExperienceTriggered` called `blockServer?.triggerBlockExperience(domain, reason)` instead of directly executing and logging `blockIpcServer.presentBlock(domain, reason, 8880)`.
- Named pipes created by `NT AUTHORITY\SYSTEM` in Session 0 in Windows default to DACLs that restrict write access for standard users (`BUILTIN\Users`), requiring explicit local DACL configuration to permit non-elevated child helpers to register.

---

## 2. Implementation & Architecture of Fix

### A. Service Startup Lifecycle (`agent-cli.ts`)
Immediately following `BlockPageServer` initialization and session provider configuration:
```typescript
// Connect active session and multi-session policy providers to Block IPC Server
blockIpcServer.setActivePolicyProvider(() => sessionMonitor.getCurrentPolicy());
blockIpcServer.setMultiSessionChecker(() => sessionMonitor.getMultiSessionState());

// Start Block IPC Server for user-session helper presentation
try {
  await blockIpcServer.start();
  logServiceMessage('INFO', `[BlockIpcServer] Listening on ${blockIpcServer.getPipePath()}`);
} catch (ipcErr: any) {
  logServiceMessage(
    'WARN',
    `[BlockIpcServer] [WARN] Failed to start Block IPC Server: ${ipcErr.message}. Block-page presentation degraded.`
  );
}
```
*Failure to start IPC logs a clear warning without crashing DNS enforcement or the core service.*

### B. DNS Block Event Routing (`agent-cli.ts`)
The DNS blocked event callback is now wired directly to `blockIpcServer.presentBlock()` and writes structured diagnostic logs to `C:\ProgramData\SafeBrowse\logs\agent-service.log`:
```typescript
dnsProxy.setOnBlockExperienceTriggered((domain, reason) => {
  const result = blockIpcServer.presentBlock(domain, reason, 8880);
  logServiceMessage(
    'INFO',
    `[SafeBrowse Service] Block presentation for '${domain}': ${result.reason} (sent=${result.sent})`
  );
});
```
Structured reasons logged:
- `PRESENTED`
- `NO_CONNECTED_HELPER`
- `PARENT_OR_UNMANAGED_USER`
- `CONCURRENT_SESSIONS_SAFETY_HOLD`
- `DOMAIN_DEBOUNCED`
- `GLOBAL_THROTTLED`

*Zero device tokens, credentials, or secrets are ever exposed.*

### C. Graceful Teardown (`agent-cli.ts` & `block-ipc.ts`)
In `gracefulShutdown`:
```typescript
try {
  await blockIpcServer.stop();
} catch (ipcErr: any) {
  logServiceMessage('WARN', `[SafeBrowse Service] Warning during Block IPC teardown: ${ipcErr.message}`);
}
```
`blockIpcServer.stop()` terminates all helper connections, closes the server, and unlinks stale socket files on non-Windows platforms.

### D. Windows Named Pipe Access Control (`block-ipc.ts`)
To ensure the non-elevated `SafeBrowseUserHelper.exe` running in a standard child user account can connect and write its registration handshake:
- `configureWindowsPipeSecurity(pipePath)` applies an explicit local Security Descriptor (SDDL) upon pipe creation:
  `D:(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)(A;;GRGW;;;AU)`
  - `(D;;GA;;;NU)`: Deny Generic All to Network Users (blocks remote attacks over LAN/SMB).
  - `(A;;GA;;;SY)`: Allow Generic All to Local SYSTEM.
  - `(A;;GA;;;BA)`: Allow Generic All to Built-in Administrators.
  - `(A;;GRGW;;;IU)`: Allow Generic Read & Write to Interactive Users (the logged-in child console session).
  - `(A;;GRGW;;;AU)`: Allow Generic Read & Write to Authenticated Users.

### E. BlockPageServer Decoupling (`block-server.ts`)
- `BlockPageServer.start()` no longer creates an untracked, unconfigured duplicate IPC server instance.
- Direct process spawning from Session 0 (`msedge.exe`, `cmd.exe /c start`) is completely eliminated.
- Local HTTP landing page continues to run securely on `127.0.0.1:8880`.

---

## 3. Mandatory Integration Test Results

A dedicated service integration test suite was created in `packages/agent-windows/tests/service-block-ipc-integration.test.ts`.

| Test Case | Description | Result |
| :--- | :--- | :--- |
| **Test 1** | Service startup -> `blockIpcServer.start()` -> helper registers -> receives `REGISTER_ACK` (`status: OK`) | **PASS** |
| **Test 2** | DNS BLOCK event callback routes through `blockIpcServer.presentBlock` and delivers `PRESENT_BLOCK` to helper | **PASS** |
| **Test 3** | Active parent session suppresses presentation with `PARENT_OR_UNMANAGED_USER` | **PASS** |
| **Test 4** | Fast User Switching multi-session suppresses presentation with `CONCURRENT_SESSIONS_SAFETY_HOLD` | **PASS** |
| **Test 5** | Triggering block when no helper is running returns `NO_CONNECTED_HELPER` | **PASS** |
| **Test 6** | Graceful shutdown closes pipe server and terminates helper connections cleanly | **PASS** |

### Complete Regression Status:
- **`@safebrowse/agent-windows`:** 12 / 12 test suites passed (**257 / 257 tests passed**, 0 failures).
- **`@safebrowse/shared`:** 2 / 2 test suites passed (**9 / 9 tests passed**, 0 failures).
- **`@safebrowse/parent-web`:** Production Vite build clean (`dist` generated in 9.91s).
- **`@safebrowse/backend`:** TypeScript type check clean (`tsc --noEmit` exited with code 0).
- **GitHub Actions Windows CI (Run `39774378666`):** 100% green (`conclusion: success`).

---

## 4. Artifact Provenance & SHA-256 Checksums

```
ece03f23a5be936fce26f41517286c2bfe1134673cf0da83ea11fca704c2383b  release/android/SafeBrowseChild-Validation-1.0.4.apk
07308a85958aca4bc80855304a2c25c487b32e5d346cb82961caabe4fc48da40  release/windows-validation/SafeBrowseChild-Validation.msi
af8a38b614208912dc7110c08a48babf00b3f07933a745f45b034e5b17ca3d78  release/windows-validation/SafeBrowseChild-Validation.exe
252353384f2f61175ee05a50ce7d6c660d47584e7114b271999ebf0df0935044  release/windows-validation/SafeBrowseServiceHost.exe
66662b89c3ad11bb25706acfca28b9424a2de8a5bcd6348dc95fa04c6b2c71e7  release/windows-validation/SafeBrowseUserHelper.exe
```

### File Sizes:
- `SafeBrowseChild-Validation.exe`: `73,120,256` bytes
- `SafeBrowseChild-Validation.msi`: `23,461,888` bytes
- `SafeBrowseServiceHost.exe`: `37,888` bytes
- `SafeBrowseUserHelper.exe`: `7,168` bytes
- `SafeBrowseChild-Validation-1.0.4.apk`: `5,641,024` bytes

*Verified and recorded in [release/SHA256SUMS-validation.txt](file:///home/agdev/projects/safebrowse/release/SHA256SUMS-validation.txt) and [release/VALIDATION_PROVENANCE.json](file:///home/agdev/projects/safebrowse/release/VALIDATION_PROVENANCE.json).*

---

## 5. Physical Retest Instructions

### Step 1: Install Updated Validation MSI
On the physical test laptop (`LAPTOP-AAN0K715`), open an elevated PowerShell prompt:
```powershell
msiexec /i SafeBrowseChild-Validation.msi /qn /l*v upgrade.log
```
*Note: ProductVersion `1.0.4.2` cleanly upgrades over `1.0.4.1` with `AllowSameVersionUpgrades="yes"`.*

### Step 2: Verify Service & Helper Processes
Log in to the child account (`Manjari`). Open PowerShell and run:
```powershell
Get-Process SafeBrowseServiceHost   # Running in Session 0 (SYSTEM)
Get-Process SafeBrowseUserHelper    # Running in Session 1+ (Manjari)
```

### Step 3: Inspect Service Log for Pipe Startup & Handshake
Check `C:\ProgramData\SafeBrowse\logs\agent-service.log`:
```powershell
Get-Content -Tail 50 -Wait C:\ProgramData\SafeBrowse\logs\agent-service.log
```
**Expected lines:**
```
[BlockIpcServer] Listening on \\.\pipe\SafeBrowseBlockPipe
[BlockIpcServer] Helper registered: account='Manjari', PID=<helper-pid>
```

### Step 4: Trigger Blocked Domain in Child Session
1. In the child session, open any browser (Google Chrome, Microsoft Edge, or Mozilla Firefox).
2. Navigate to a blocked domain (e.g. `http://example.com` or `https://instagram.com`).
3. **Expected Behavior:**
   - The browser tab displays `NXDOMAIN`.
   - The default browser opens the SafeBrowse Block Page:
     `http://127.0.0.1:8880/blocked?domain=...&reason=...`
   - In `C:\ProgramData\SafeBrowse\logs\agent-service.log`:
     `[SafeBrowse Service] Block presentation for '...': PRESENTED (sent=true)`
   - The Ask Parent button is visible and interactive.

### Step 5: Test Parent Session Exemption
1. Switch user to the Parent / Admin account (`acer`).
2. Navigate to any website.
3. Confirm that no block page popups appear, and the service log records:
   `[BlockIpcServer] Suppressed block presentation: Active user 'acer' is Unmanaged/Parent.`

---

## 6. Status
**Classification:** `READY FOR BLOCK-PAGE PHYSICAL RETEST`  
*(Pilot release `v1.0.3-pilot` remains untouched; `v1.0.4-pilot` will only be published after physical confirmation).*
