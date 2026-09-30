# SafeBrowse Windows Pilot v1.0 — Device & Account Manual Verification Protocol

**Version:** 1.0.1-pilot  
**Classification:** Pilot Ready for Single-Active-User Deployment  
**Repository:** `dicanshulporwal-hub/safechild`  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Target Platform:** Windows 10 / 11 (x64)  

---

## Overview

This document provides a comprehensive 30-point physical and automated verification matrix for the SafeBrowse Windows Pilot release. Tests cover device registration, cryptographic pairing, multi-session safety guard, parent dashboard device management, graphical setup GUI, policy push synchronization, and security invariants.

---

## Test Verification Matrix (W1 – W30)

| Test ID | Category | Test Description | Expected Result | Automated / Manual |
| :--- | :--- | :--- | :--- | :--- |
| **W1** | Device Registration | Generate 6-digit pairing code from Parent Dashboard for Child profile | High-entropy pairing code generated with 15-minute expiration | Automated & Manual |
| **W2** | Device Registration | Pair Windows device using CLI `--pair SB-XXXXXX` | Successfully claims device, writes `device-config.json`, receives deviceToken | Automated |
| **W3** | Device Registration | Graphical pairing via Windows Setup GUI on `http://127.0.0.1:8885` | Clean form input, immediate validation, handoff to status screen | Automated & Manual |
| **W4** | Device Registration | Re-pairing attempt with expired or invalid pairing code | Rejected with clear user-facing error; no corrupted local state | Automated |
| **W5** | Device Registration | Rate limiting on pairing endpoint | Rejects excessive pairing attempts to prevent code brute-forcing | Automated |
| **W6** | Parent Dashboard | Device inventory list view at `/devices` | Displays device name, platform, assigned child, online state, protection state | Automated & Manual |
| **W7** | Parent Dashboard | Telemetry visibility: Agent version & Active policy version | Displays `1.0.0-pilot` and current policy version integer | Automated & Manual |
| **W8** | Parent Dashboard | Friendly Windows account display (no raw SIDs) | Displays `acer` or `DESKTOP-PC\Rahul` instead of `S-1-5-21-...` | Automated & Manual |
| **W9** | Parent Dashboard | Immediate policy synchronization button | Sends push notification over WebSocket; agent refreshes policy within 2s | Automated & Manual |
| **W10** | Parent Dashboard | Device renaming from parent dashboard | Renames device in database, updates WebSocket clients, preserves telemetry | Automated |
| **W11** | Windows Setup GUI | Local GUI bound exclusively to loopback `127.0.0.1:8885` | Remote LAN or external connections cannot reach setup port | Automated |
| **W12** | Windows Setup GUI | Account discovery filters out system identities | SYSTEM, LOCAL SERVICE, and virtual accounts hidden from parent | Automated |
| **W13** | Windows Setup GUI | Parent/Unmanaged bypass selection for parent account | Selecting Unmanaged puts account into transparent bypass | Automated |
| **W14** | Windows Setup GUI | Child profile mapping to specific Windows account | Mapping persists to `shared-laptop-config.json` with canonical SID | Automated |
| **W15** | Windows Setup GUI | Raw SID elimination in UI table and forms | Raw SIDs (`S-1-5-21-...`) completely shielded from parents | Automated |
| **W16** | Multi-Session Guard | Single active interactive Windows session | Status reports `Protected` (Managed Child) or `Parent Bypass` | Automated |
| **W17** | Multi-Session Guard | Concurrent interactive sessions detected (`Get-Process explorer`) | Status immediately switches to `Attention Required` / `DEGRADED` | Automated |
| **W18** | Multi-Session Guard | Multi-session warning banner displayed in Setup GUI | Prominent banner informs parent to sign out background users | Automated |
| **W19** | Multi-Session Guard | Heartbeat telemetry carries `hasMultipleSessions: true` | Parent dashboard surfaces `Attention Required` alert badge | Automated |
| **W20** | Multi-Session Guard | Signing out secondary session restores clean state | Status automatically clears back to `Protected` on next session check | Automated |
| **W21** | Policy Enforcement | Child account browsing blocked domain (e.g. `roblox.com`) | Loopback DNS returns `0.0.0.0` / NXDOMAIN, drops traffic | Automated |
| **W22** | Block Interstitial | Browser opens blocked URL HTTP port 80 | Clean local SafeBrowse block page rendered on `127.0.0.1:18880` | Automated |
| **W23** | Ask Parent | Submitting access request from block interstitial | Tokenless submission forwarded to backend; parent receives notification | Automated |
| **W24** | Parent Bypass | Switching console to parent account (`acer`) | DNS proxy enters transparent bypass; zero parental restrictions applied | Automated |
| **W25** | DNS Cache Flush | Console user switch between parent and child | Local DNS cache flushed immediately (`Clear-DnsClientCache`) | Automated |
| **W26** | Offline Resilience | Network disconnect / backend cloud unavailable | Local SQLite/JSON policy cache preserves enforcement; no fail-open | Automated |
| **W27** | Diagnostics | Running 7-point self-diagnostic check | Verifies agent PID, DNS proxy, policy cache, cloud tunnel, anti-tamper | Automated |
| **W28** | Device Reassignment | Reassigning device to different child from Parent Web | Updates child assignment, pushes new child policy to agent | Automated |
| **W29** | Device Unpairing | Parent clicks Unpair Device in Parent Dashboard | Blacklists `deviceToken` in memory, deletes device from DB, revokes access | Automated |
| **W30** | Security Hardening | WebSocket URL and HTTP telemetry audit | Zero credentials in query parameters (`/ws`); no token leak in GET responses | Automated |

