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
| **W31** | Security Hardening | ProgramData ACL Separation (`secure/` vs `state/`) | `secure/` blocks Users; `state/`, `logs/`, and root permit Users `RX` | Automated & Manual |
| **W32** | Security Hardening | Sanitized configuration state verification | `state/sanitized-config.json` readable by standard user; contains 0 secrets | Automated & Manual |
| **W33** | Anti-Tamper | Nonce-based elevated staging (`--apply-mappings-req`) | Single-use replay protection: file unlinked immediately upon reading | Automated |
| **W34** | Anti-Tamper | Staging freshness & payload hash validation | Rejects requests older than 60s or with altered SHA-256 payloadHash | Automated |
| **W35** | Integrity | Account SID & Child ID verification | Rejects unknown machine SIDs, duplicate SIDs, or unmapped child profiles | Automated |
| **W36** | Security Boundary | Normal GUI Read-Only Invariant | Unelevated `POST /api/mappings` rejected with 403; normal GUI view-only | Automated & Manual |
| **W37** | Privilege Separation | Dedicated Elevated Configuration GUI (`--configure-accounts`) | UAC-launched elevated window loads secure config, fetches live profiles | Automated & Manual |
| **W38** | Anti-Tamper | Zero-Staging Persistence | Saves directly within elevated process; 0 temporary staging files | Automated |
| **W39** | Privilege Separation | Normal GUI Attach Device UAC Trigger | Clicking "Attach Device" launches UAC elevation (`Start-Process -Verb RunAs`) | Automated & Manual |
| **W40** | Failure Resilience | UAC Cancellation Handling | Cancelling UAC shows "Administrator approval is required"; 0 code burned | Automated & Manual |
| **W41** | Security Boundary | Unelevated Pairing Rejection | Direct `POST /api/pair` from unelevated process returns 403 Forbidden | Automated |
| **W42** | Privilege Separation | Elevated Pairing Server (`--attach-device`) | Dedicated port 8887 with Administrator badge and secure claim handler | Automated & Manual |
| **W43** | Cryptographic Storage | DPAPI Machine Scope Device Credential Encryption | `deviceToken` encrypted with LocalMachine DPAPI, stored in `secure/` only | Automated |
| **W44** | State Separation | Zero-Secret State Storage | `state/sanitized-config.json` written with `isPaired: true`, 0 tokens | Automated |
| **W45** | Reactive Refresh | Normal GUI Background Auto-Detection | Unelevated GUI on `8885` automatically switches from Not Paired to Paired | Automated & Manual |

---

## Detailed Step-by-Step Validation Procedures

### Procedure 1: Physical Windows Installation & Account Mapping
1. Copy `SafeBrowseChild-Pilot.msi` to the Windows 10/11 machine.
2. Launch administrative PowerShell:
   ```powershell
   msiexec /i SafeBrowseChild-Pilot.msi /qn
   Start-Service SafeBrowseChildService
   ```
3. Open a browser and navigate to `http://127.0.0.1:8885` (or double-click desktop shortcut).
4. Verify that the Setup screen opens cleanly and shows "Connect to your Family" or "Attach Device".
5. In the Parent Portal (`https://safebrowse.porwal.online`), go to **Devices** (`/devices`) and click **Pair New Device**.
6. Select the child profile (e.g. "Manjari") and generate a pairing code (e.g. `SB-XXXX-XXXX`).
7. In the local setup window, click **Attach Device**.
8. Confirm Windows UAC elevation prompt ("Do you want to allow this app to make changes to your device?").
9. Enter the pairing code in the elevated SafeBrowse Setup Wizard window on port `8887` and click **Attach Device & Protect Laptop**.
10. Verify that the device claims successfully, encrypts credentials, starts `SafeBrowseChildService`, and closes the elevated window.
11. Verify that the unelevated GUI on `8885` automatically detects the paired state and transitions to the **Protection Status** screen showing active protection.

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

