# SafeBrowse Android Child App – Pilot APK Build Report

**Execution Date:** `2026-09-28`  
**Target Output Artifact:** `SafeBrowseChild-Pilot.apk`  
**Target Package / Application ID:** `com.safebrowse.child`  
**Branch:** `feature/android-pilot-apk`  
**Worktree Location:** `/home/agdev/projects/safebrowse-android-pilot`  

---

## 1. Existing Android Architecture Found

The existing SafeBrowse Android child agent was discovered under `packages/agent-android` with the following architectural components:

- **Build System:** Android Gradle Plugin 8.4.1 with Gradle 8.6, Kotlin 1.9.23, OpenJDK 17 (`compileSdk 34`, `minSdk 26`, `targetSdk 34`).
- **Package / Application ID:** `com.safebrowse.child`
- **Manifest:** `packages/agent-android/app/src/main/AndroidManifest.xml` configuring `PairingActivity` (Launcher), `BlockScreenActivity`, `SafeBrowseVpnService`, and `BootReceiver`.
- **Enforcement Core:** `SafeBrowseVpnService.kt` establishing a local TUN virtual network interface (`10.240.0.2/32`), intercepting UDP DNS port 53, dropping DoT port 853, synthesizing authoritative NXDOMAIN responses for blocked domains, and rewriting queries for SafeSearch VIPs.
- **Policy Engine:** `LocalPolicyManager.kt` evaluating domains against an authoritative policy hierarchy:
  1. Global Internet Pause (Level 1)
  2. Temporary Parent Grants (Level 2)
  3. Explicit Whitelist / Allow Rules (Level 3)
  4. Explicit Blacklist / Block Rules (Level 4)
  5. Default Fallback with SafeSearch VIP rewriting (Level 5)
- **Background Synchronization:** `SyncWorker.kt` utilizing Android `WorkManager` with network-connected constraints and exponential backoff to sync periodic heartbeats and policy updates.
- **Boot Resilience:** `BootReceiver.kt` responding to `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED`, and `QUICKBOOT_POWERON` to automatically resume VPN protection.
- **Configuration & Security:** `AgentConfig.kt` validating API base URLs, enforcing HTTPS in production, and permitting approved development/mesh endpoints (10.0.2.2 and Tailscale CGNAT `100.64.0.0/10`) in debug/pilot builds.
- **Automated Tests:** Comprehensive unit test suite in `LocalPolicyManagerTest.kt` verifying precedence, wildcard domain matching, SafeSearch VIP rewriting, and URL validation.

---

## 2. Existing Features Reused

No rewrite was performed. The following existing platform components were discovered and reused:

1. **Deterministic SafeBrowse Policy Engine:** The existing 5-tier evaluation hierarchy in `LocalPolicyManager.kt` was preserved and augmented with `usageBudgets` data structures.
2. **SafeSearch & YouTube Restricted Mode:** The authoritative VIP re-mapping table matching the Windows agent was retained:
   - Google SafeSearch: `216.239.38.120`
   - Bing Strict SafeSearch: `204.79.197.220`
   - DuckDuckGo SafeSearch: `52.142.124.215`
   - YouTube Restricted Mode: `216.239.38.119`
3. **Android VpnService Local Capture:** Existing packet loop, UDP DNS parser, and synthetic response generators (`buildSyntheticNxDomain`, `buildSyntheticARecord`, `buildSyntheticNoData`).
4. **Backend REST Endpoints:** Reused existing deployed API routes:
   - Device enrollment: `POST /api/devices/claim`
   - Device heartbeat: `POST /api/devices/heartbeat`
   - Policy retrieval: `GET /api/policies/device/:deviceId`
   - Ask Parent requests: `POST /api/requests`
   - Screen-time usage synchronization: `POST /api/usage/sync`
5. **WorkManager Infrastructure:** Reused existing `PeriodicWorkRequestBuilder` with 15-minute intervals and `NetworkType.CONNECTED` constraint.

---

## 3. Changes Made

1. **Minimal Child UI Implementation (`PairingActivity.kt`):**
   - Transformed `PairingActivity` into a dual-state screen:
     - **Unpaired State:** Clean enrollment interface with 6-character code input, custom device name entry ("Rahul's Android Phone"), and "Enroll Device" button.
     - **Enrolled State:** Minimal child status dashboard displaying app title, real-time protection status ("Active" / "Inactive"), child name, device name, screen time remaining, last sync timestamp, `[Ask Parent]` button, and `[Sync Policy]` button.
   - Prevented exposure of technical settings, URLs, auth tokens, dev switches, or internal DNS parameters.