---

## Detailed Step-by-Step Validation Procedures

### Procedure 1: Physical Windows Installation & Account Mapping
1. Copy `SafeBrowseChild-Pilot.msi` to the Windows 10/11 machine.
2. Launch administrative PowerShell:
   ```powershell
   msiexec /i SafeBrowseChild-Pilot.msi /qn
   Start-Service SafeBrowseChildService
   ```
3. Open a browser and navigate to `http://127.0.0.1:8885`.
4. Verify that the Setup screen opens cleanly and lists discovered Windows accounts with friendly names.
5. In the Parent Portal (`https://safebrowse.porwal.online`), go to **Devices** (`/devices`) and click **Pair New Device**.
6. Select the child profile (e.g. "Manjari") and generate a 6-digit code.
7. Enter the code in the local setup window on the laptop and click **Pair Device**.
8. Verify that the laptop status screen transitions to **● Active Protection** (or **⚠️ Attention Required** if multiple users are signed in).

### Procedure 2: Single-Active-User Isolation & User Switching
1. Log in as child user `Manjari`.
2. Browse to a restricted domain (e.g. `roblox.com`). Verify that the domain is blocked and the SafeBrowse block page is displayed.
3. Sign out of `Manjari`.
4. Log in as parent user `acer`.
5. Verify in `http://127.0.0.1:8885` that the status shows **○ Parent / Unmanaged (Bypassed)**.
6. Browse to `roblox.com` or any standard website. Verify that all browsing is completely uninhibited.

### Procedure 3: Multi-Session Safety Guard Validation
1. Log in as `acer`.
2. Use Windows Fast User Switching (Win+L -> Switch User) to sign in to `Manjari` while `acer` remains logged in in the background.
3. Check `http://127.0.0.1:8885` on `Manjari`'s desktop.
4. Verify the prominent amber banner appears:
   > *"Multiple Windows users are currently signed in. To ensure parental controls are enforced accurately, please sign out other Windows accounts."*
5. Check Parent Dashboard at `https://safebrowse.porwal.online/devices`.
6. Verify the device card badge displays `⚠️ Attention Required` and `Degraded (Multiple Sessions)`.
7. Sign out the background `acer` account.
8. Verify that the banner disappears and status returns to `Protected`.

### Procedure 4: Family Profile Resilience & Dropdown Verification
1. Open `http://127.0.0.1:8885` and click **Reconfigure Accounts**.
2. Verify that the loading indicator `"Loading family profiles..."` appears momentarily while accounts and cloud profiles load.
3. Confirm that each interactive human Windows account (`DIC`, `Manjari`, `Rahul`, `acer`) appears in the list.
4. Verify that non-interactive sandbox identities (`CodexSandboxOffline`, `CodexSandboxOnline`, `WindowsSandbox`) and service identities are absent.
5. Verify that the current active console account is marked clearly: `DIC — ACTIVE USER`.
6. Confirm that the dropdown list for each account displays:
   - `Parent / Unmanaged (Protection OFF)`
   - Each synchronized child profile (e.g. `Manjari (Child Profile)`, `Rahul (Child Profile)`).
7. Disconnect network or simulate backend offline. Refresh or click **Retry**:
   - Verify that the blue notice appears: `ℹ Using previously synchronized family profiles.`
   - Confirm that child profile dropdowns remain fully populated from local persistent cache (`family-profiles-cache.json`).

### Procedure 5: Privilege Separation & Secure Save Settings Verification
1. As a standard Windows user (or non-elevated desktop session), open `http://127.0.0.1:8885`.
2. Change a child mapping (e.g., assign `Rahul` to child profile `Rahul`).
3. Click **Save Settings & Protect Laptop**.
4. Confirm that the button changes to `Saving settings...` and a Windows User Account Control (UAC) prompt appears requesting administrator credentials/approval.
5. **Test Cancel (Child Attempt):**
   - Click "No" or cancel the UAC prompt.
   - Verify that the application displays: `Administrator approval is required to change account protection.`
   - Confirm that previous mappings remain unaltered.
6. **Test Approve (Parent Approval):**
   - Click "Save Settings & Protect Laptop" again and approve the UAC elevation prompt (click "Yes" or enter admin PIN/password).
   - Verify that the success alert appears: `Shared laptop settings saved successfully!`
   - Verify that the application navigates smoothly to the Status screen.
   - Confirm that `C:\ProgramData\SafeBrowse\profile-mappings.json` is updated atomically with verified ACLs and zero `Access is denied` errors.

