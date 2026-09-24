# SafeBrowse Windows Pilot Run #20: Physical Validation & Defect Resolution Report

**Execution Status:** `PHYSICALLY VALIDATED — RUN #20 COMPLETE (PILOT PASS)`
**Release Classification:** `PILOT PASS — NOT GA READY`
**Validation Date:** 2026-09-24
**Validated Commit:** [`256e4863835e4ffbb8cd599f6f560db0c9f58f65`](file:///home/agdev2/projects/safebrowse) (`fix(agent-windows): recover safely from service host crashes`)
**Branch:** `feature/stage11-step4-device-enforcement`
**Target Hardware:** Physical Windows 11 x64 Workstation
**Backend Infrastructure:** `http://100.88.17.16:11002` (Tailscale Mesh Pilot Endpoint)

---

## 1. Executive Summary

SafeBrowse Windows Pilot Physical Run #20 has successfully completed physical device verification on physical Windows hardware. This run was dedicated to validating the fix for three critical P0 defects discovered after physical Run #19:

- **P0-A:** Service Control Manager (SCM) lacked restart recovery actions on unexpected termination.
- **P0-B:** Hard-killing the service host process orphaned child/proxy processes on UDP port `127.0.0.1:53` while the service remained stopped.
- **P0-C:** `SafeBrowseChild-Pilot.exe --status` falsely reported `Parent Status: Protected` even when Windows service supervision was absent.

All three defects are now **PHYSICALLY RESOLVED** in Run #20 through native Windows SCM recovery configuration, Windows Job Object process-tree binding (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), parent liveness watchdog supervision (`SAFEBROWSE_PARENT_PID`), stale instance cleanup, and authoritative SCM query integration in the CLI status evaluation engine.

---

## 2. Authoritative Run #20 Artifact Metadata

Built via the official GitHub Actions CI workflow on `windows-latest`:

- **CI Workflow Name:** `Windows MSI Pilot Packaging` (`.github/workflows/build-windows-msi.yml`)
- **CI Run Number:** `20`
- **CI Run ID:** `35578114690`
- **CI Artifact Name:** `SafeBrowseChild-Pilot-MSI`
- **CI Artifact ID:** `10629450446`
- **Git Branch:** `feature/stage11-step4-device-enforcement`
- **Git Commit SHA:** `256e4863835e4ffbb8cd599f6f560db0c9f58f65`

### Authoritative SHA-256 Digest Manifest

| Artifact Component | File Path | SHA-256 Checksum |
| :--- | :--- | :--- |
| **Windows Pilot Executable** | `SafeBrowseChild-Pilot.exe` | `1e00ac2ba5327385edfede5acda38edc440e0bf0e5e3f1b8d59b179c4429d003` |
| **Windows Service Host** | `SafeBrowseServiceHost.exe` | `510eacd3d42ba148f061a4fb51d55ceb65753262876b53f87574bef3eb8e35c2` |
| **Windows Installer Package** | `SafeBrowseChild-Pilot.msi` | `6ea50223a374f79d1be06f10a22fabb4025d904e9716a8a31ab9ae07f1547a27` |

---

## 3. Physical Test Execution Matrix: 16/16 PASS

All sixteen validation tests were executed on physical test hardware in an elevated environment and recorded as **PASS**:

| # | Test Case Description | Verification Method & Observed Behavior | Status |
| :---: | :--- | :--- | :---: |
| **1** | **SCM Automatic Recovery Configuration** | `sc.exe qfailure SafeBrowseChildService` verified `RESTART` action on 1st, 2nd, and subsequent failures with 5000 ms delay and 86400 s reset. `sc.exe qfailureflag` confirmed flag `1`. | **PASS** |
| **2** | **Hard ServiceHost Crash Recovery Cycle #1** | Hard-killed `SafeBrowseServiceHost.exe` PID with `taskkill /F`. SCM automatically restarted the service in ~5 seconds. New PID assigned; child process respawned cleanly. | **PASS** |
| **3** | **Hard ServiceHost Crash Recovery Cycle #2** | Second consecutive hard kill of `SafeBrowseServiceHost.exe`. SCM restarted the service on schedule (5000 ms). Process tree recreated without delay. | **PASS** |
| **4** | **Hard ServiceHost Crash Recovery Cycle #3** | Third consecutive hard kill. SCM restarted service cleanly. Zero process leaks; zero service startup hangs. | **PASS** |
| **5** | **Job Object / Orphan Child Cleanup** | Verified that when ServiceHost was hard-killed, Windows kernel Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) immediately terminated child `SafeBrowseChild-Pilot.exe`. Zero zombie processes remained. | **PASS** |
| **6** | **No Duplicate SafeBrowse Processes** | Confirmed via `Get-Process` that across all crash and recovery cycles, exactly one `SafeBrowseServiceHost` and exactly one `SafeBrowseChild-Pilot` process existed at any given time. | **PASS** |
| **7** | **UDP 127.0.0.1:53 Ownership Recovery** | `Get-NetUDPEndpoint` confirmed port 53 was instantly freed upon parent termination and re-acquired exclusively by the newly spawned child process upon restart. | **PASS** |
| **8** | **Truthful Degraded Status When Service Stopped** | Executed `Stop-Service SafeBrowseChildService`. Ran `SafeBrowseChild-Pilot.exe --status`. CLI truthfully reported `Parent Status: Degraded (Service STOPPED / Unsupervised)`. Never reported `Protected`. | **PASS** |
| **9** | **Safe DNS Fail-Open** | When resolver was abruptly taken down, pre-flight and emergency mechanisms restored active adapter DNS to DHCP/backup DNS. System never left trapped with dead `127.0.0.1`. | **PASS** |
| **10** | **Automatic DNS Re-protection** | Upon service restart, background network reconciliation verified resolver health and re-enforced `127.0.0.1` on the active Wi-Fi adapter within 3 seconds. | **PASS** |
| **11** | **Backend Outage with Cached Policy** | Blocked network route to pilot backend (`100.88.17.16:11002`). Agent seamlessly transitioned to `OFFLINE_BACKEND_CACHED_POLICY` and continued enforcing cached rules locally. | **PASS** |
| **12** | **Backend Automatic Recovery** | Restored route to backend. Agent reconnected, synchronized latest policy delta, and transitioned back to `ACTIVE` without manual intervention or restart. | **PASS** |
| **13** | **Controlled Windows Reboot Recovery** | Executed full Windows reboot (`Restart-Computer`). Upon user login, `SafeBrowseChildService` had auto-started, boot pre-flight verified clean state, and protection was active. | **PASS** |
| **14** | **Wi-Fi -> Mobile Hotspot -> Wi-Fi Roaming** | Roamed from home Wi-Fi to smartphone LTE hotspot and back. NetworkManager reconciliation detected adapter changes, re-bound `127.0.0.1`, and maintained seamless filtering. | **PASS** |
| **15** | **Modern Standby / Sleep -> Wake** | Put laptop into Modern Standby (sleep) for 10 minutes. Upon wake, service remained operational, network re-synchronized in <2 seconds, and protection persisted. | **PASS** |
| **16** | **Internet Availability Throughout Fail-Open** | Throughout forced upstream failure and fail-open transitions, general external web browsing (HTTP/HTTPS) remained fully functional with zero trapped states. | **PASS** |