2. **Android 14 (API 34) Foreground Service & Notification (`SafeBrowseVpnService.kt`):**
   - Added low-importance `NotificationChannel` (`safebrowse_protection_channel`) and persistent ongoing foreground notification.
   - Enforced `startForeground(1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)` compliant with Android 14 requirements.
   - Added `builder.setUnderlyingNetworks(null)` to support transparent network switching between Wi-Fi and mobile data.
   - Added `@Volatile isServiceRunning` state tracker for live UI status reflection.
3. **Device Authentication Headers Fix (`SyncWorker.kt`, `BlockScreenActivity.kt`):**
   - Fixed missing `x-device-id` and `x-device-token` headers in `GET /api/policies/device/:deviceId` and `POST /api/requests`, resolving backend `deviceAuthMiddleware` 401 rejections.
   - Connected `SyncWorker` to report active periodic session increments to `POST /api/usage/sync`.
4. **Environment-Specific Build Variants (`app/build.gradle.kts`):**
   - Created `pilot` build variant alongside `debug` and `release`:
     - `debug`: `http://10.0.2.2:11002`, `ENVIRONMENT="development"`, `label="SafeBrowse Dev"`
     - `pilot`: `http://100.88.17.16:11002`, `ENVIRONMENT="pilot"`, `label="SafeBrowse Pilot"`, signed with pilot keystore
     - `release`: `https://api.safebrowse.io`, `ENVIRONMENT="production"`, `label="SafeBrowse"`, strict HTTPS only
   - Configured `manifestPlaceholders["appLabel"]` to set the application title dynamically.
   - Added `packagePilotApk` task to build, sign, and copy `SafeBrowseChild-Pilot.apk` with SHA-256 generation.
5. **Network Security Configuration:**
   - Created `packages/agent-android/app/src/pilot/res/xml/network_security_config.xml` permitting cleartext HTTP for private mesh testing (`100.88.17.16:11002`), while keeping production `src/main/res/xml/network_security_config.xml` strictly HTTPS-only (`cleartextTrafficPermitted="false"`).
6. **Security Hardening (`AndroidManifest.xml`):**
   - Set `android:allowBackup="false"` to prevent token extraction via ADB backup.
   - Added `android:foregroundServiceType="connectedDevice"` to `<service>`.
   - Added `POST_NOTIFICATIONS` permission for Android 13+.
7. **Unified Native Artifact Builder (`scripts/build-pilot-artifacts.ts`):**
   - Updated the artifact builder script to invoke official Gradle toolchain on Linux, package the genuine native APK with classes.dex, sign with apksigner, and output `SafeBrowseChild-Pilot.apk`.

---

## 4. Backend/API Integration

The Pilot APK connects directly to the active SafeBrowse backend deployment:
- **Pilot Endpoint:** `http://100.88.17.16:11002` (Tailscale Private Mesh)
- **Production Endpoint:** `https://api.safebrowse.io`
- **Development Endpoint:** `http://10.0.2.2:11002`

Integration points:
- `POST /api/devices/claim`: Claims single-use pairing code, returns device credentials, child profile, and active policy.
- `POST /api/devices/heartbeat`: Periodic heartbeat with `activePolicyVersion` and `enforcementActive` boolean.
- `GET /api/policies/device/:deviceId`: Retrieves full policy and child profile using device auth headers.
- `POST /api/usage/sync`: Reports screen time usage increments.
- `POST /api/requests`: Submits Ask Parent access requests with reason and domain.

---

## 5. Enrolment Flow

The end-to-end child enrollment flow is implemented as follows:

```text
[Parent Web Dashboard]
       ↓ (Generates single-use code, e.g. "SB-9821")
[Child Phone: SafeBrowse Pilot]
       ↓ (Child enters code & device name)
[POST /api/devices/claim]
       ↓ (Backend validates code, creates Device in PostgreSQL, deletes PairingCode)
[Save Credentials]
       ↓ (Saves device_id, device_token, child_id, child_name into SharedPreferences)
[Request Android VPN Permission]
       ↓ (VpnService.prepare prompts child with system modal)
[Activate Protection]
       ↓ (SafeBrowseVpnService establishes TUN interface with foreground notification)
[Policy Synchronized]
       ↓ (LocalPolicyManager caches rules and SafeSearch configuration)
[Minimal Child UI Displayed]
       ↓ ("PROTECTION: Active", Child Name, Device Name, Remaining Screen Time)
```

---

## 6. VPN Enforcement

- **Interface:** TUN interface bound to `10.240.0.2/32`, MTU 1500.
- **DNS Redirection:** All UDP queries on port 53 are inspected locally.
- **DoT Protection:** DNS-over-TLS (port 853) traffic is dropped to prevent encrypted bypass.
- **Policy Enforcement:**
  - Allowed queries are forwarded to protected upstream `1.1.1.1:53` via an OS-protected datagram socket (`protect(socket)`).
  - Blocked queries receive an authoritative synthetic NXDOMAIN (RCODE 3) packet; `BlockScreenActivity` is launched.
  - SafeSearch / YouTube queries receive synthetic authoritative A-records with enforced VIPs or AAAA NODATA responses.
