# SafeBrowse Stage C — Windows Physical Validation Checklist

**Document Version:** `1.0.4-validation`  
**Execution Environment:** Physical Windows 10/11 x64 Pilot Machine (Shared Laptop Architecture)  
**Baseline Commit SHA:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`  
**Candidate Release Package:** `SafeBrowseChild-Validation.msi` / `SafeBrowseChild-Validation.exe` (v1.0.4 Candidate)  
**Target Backend:** `https://safebrowse.porwal.online` (or Validation Server `http://127.0.0.1:11002`)  
**Status:** `READY FOR PHYSICAL EXECUTION`

---

## Pre-Test Machine Snapshot Checklist

1. Record Windows OS Build and Edition (`winver`).
2. Record currently installed SafeBrowse version:
   ```powershell
   Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName -like "*SafeBrowse*" } | Select-Object DisplayName, DisplayVersion
   ```
3. Record service state prior to upgrade:
   ```powershell
   Get-Service SafeBrowseChildService -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType
   ```

---

## 12-Step Sequential Physical Execution Matrix

### W1. INSTALL / UPGRADE
* **Objective:** Verify seamless upgrade from `v1.0.3-pilot` to validation candidate and verify the critical SCM service recovery fix.
* **Pre-condition on Test Machine:** Intentionally simulate degraded state if needed:
  ```powershell
  Set-Service SafeBrowseChildService -StartupType Manual
  Stop-Service SafeBrowseChildService
  ```
* **Execution:**
  1. Copy `SafeBrowseChild-Validation.msi` to the Windows machine.
  2. Run elevated command prompt:
     ```cmd
     msiexec /i SafeBrowseChild-Validation.msi /qn /l*v "C:\ProgramData\SafeBrowse\logs\upgrade.log"
     ```
  3. Immediately query Windows Service Controller:
     ```powershell
     Get-CimInstance Win32_Service -Filter "Name='SafeBrowseChildService'" | Select-Object Name, State, StartMode
     ```
* **Expected Result:**
  - `State` = **`Running`**
  - `StartMode` = **`Auto`**
  - MSI custom action `ConfigureServiceRecovery` resets `sc.exe config start= auto` and starts service without user intervention.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W2. PAIRING / DEVICE STATE
* **Objective:** Ensure existing pairing survives MSI upgrade; verify elevated pairing if fresh machine.
* **Execution:**
  1. Open local setup GUI at `http://127.0.0.1:8885`.
  2. If already paired from v1.0.3: verify status displays `● ONLINE` and `● PROTECTED` with zero credential loss.
  3. If fresh install: click **Attach Device**, accept Windows UAC prompt, input 6-digit code on `http://127.0.0.1:8887`.
  4. Inspect Parent Portal at `/devices`.
* **Expected Result:**
  - `deviceToken` and device credentials in `C:\ProgramData\SafeBrowse\secure\device-config.json` remain intact.
  - Parent portal displays device as **Online** with green pulse indicator within 60 seconds.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W3. WINDOWS ACCOUNT MAPPING
* **Objective:** Validate shared-laptop account isolation across interactive desktop profiles.
* **Execution:**
  1. In Parent / Admin desktop session, open `http://127.0.0.1:8885` and click **Reconfigure Accounts** (or elevated launcher `SafeBrowseChild-Pilot.exe --configure-accounts`).
  2. Verify mapping table:
     - Parent account (e.g. `acer`): Set to **Parent / Unmanaged (Bypass)**.
     - Child account (e.g. `Rahul`): Set to **Child Profile ("Rahul")**.
  3. Restart service: `Restart-Service SafeBrowseChildService`.
  4. Query active mapping:
     ```powershell
     Get-Content "C:\ProgramData\SafeBrowse\state\sanitized-config.json"
     ```
* **Expected Result:**
  - Mappings persist across service restarts.
  - When logged into parent console, agent operates in transparent bypass (no DNS filtering).
  - When logged into child console, agent enforces synthetic NXDOMAIN filtering.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W4. BASIC WEBSITE BLOCK
* **Objective:** Validate network-level loopback DNS blocking without application disruption.
* **Execution:**
  1. Sign in to Windows as the managed child account.
  2. Ensure child policy contains a blocked test domain (e.g. `gambling-test-site.com` or custom block rule).
  3. Open Google Chrome or Microsoft Edge and navigate to `http://gambling-test-site.com`.
  4. Inspect browser behavior and local block page.
  5. Check Parent Portal Activity feed.
* **Expected Result:**
  - DNS resolves to `0.0.0.0` or NXDOMAIN; browser displays SafeBrowse Block Interstitial (`http://127.0.0.1:18880`).
  - Browser process remains stable and alive (zero process kills).
  - Activity log in Parent Portal and DB `ActivityEvent` record:
    * `childId`: Matching child
    * `domain`: `gambling-test-site.com`
    * `action`: `BLOCK`
    * `timestamp`: Within 30s of event
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W5. DINNER TIME P0 RETEST (MANDATORY 5-CYCLE STABILITY GATE)
* **Objective:** Verify zero process kills during Dinner Time / Global Internet Pause.
* **Pre-condition:**
  - Open and keep active on child desktop:
    1. Microsoft Edge (with tabs open)
    2. Google Chrome
    3. Windows File Explorer (`explorer.exe`)
    4. Notepad (`notepad.exe` with unsaved text)
    5. Calculator (`calc.exe`)