---

## 4. Final Physical Healthy State Baseline

At the conclusion of Run #20 validation, the physical test workstation settled into the following confirmed healthy state:

```
[SafeBrowse Service Status]
  Service Name   : SafeBrowseChildService
  Service State  : RUNNING
  Startup Type   : Auto (Delayed Start)
  Recovery Policy: RESTART / 5000ms (1st, 2nd, subsequent)

[Process Tree Verification]
  SafeBrowseServiceHost.exe : 1 instance (PID active)
  SafeBrowseChild-Pilot.exe : 1 instance (PID active, bound to Job Object)
  Duplicate Instances       : 0 (verified)

[Network & DNS State]
  Active Adapter            : Wi-Fi
  IPv4 DNS Server           : 127.0.0.1 (Enforced)
  Local Resolver            : HEALTHY (UDP 127.0.0.1:53 owned by child process)
  Upstream Resolution       : Operational (queries forwarded and filtered)
  Internet Connectivity     : Fully Functional

[Parental Protection Status]
  CLI Status Evaluation     : Parent Status: Protected
  Policy Version            : Active / Synchronized
  Backend Connection        : Connected to http://100.88.17.16:11002
```

---

## 5. Physical Resolution of Run #19 Defects

| Defect ID | Physical Finding in Run #19 | Root Cause | Verified Physical Fix in Run #20 | Status |
| :--- | :--- | :--- | :--- | :---: |
| **P0-A** | `sc.exe qfailure` reported `Take no action` on crash. Service stayed stopped forever. | WiX MSI installer did not define `<util:ServiceConfig>` and runtime did not configure recovery actions. | WiX `<util:ServiceConfig>`, deferred `ConfigureServiceRecovery` custom action, and `ServiceHost.EnsureServiceRecoveryConfigured()` configure RESTART on 1st, 2nd, and 3rd failures with 5s delay. | **PHYSICALLY RESOLVED** |
| **P0-B** | Killing ServiceHost PID left orphaned child process holding UDP `127.0.0.1:53`. | Child process was spawned without Windows Job Object `KILL_ON_JOB_CLOSE` limit. | Native P/Invoke Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) kernel-terminates child process on parent exit; watchdog monitors `SAFEBROWSE_PARENT_PID`; `CleanupStaleInstances()` kills any stale processes before spawn. | **PHYSICALLY RESOLVED** |
| **P0-C** | `SafeBrowseChild-Pilot.exe --status` reported `Protected` when service was dead. | CLI only checked if adapter DNS was `127.0.0.1`, ignoring SCM service supervision state. | `evaluateSystemStatus()` executes `sc.exe query SafeBrowseChildService`. If service is stopped, returns `Degraded (Service STOPPED / Unsupervised)`. Only returns `Protected` when service is running, resolver is healthy, and policy is valid. | **PHYSICALLY RESOLVED** |