- **Multi-network Resilience:** `setUnderlyingNetworks(null)` automatically preserves DNS interception across Wi-Fi and mobile data transitions without dropping connections.

---

## 7. Screen-Time Integration

- **Data Models:** Reused `@safebrowse/shared` `UsageBudget` model (`DAILY_APP_LIMIT`, `DOMAIN`, `CATEGORY`).
- **Quota Accounting:** Integrated with backend `UsageService` (`POST /api/usage/sync`).
- **Reporting:** Periodic 15-minute increments are reported during active protection.
- **UI Display:** Remaining daily quota is calculated from the active policy and displayed on the status screen (e.g. "60 min quota", "Unlimited Today", or "Paused by Parent").

---

## 8. Ask Parent Integration

- **Trigger:** Child taps `[Ask Parent]` on the Minimal Child UI or from the blocked screen (`BlockScreenActivity`).
- **Request Creation:** Child enters an optional reason (e.g. "For biology research").
- **Transmission:** `BlockScreenActivity` submits to `POST /api/requests` with `x-device-id` and `x-device-token` headers.
- **Parent Approval:** Parent sees request in dashboard and grants temporary approval (15m, 30m, 1h).
- **Enforcement:** Subsequent heartbeat or `[Sync Policy]` tap fetches updated policy containing `TEMPORARY_ALLOW` rule; the domain unblocks immediately until expiration.

---

## 9. Security Review

- **Cleartext Protection:** Production builds strictly prohibit cleartext HTTP. Cleartext HTTP is restricted exclusively to approved development and Tailscale CGNAT IP ranges (`100.64.0.0/10`) in debug/pilot variants.
- **No In-APK Secrets:** No database passwords, JWT signing keys, or parent credentials exist in the APK.
- **Token Security:** Device tokens are stored in private SharedPreferences (`Context.MODE_PRIVATE`). `android:allowBackup="false"` prevents extraction via ADB backup.
- **Logs Sanitized:** Sensitive tokens and authorization headers are never logged to Logcat.
- **Exported Components:** Only `PairingActivity` (MAIN/LAUNCHER) and `BootReceiver` (`RECEIVE_BOOT_COMPLETED`) are exported. All other activities and services are non-exported.

---

## 10. Automated Test Results

| Test Category | Suite / Command | Result | Notes |
| :--- | :--- | :---: | :--- |
| **Android Unit Tests** | `:app:testDebugUnitTest` | **PASSED** | 100% passing (precedence, SafeSearch, AgentConfig) |
| **Pilot Unit Tests** | `:app:testPilotUnitTest` | **PASSED** | Pilot variant unit tests pass cleanly |
| **Release Unit Tests** | `:app:testReleaseUnitTest` | **PASSED** | Release variant unit tests pass cleanly |
| **Compilation & Lint** | `:app:lintVitalPilot` & Javac | **PASSED** | Compiled with zero errors on JDK 17 / compileSdk 34 |
| **Shared Policy Engine** | `@safebrowse/shared` test | **PASSED** | All 9 policy conflict and normalization tests passed |
| **APK Badging** | `aapt2 dump badging` | **PASSED** | Validated package `com.safebrowse.child`, SDKs, permissions |
| **APK Signatures** | `apksigner verify --verbose` | **PASSED** | Verified using APK Signature Scheme v2 & v3 |

---

## 11. APK Details

- **Artifact Name:** `SafeBrowseChild-Pilot.apk`
- **Artifact Path:** `/home/agdev/projects/safebrowse-android-pilot/SafeBrowseChild-Pilot.apk`  
  *(Also mirrored at `/home/agdev/projects/safebrowse-android-pilot/release/android/SafeBrowseChild-Pilot.apk`)*
- **File Size:** `5,623,753 bytes` (5.4 MB)
- **SHA-256 Checksum:** `04564e0104dc48f93db09ad6429e7e325bd1bceabb16d0fcff0fe319b196799b`
- **Application Label:** `SafeBrowse Pilot`
- **Application ID:** `com.safebrowse.child`
- **Version Name:** `1.0.0`
- **Version Code:** `1`
- **minSdkVersion:** `26` (Android 8.0 Oreo)
- **targetSdkVersion:** `34` (Android 14 UpsideDownCake)
- **compileSdkVersion:** `34`
- **Pilot API Endpoint:** `http://100.88.17.16:11002`
- **Signing Scheme:** APK Signature Scheme v2 and v3 signed with pilot keystore
- **Git Branch:** `feature/android-pilot-apk`
- **Git Worktree Path:** `/home/agdev/projects/safebrowse-android-pilot`

