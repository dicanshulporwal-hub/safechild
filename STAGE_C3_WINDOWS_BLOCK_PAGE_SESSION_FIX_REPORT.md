# SafeBrowse — Stage C.3: Windows Child Block-Page / Ask-Parent Session Fix Report

## Executive Summary
- **Classification:** `READY FOR BLOCK-PAGE PHYSICAL RETEST` *(Strictly not classified as Pilot Ready until physical device retest succeeds)*
- **Git Commit:** `e314b2ebb71c64f5fb493ed065e9d853d057ba78`
- **Parent Commit:** `8470382b404aa8b3725c947b17339652ec361570`
- **Mandatory Baseline:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`
- **Branch:** `feature/stage11-step4-device-enforcement`
- **Candidate Semantic Version:** `1.0.4-validation`
- **Windows MSI ProductVersion:** `1.0.4.1` (with `AllowSameVersionUpgrades="yes"`)
- **Android Version:** `versionName = 1.0.4-validation`, `versionCode = 4`

---

## 1. Root Cause Summary
- **Session 0 Isolation:** `SafeBrowseChildService` runs as an elevated Windows Service in isolated **Session 0**. In Windows Vista and later, Windows strictly prohibits Session 0 services from displaying interactive windows or spawning GUI applications directly into interactive user desktop sessions (Session 1, Session 2, etc.).
- **Why DNS Enforcement and Block Page Server Were Healthy:**
  - DNS filtering correctly intercepted queries and returned authoritative `NXDOMAIN` (RCODE 3).
  - The local Block Landing Server on `http://127.0.0.1:8880/blocked?domain=...&reason=...` was running and manually accessible.
  - The Ask Parent request UI and backend API (`/api/devices/ask-parent`) were fully functional.
- **Why Block UI Was Hidden:**
  - When a block occurred, `block-server.ts` attempted to invoke `child_process.spawn("msedge.exe", ["--app=..."])` or `cmd.exe /c start "..."`.
  - Because the execution originated from Session 0, Windows either failed the launch silently or opened the process invisibly within Session 0's non-interactive window station (`WinSta0` disconnected), leaving the child user looking at the browser's default generic DNS error page (`ERR_NAME_NOT_RESOLVED`).

---

## 2. Architecture of the Fix

```
┌─────────────────────────────────────────────────────────────┐
│                    Windows Service (Session 0)              │
│  - DnsFilterProxy (intercepts DNS, returns NXDOMAIN)        │
│  - ActivityReporter (independent backend telemetry)         │
│  - BlockLandingServer (http://127.0.0.1:8880)               │
│  - BlockIpcServer (\\.\pipe\SafeBrowseBlockPipe)            │
│      ├── Multi-session check (Fast User Switching safety)    │
│      ├── Managed child vs Parent policy check                │
│      └── Domain debounce (12s) + Global throttle (2.5s)     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                Named Pipe IPC │ authenticated local JSON
                               ▼
┌─────────────────────────────────────────────────────────────┐
│           Interactive User Helper (Session 1+ Child)        │
│  - SafeBrowseUserHelper.exe (native C# WinExe)              │
│      ├── Runs in logged-in child's interactive desktop       │
│      ├── Auto-reconnect loop to SafeBrowseBlockPipe         │
│      ├── Strict URL & domain sanitization validator          │
│      └── Process.Start(UseShellExecute=true)                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│     Child's Default Browser (Edge / Chrome / Firefox)       │
│  http://127.0.0.1:8880/blocked?domain=...&reason=...        │
│  - SafeBrowse Custom Block Experience & Ask Parent Form      │
└─────────────────────────────────────────────────────────────┘
```

1. **Windows Service Role (`SafeBrowseChildService`):**
   - Retains network filtering authority.
   - Evaluates DNS queries against the active child's policy.
   - Manages the local HTTP block page server on `127.0.0.1:8880`.
   - Runs `BlockIpcServer` listening on local Named Pipe `\\.\pipe\SafeBrowseBlockPipe` (restricted to local machine).
   - Verifies whether the active session belongs to a managed child (suppressing block launches for parent or unmanaged accounts) and suppresses presentation during concurrent multi-session switching.
   - Performs domain-level debouncing (12 seconds) and global rate limiting (2.5 seconds).
2. **User Session Helper Role (`SafeBrowseUserHelper.exe`):**
   - Lightweight, non-elevated native Windows application compiled with `csc.exe /target:winexe`.
   - Executes inside the child user's interactive desktop session.
   - Connects to `\\.\pipe\SafeBrowseBlockPipe` and registers the current logged-in account and session.
   - Validates incoming URLs (strictly enforcing scheme `http:`, host `127.0.0.1` or `localhost`, port `8880`, and path `/blocked`).
   - Launches the block page using the child's **default browser** via Windows Shell (`Process.Start` with `UseShellExecute = true`).
   - Never kills, interrupts, or restarts the child's browser tabs or browser session.