* **Execution (Repeat for 5 consecutive cycles):**
  1. In Parent Dashboard, toggle **Pause Internet (Dinner Time)** to **ON**.
  2. Wait 15 seconds for WebSocket policy push.
  3. Attempt web navigation in Chrome and Edge.
  4. Inspect open applications (Notepad, Calculator, Explorer, Browsers).
  5. Check service health:
     ```powershell
     Get-Service SafeBrowseChildService
     ```
  6. In Parent Dashboard, toggle **Pause Internet** to **OFF**.
  7. Wait 15 seconds; verify internet resumes immediately without requiring reboot or reconnect.
* **Expected Result (ALL 5 CYCLES MUST PASS):**
  - **Zero Windows crash / BSOD.**
  - **Zero user logout or session termination.**
  - **Zero process kills** (Notepad, Calculator, Browsers, and Explorer stay completely open).
  - Internet is cleanly blocked via loopback DNS returning `PAUSED_INTERNET` block notice.
  - Service status remains **`Running`** throughout all 5 cycles.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W6. BEDTIME (NON-DISRUPTIVE NETWORK RESTRICTION)
* **Objective:** Confirm curfew / bedtime windows enforce network-only DNS blocks without closing child homework or active apps.
* **Execution:**
  1. Configure bedtime routine starting 2 minutes in the past and ending in the future.
  2. Keep active educational document in browser or Word/Notepad.
  3. Attempt to access non-educational web domain.
* **Expected Result:**
  - Non-exempt DNS queries are blocked with user-friendly "Bedtime restrictions active" landing page.
  - Background processes and open editors are spared from termination.
  - Allowed educational domains remain accessible.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W7. ASK PARENT (TOKENLESS INTERSTITIAL FLOW)
* **Objective:** Verify child access request from local block screen reaches Parent Portal.
* **Execution:**
  1. From child browser on blocked page, type reason: `"Need for science research"`.
  2. Click **[Ask Parent for Access]**.
  3. In Parent Web Dashboard, open **Requests** panel.
  4. Click **Approve (15 min)**.
  5. Wait 10 seconds and refresh blocked website on child device.
* **Expected Result:**
  - Tokenless request submits successfully to `/api/requests`.
  - Notification banner appears in Parent Web in real-time.
  - Backend creates temporary grant rule expiring in 15 minutes.
  - Child device policy increments version and allows website until grant expires.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W8. APP USAGE & DELTA SYNC ACCURACY
* **Objective:** Validate precise usage accumulation without 2x overcounting.
* **Execution:**
  1. Configure an explicit APP budget in policy (e.g. `notepad.exe` or test game for 10 minutes).
  2. Launch and actively use target application for exactly **90 seconds**.
  3. Close application or wait for periodic usage sync cycle (60s).
  4. Inspect database `ChildUsageRecord` and Parent Portal Screen Time graph.
* **Expected Result:**
  - Recorded consumed duration is approximately **90 seconds** (±10s margin for sampling interval).
  - Sync receipt prevents replay or duplicate double-sync.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W9. SHARED LAPTOP ATTRIBUTION
* **Objective:** Verify events from multiple local user accounts are strictly partitioned.
* **Execution:**
  1. Switch desktop to Child A (`Rahul`), browse blocked site.
  2. Switch desktop to Child B (`Manjari`), browse blocked site.
  3. Switch desktop to Parent (`acer`), browse any website.
* **Expected Result:**
  - Child A activity maps strictly to Child A profile.
  - Child B activity maps strictly to Child B profile.
  - Parent browsing generates zero child activity events or policy blocks.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W10. POLICY VERSION TRANSITION
* **Objective:** Verify portal transitions from `SYNC_PENDING` to `SYNCED`.
* **Execution:**
  1. In Parent Portal, add a new blocked domain.
  2. Observe device row in Devices table.
* **Expected Result:**
  - Status immediately reflects `SYNC_PENDING` (configuredVersion > agentVersion).
  - Within 5–15 seconds over WebSocket, device synchronizes and reports heartbeat.
  - Status updates to `SYNCED` (`activePolicyVersion === configuredVersion`).
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W11. TELEMETRY PERSISTENCE ACROSS BACKEND RESTART
* **Objective:** Ensure database integrity and zero reliance on in-memory backend caches.
* **Execution:**
  1. Record current device state, active policy version, activity count, and usage.
  2. Restart backend service (`sudo systemctl restart safebrowse-backend.service`).
  3. Refresh Parent Portal dashboard.
* **Expected Result:**
  - All device records, health states, telemetry, and activity history persist identically.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### W12. WINDOWS REBOOT SURVIVABILITY
* **Objective:** Ensure service auto-starts, network configuration holds, and anti-tamper persists after clean reboot.
* **Execution:**
  1. Reboot Windows machine: `Restart-Computer -Force`.
  2. Allow computer to boot to Windows login screen without logging in.
  3. Check from external device: Is DNS still intercepting on loopback?
  4. Log in as child; verify service is running and protection is immediate.
* **Expected Result:**
  - `SafeBrowseChildService` starts automatically under `LocalSystem`.
  - DNS servers remain set to `127.0.0.1`.
  - Portal marks device as online within 90 seconds.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

## Sign-off Certification Gate

| Role | Name | Status | Timestamp |
| :--- | :--- | :--- | :--- |
| **Physical Test Engineer** | | 🔲 PENDING EXECUTION | |
| **QA Lead** | | 🔲 PENDING EXECUTION | |
| **Platform Architect** | | 🔲 PENDING EXECUTION | |