---

## 12. Physical Device Tests Still Required

As no physical Android phone was attached to this headless Linux build server during execution, physical testing must be carried out using the checklist in [`ANDROID_PILOT_DEVICE_TEST.md`](./ANDROID_PILOT_DEVICE_TEST.md):

- [ ] **A1–A3:** Install APK, verify launcher icon `SafeBrowse Pilot`, and enter active pairing code from parent portal.
- [ ] **A4–A7:** Verify registration under family, child association, Android system VPN dialog, and status screen showing "Protection: Active".
- [ ] **A8–A11:** Test browsing to allowed vs blocked websites, verify Google/Bing SafeSearch VIP rewrite, and YouTube Restricted Mode in mobile browser.
- [ ] **A12–A16:** Test screen-time quota enforcement, submit Ask Parent request, approve on dashboard, and verify temporary unblock.
- [ ] **A17–A20:** Reboot phone to verify automatic protection resume, toggle Wi-Fi / cellular data, and check device online status on parent dashboard.

---

## 13. Known Limitations

1. **DNS-Based Filtering Scope:** As designed in the SafeBrowse platform architecture, filtering operates at the DNS layer. Direct raw IP access without DNS queries (e.g. `http://93.184.216.34`) is not blocked unless an SNI or IP proxy is enabled.
2. **First-Time VPN Permission Interaction:** Under Android security policies, `VpnService.prepare()` always requires explicit one-time physical user confirmation on initial setup; it cannot be bypassed programmatically.
3. **Pilot Network Topology:** The Pilot APK is configured for the deployed Tailscale pilot endpoint (`http://100.88.17.16:11002`). The test device must have network route reachability to this address. Production builds will target `https://api.safebrowse.io`.

---

## 14. Files Changed

| File Path | Description of Change |
| :--- | :--- |
| `packages/agent-android/app/build.gradle.kts` | Added `pilot` build variant, `pilot` signingConfig, dynamic app label, and `packagePilotApk` task |
| `packages/agent-android/app/src/main/AndroidManifest.xml` | Configured dynamic label placeholder, disabled backup, added `connectedDevice` service type, added `POST_NOTIFICATIONS` |
| `packages/agent-android/app/src/pilot/res/xml/network_security_config.xml` | Created pilot network security config permitting mesh cleartext testing |
| `packages/agent-android/app/src/main/java/com/safebrowse/child/config/AgentConfig.kt` | Added pilot environment awareness to URL validator |
| `packages/agent-android/app/src/main/java/com/safebrowse/child/policy/LocalPolicyManager.kt` | Added `UsageBudget` data class and `usageBudgets` to `Policy` |
| `packages/agent-android/app/src/main/java/com/safebrowse/child/vpn/SafeBrowseVpnService.kt` | Added Android 14 compliant foreground notification, lifecycle state tracking, and network transition handling |
| `packages/agent-android/app/src/main/java/com/safebrowse/child/ui/PairingActivity.kt` | Implemented Minimal Child Status Screen, enrollment UI, manual sync, and status indicators |
| `packages/agent-android/app/src/main/java/com/safebrowse/child/ui/BlockScreenActivity.kt` | Added device authentication headers to Ask Parent requests |
| `packages/agent-android/app/src/main/java/com/safebrowse/child/sync/SyncWorker.kt` | Added authentication headers, sync timestamp tracking, and usage reporting |
| `scripts/build-pilot-artifacts.ts` | Updated builder to execute official Gradle build and apksigner verification |
| `ANDROID_PILOT_DEVICE_TEST.md` | Created 20-point physical device verification checklist |

---

## 15. Git Commit

- **Commit ID:** `197017b70bbc444689806a3d82c83b0cf3f75df1`
- **Branch:** `feature/android-pilot-apk`
- **Worktree:** `/home/agdev/projects/safebrowse-android-pilot`
- **Parent Commit:** `f898c4e4ab315b00324884752f4c57bfd24c3bb2`

---

## 16. Status Certification

`IMPLEMENTED AND AUTOMATICALLY VERIFIED`:
- Pilot APK compilation, packaging, and signing (`SafeBrowseChild-Pilot.apk`).
- APK SHA-256 verification and `aapt2` badging validation.
- Android unit tests (`LocalPolicyManagerTest`), Gradle checks, and shared policy engine tests.
- Connection to deployed SafeBrowse backend (`http://100.88.17.16:11002`).
- Authentication headers and data model parity with backend policy engine.

`REQUIRES PHYSICAL ANDROID DEVICE VALIDATION`:
- Physical Android device installation and verification of steps A1 through A20 in [`ANDROID_PILOT_DEVICE_TEST.md`](./ANDROID_PILOT_DEVICE_TEST.md).