3. **Cross-Platform Fallback:**
   - A companion TypeScript helper (`user-helper.ts`) is included for Node-based runtime environments, using Unix domain sockets on Linux (`/tmp/safebrowse-block.sock`) and named pipes on Windows.

---

## 3. Invariants Preserved
- **NXDOMAIN Preserved:** DNS queries for blocked domains continue to receive strict, RFC-compliant `NXDOMAIN` (RCODE 3).
- **No HTTPS Interception / No Custom Root CA:** Zero TLS tampering, zero man-in-the-middle proxies, zero certificate generation.
- **Dinner Time / Bedtime Safety Untouched:**
  - Network-only DNS loopback blocking is preserved.
  - Process limiter remains strictly confined to explicitly configured `APP` budgets; `isPaused` and bedtime curfews never terminate processes.
  - Whitelist of protected Windows OS system processes (`explorer.exe`, `dwm.exe`, `csrss.exe`, etc.) remains strictly enforced.
- **Telemetry Independence:**
  - Telemetry outbox reporting (`ActivityReporter.recordEvent`) is recorded immediately at DNS query time.
  - Presentation debouncing (12s per domain, 2.5s global throttle) affects only UI presentation, ensuring backend activity counts and parent dashboards remain 100% truthful.
- **Account & Session Isolation:**
  - Parent / unmanaged sessions receive zero block popups.
  - If multiple interactive sessions are detected (Fast User Switching), UI presentation is paused to prevent popup leakage into another user's screen.
  - Zero device secrets, authentication tokens, or encryption keys are ever transmitted over the IPC channel.

---