### Procedure 5: Administrator-Approved Reconfigure Accounts & Privilege Separation
1. As a standard Windows user (or non-elevated desktop session), open `http://127.0.0.1:8885`.
2. Verify that the Status screen shows the view-only table: **Configured Laptop Accounts & Protection** displaying discovered accounts and their active protection mode without any raw SIDs.
3. Attempt to mutate mappings via direct unelevated API call:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:8885/api/mappings" -Method Post -Body '{"mappings":[]}' -ContentType "application/json"
   # Expected: HTTP 403 Forbidden with "Administrator approval is required to change account protection."
   ```
4. Click **Reconfigure Accounts** on the normal status GUI.
5. Confirm that the application informs the user: `Administrator approval requested... Please approve the Windows UAC prompt to reconfigure accounts.`
6. A Windows User Account Control (UAC) prompt appears requesting administrator credentials/approval for `SafeBrowseChild-Pilot.exe --configure-accounts`.
7. **Test Cancel (Child Attempt):**
   - Click "No" or cancel the UAC prompt.
   - Confirm that the normal status GUI remains active and unchanged, and previous protection mappings remain unaltered.
8. **Test Approve (Parent Approval):**
   - Click **Reconfigure Accounts** again and approve the UAC elevation prompt (click "Yes" or enter admin PIN/password).
   - A dedicated elevated configuration window opens (`http://127.0.0.1:8886`) with the banner `🛡️ Administrator Approved`.
   - The elevated window fetches live family profiles directly using credentials in `secure/device-config.json` and displays child dropdowns.
   - Change account assignments (e.g. assign `Rahul` to child profile `Rahul`).
   - Click **Save Settings & Protect Laptop**.
   - Verify that the elevated window displays: `Shared laptop settings saved successfully! Updating protection...` and automatically closes after 1.2s.
   - Confirm that the normal status GUI (`http://127.0.0.1:8885`) automatically polls and refreshes its view-only table with the updated child protection state.
   - Confirm that `C:\ProgramData\SafeBrowse\state\profile-mappings.json` is updated directly and atomically without any intermediate staging files in `%TEMP%`.

### Procedure 6: Least-Privilege Directory ACL & Sanitized State Verification
1. Sign in as a standard non-administrative Windows user (e.g. `Rahul`).
2. Open PowerShell (unelevated):
   ```powershell
   # Attempt to read secure directory (must be rejected)
   Get-ChildItem -Path "C:\ProgramData\SafeBrowse\secure"
   # Expected: Access is denied

   # Read sanitized config (must succeed)
   Get-Content -Path "C:\ProgramData\SafeBrowse\state\sanitized-config.json" | ConvertFrom-Json
   # Expected: Returns deviceId, deviceName, backendUrl, platform.
   # Invariant: deviceToken, parentToken, and network secrets are STRICTLY absent.

   # Verify state directory readability
   Get-ChildItem -Path "C:\ProgramData\SafeBrowse\state"
   # Expected: Lists sanitized-config.json, profile-mappings.json, family-profiles-cache.json
   ```
3. Open browser to `http://127.0.0.1:8885`:
   - Status page loads without any permission errors.
   - Device name and assigned child profile render accurately.
   - Accounts page lists human accounts without requesting UAC elevation for viewing.

### Procedure 7: Nonce Staging & Single-Use Replay Protection Verification
1. In `http://127.0.0.1:8885`, update a mapping and click **Save Settings & Protect Laptop**.
2. Approve the UAC prompt.
3. Verify in service logs (`C:\ProgramData\SafeBrowse\logs\agent.log`):
   ```
   [AccountManager] Applying mapping request nonce: <uuid-v4>
   [AccountManager] Staging request unlinked immediately: ...
   [AccountManager] Successfully applied mapping request <uuid-v4>
   ```
4. Attempt to replay the same nonce via elevated command prompt:
   ```powershell
   SafeBrowseChild-Pilot.exe --apply-mappings-req <uuid-v4>
   ```
   - Expected: Immediately fails with `Staging request not found for nonce: <uuid-v4>`.
5. Verify freshness window:
   - If a staging request older than 60 seconds is processed, verify rejection: `Staging request expired`.
6. Verify hash integrity:
   - If payload data is tampered with, verify rejection: `Payload hash mismatch: integrity verification failed`.