---

## 6. Release Hardening & Remaining GA Blockers

> [!WARNING]
> **NO GA DECLARATION**: Completion of Pilot Physical Run #20 validates the local enforcement and crash-recovery architecture for Stage 11 Step 4 pilot testing. It **does not** constitute General Availability (GA) readiness. Production public rollout remains gated on the following release-hardening requirements.

### P0 / GA Blockers & Remaining Work

1. **Windows Executable & MSI Authenticode Signing:**
   - Binaries and MSI in Run #20 are unsigned (pilot testing mode).
   - Commercial release requires EV Code Signing certificate to satisfy Windows SmartScreen and Anti-Malware Scan Interface (AMSI).
2. **Secure Silent Auto-Updater:**
   - Production deployment requires a cryptographically signed background updater service with rollback capabilities to safely update `SafeBrowseChild-Pilot.exe` and `SafeBrowseServiceHost.exe` without manual MSI re-installation.
3. **Production HTTPS Backend & Public Cloud Endpoint:**
   - Pilot validation operated against an internal Tailscale mesh IP (`http://100.88.17.16:11002`).
   - GA requires high-availability public HTTPS/WSS endpoints (`https://api.safebrowse.io`) with mTLS or strict token-based device authentication.
4. **Windows Multi-User & Fast User Switching Validation:**
   - Validation must be conducted across multiple active Windows user accounts (Standard User child accounts vs. Administrator parent accounts) and Fast User Switching sessions.
5. **Android Production Signing & Physical Validation:**
   - Final release signing with production keystore, target SDK 34 compliance, and extended physical validation across major Android OEM distributions (Samsung One UI, Google Pixel, Xiaomi MIUI).
6. **Dependency & Supply Chain Security Hardening:**
   - Static analysis, Software Bill of Materials (SBOM) generation, and zero-vulnerability audit gate for production packaging.
7. **Final Release Candidate (RC) Validation:**
   - End-to-end multi-week soak testing across a representative family cohort before GA sign-off.