## 4. Windows User-Session Startup Mechanism
- **Installation Directory:** `SafeBrowseUserHelper.exe` is installed alongside `SafeBrowseChild-Pilot.exe` in `[INSTALLDIR]` (`C:\Program Files\SafeBrowse Child\`).
- **Autostart Mechanism:**
  - Registered in Windows Registry via WiX component:
    `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` -> `SafeBrowseUserHelper` = `"[INSTALLDIR]SafeBrowseUserHelper.exe"`
  - Launches automatically when any user logs in to an interactive desktop session.
  - Automatically reconnects if the background service restarts.
  - Enforces single-instance execution per user session using a session-scoped Mutex (`SafeBrowseUserHelper_SingleInstance_Mutex`).

---

## 5. Git Commit & Build Provenance

| Component | Identifier / Version | Provenance Details |
| :--- | :--- | :--- |
| **Commit SHA** | `e314b2ebb71c64f5fb493ed065e9d853d057ba78` | Embedded at build time via `git rev-parse HEAD` |
| **Parent Commit** | `8470382b404aa8b3725c947b17339652ec361570` | Stage C.2 parent baseline |
| **Mandatory Baseline**| `e2589b8ba43e46e25cd15287d41e91aa09ec1400` | Stage B.1 / Stage C baseline |
| **Branch** | `feature/stage11-step4-device-enforcement` | Pushed to `origin` |
| **Candidate Version**| `1.0.4-validation` | Windows Agent & Android Agent Heartbeat |
| **Windows MSI Version**| `1.0.4.1` | WiX `ProductVersion` with `AllowSameVersionUpgrades="yes"` |
| **Android Version** | `versionName = "1.0.4-validation"`, `versionCode = 4` | Staged in `release/android/` |
| **Target Backend** | `https://safebrowse.porwal.online` | Pilot Backend |

---

## 6. SHA-256 Checksums

```
353dd8114fc726120536e1c421c19fc2a475b67603b69912d694e6568f42ed8a  release/android/SafeBrowseChild-Validation-1.0.4.apk
23e72f384686b4516992ee1dec784be7078758b86505263075234fd9ef5dc01b  release/windows-validation/SafeBrowseChild-Validation.msi
b38705a018ee08b8261804c12f000d0cb8ac5bb3d61ffe47e8cda344b0f4172e  release/windows-validation/SafeBrowseChild-Validation.exe
b52703f5b3fb10707ff4745728a8405b5fccddc28c63ce5605d98e766b647520  release/windows-validation/SafeBrowseServiceHost.exe
041bef91cce193ec2047bc3410fa5d50b88088e6a1cb8caa3a66028c8aee7226  release/windows-validation/SafeBrowseUserHelper.exe
```

*All files verified and recorded in `release/SHA256SUMS-validation.txt` and `release/VALIDATION_PROVENANCE.json`.*

---

## 7. Automated Test Results

### New Test Suite Added: `packages/agent-windows/tests/user-session-block-presentation.test.ts`
1. **Test A:** Blocked DNS event produces presentation IPC event with normalized domain and reason.
2. **Test B:** Managed child session receives block presentation over IPC.
3. **Test C:** Parent / unmanaged session receives zero block presentations.
4. **Test D:** Multi-session isolation prevents block presentations from leaking across accounts.
5. **Test E:** Duplicate blocked queries are strictly debounced (12s per domain, 2.5s global throttle).
6. **Test F:** URL validator strictly rejects non-localhost hosts, HTTPS schemes, `javascript:`, and malformed URLs.
7. **Test G:** Default browser launcher executes using system default browser without browser restarts.
8. **Test H:** Zero secrets or device tokens are included in IPC messages.
9. **Test I:** Ask Parent endpoint (`/api/devices/ask-parent`) successfully authenticates using local credentials.
10. **Test J:** User session helper automatically reconnects when service restarts.
11. **Test K:** Logoff/login lifecycle cleanly manages session registrations.
12. **Test L:** Domain normalization strips trailing dots and `www.` prefixes correctly.

### Full Regression Suite Status across All Workspaces:
- **`@safebrowse/agent-windows`:** 11 / 11 test suites passed (**251 / 251 tests passed**, 0 failures).
- **`@safebrowse/shared`:** 2 / 2 test suites passed (**9 / 9 tests passed**, 0 failures).
- **`@safebrowse/parent-web`:** Production Vite build clean (`dist` generated in 8.77s).
- **`@safebrowse/agent-android`:** Release build clean (`./gradlew assembleRelease` successful).
- **GitHub Actions Windows CI (Run `39756582448`):** 100% green (`conclusion: success`).

---

## 8. Physical Retest Instructions

### Step 1: Install Updated Validation MSI
1. On the physical test laptop (`LAPTOP-AAN0K715`), open an elevated PowerShell prompt.
2. Run the installer:
   ```powershell
   msiexec /i SafeBrowseChild-Validation.msi /qn /l*v install.log
   ```
3. Confirm installation succeeds and upgrades cleanly without requiring a reboot.

### Step 2: Confirm Processes Running in Child Session
1. Log in to Windows as the child account (`Manjari`).
2. Open PowerShell or Task Manager and verify:
   ```powershell
   # Session 0: Service Host running as SYSTEM
   Get-Process SafeBrowseServiceHost

   # Session 1+: User Session Helper running as the child account
   Get-Process SafeBrowseUserHelper
   ```
3. Verify `SafeBrowseUserHelper.exe` is running under the child's session ID (not Session 0) and without elevated privileges.

### Step 3: Trigger Blocked Domain in Child Session
1. Launch any web browser (Google Chrome, Microsoft Edge, or Mozilla Firefox).
2. Navigate to a blocked domain (e.g., `http://example.com` or `https://instagram.com` if restricted by policy).
3. **Expected Behavior:**
   - The browser tab displays `NXDOMAIN` (cannot reach site).
   - Within 500ms, the child's default browser automatically presents the SafeBrowse Block Page:
     `http://127.0.0.1:8880/blocked?domain=instagram.com&reason=POLICY_BLOCKED`
   - The custom block screen appears with reason, child name, and "Ask Parent" button.
   - The child's existing browser tabs and browser windows remain open and unaffected.

### Step 4: Validate Ask Parent Flow
1. On the block page, click the **"Ask Parent"** button.
2. Enter an optional reason (e.g., *"Need this for school project"*) and submit.
3. Confirm that the UI transitions to **"Request Sent to Parent"**.
4. Log in to the Parent Web Dashboard at `https://safebrowse.porwal.online`.
5. Verify that the parent dashboard displays the pending access request with correct timestamp and device name.

### Step 5: Validate Debounce & Flood Protection
1. In the child browser, rapidly refresh the blocked domain or open 5 tabs simultaneously to blocked domains.
2. Confirm that only **one** block landing page is opened (12s per-domain debounce and 2.5s global throttle prevent popup storms).
3. Verify in the Parent Web Dashboard that telemetry reflects the total count of blocked queries independently of UI debounce.

### Step 6: Validate Parent / Unmanaged Session Exemption
1. Switch user or log in to Windows as the Parent / Administrator account (`acer`).
2. Navigate to any website.
3. Confirm that **zero** block pages, tabs, or popups are presented.

---

## 9. Status
**Classification:** `READY FOR BLOCK-PAGE PHYSICAL RETEST`
*(Do NOT publish `v1.0.4-pilot` until physical confirmation is complete).*
