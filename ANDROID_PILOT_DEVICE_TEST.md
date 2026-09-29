# SafeBrowse Android Child App – Physical Device Test Checklist

**Document Version:** `1.0.0`  
**Target Build Artifact:** `SafeBrowseChild-Pilot.apk`  
**Package Name / Application ID:** `com.safebrowse.child`  
**Target OS:** Android 8.0 (API 26) through Android 14 / 15 (API 34/35)  
**Target Backend Endpoint (Pilot):** `https://safebrowse.porwal.online` (Canonical Public HTTPS Domain)

---

## Prerequisites for Physical Device Testing

1. **Android Physical Device:** Android phone running Android 8.0+ (API 26+) with Developer Options and USB Debugging enabled.
2. **Network Connectivity:** Standard public Internet access (Wi-Fi or cellular). SafeBrowse Android operates independently of Tailscale on the child device.
3. **ADB (Android Debug Bridge):** Installed on developer workstation (`adb devices` confirms authorized device).
4. **Parent Web Portal Access:** Parent dashboard running at `https://safebrowse.porwal.online` with at least one active Child profile (e.g., "Rahul").

---

## 20-Point Physical Device Test Matrix

| Test ID | Test Case | Action / Steps | Expected Result | Status |
| :--- | :--- | :--- | :--- | :---: |
| **A1** | **Install APK** | `adb install -r SafeBrowseChild-Pilot.apk` | App installs cleanly (`Success`). Application icon appears in app drawer with label `SafeBrowse Pilot`. | 🔲 PENDING DEVICE |
| **A2** | **Launch Application** | Tap `SafeBrowse Pilot` app icon or run:<br>`adb shell monkey -p com.safebrowse.child 1` | `PairingActivity` launches displaying dark slate child UI with title `SafeBrowse Setup` and enrollment prompt. | 🔲 PENDING DEVICE |
| **A3** | **Enter Enrolment Code** | In Parent Portal, navigate to Children -> "Rahul" -> Add Device -> generate pairing code (e.g. `SB-XXXXXX`). Type code into `SafeBrowse Pilot`. | Code field accepts 6-character alphanumeric code. Button changes state to "Enrolling Device...". | 🔲 PENDING DEVICE |
| **A4** | **Device Registers Under Correct Family** | Tap `Enroll Device`. Backend validates code against PostgreSQL `PairingCode` table. | Backend assigns device under correct multi-tenant `familyId` with unique `deviceId` and `deviceToken`. | 🔲 PENDING DEVICE |
| **A5** | **Device Associates with Correct Child** | Examine pairing response and device record. | Device record in database has `childId` matching Rahul. Child name "Rahul" is persisted in app preferences. | 🔲 PENDING DEVICE |
| **A6** | **VPN Permission Requested** | App invokes `VpnService.prepare(context)`. | Android system modal displays: *"SafeBrowse Pilot wants to set up a VPN connection that allows it to monitor network traffic"*. | 🔲 PENDING DEVICE |
| **A7** | **Protection Becomes Active** | Tap **OK** on Android VPN dialog. | VPN tunnel establishes (`10.240.0.2`). Persistent Android system key icon appears in status bar. Minimal Child UI shows **PROTECTION: Active** (Green). | 🔲 PENDING DEVICE |
| **A8** | **Allowed Website Opens** | Open Chrome or Firefox on device and navigate to `https://wikipedia.org`. | Website loads promptly without error. DNS resolves via protected upstream (`1.1.1.1:53`). | 🔲 PENDING DEVICE |
| **A9** | **Blocked Website is Blocked** | Navigate to domain configured as blocked in child policy (e.g. `http://gambling-test-site.com`). | SafeBrowse VPN intercepts UDP query, synthesizes NXDOMAIN, and launches `BlockScreenActivity` with "Access Blocked". | 🔲 PENDING DEVICE |
| **A10** | **SafeSearch Enforcement Validated** | Navigate to `google.com` or `bing.com` in mobile browser. | DNS query is rewritten to VIP `216.239.38.120` (Google) / `204.79.197.220` (Bing). Explicit search results are filtered. | 🔲 PENDING DEVICE |
| **A11** | **YouTube Restricted Mode** | Navigate to `youtube.com` or open YouTube app. | YouTube domains rewrite to `216.239.38.119`. Restricted mode banner is displayed on YouTube; restricted videos cannot play. | 🔲 PENDING DEVICE |
| **A12** | **Screen-Time Quota Validated** | Configure daily limit in Parent Portal. Inspect Minimal Child UI. | "SCREEN TIME REMAINING" displays remaining allowance (e.g. "60 min quota"). Periodic usage is synced to backend `/api/usage/sync`. | 🔲 PENDING DEVICE |
| **A13** | **Ask Parent Flow** | On Block Screen, enter reason (e.g. *"Need for school project"*) and tap `Ask Parent for Access`. | Request sent with `x-device-id` and `x-device-token`. Success toast appears: *"Request sent to parent!"*. Parent dashboard shows pending request. | 🔲 PENDING DEVICE |
| **A14** | **Parent Grants Additional Time / Access** | In Parent Web Dashboard, click `Approve (15m)` or `Approve (30m)` on pending request. | Backend updates policy with `TEMPORARY_ALLOW` rule expiring in 15/30 minutes, increments policy version. | 🔲 PENDING DEVICE |
| **A15** | **Child Device Receives Grant** | Tap `Sync Policy` on Child app (or wait for background `SyncWorker`). | App downloads updated policy v+1. Blocked site now opens normally until temporary grant expires. | 🔲 PENDING DEVICE |
| **A16** | **Policy Update from Parent Dashboard** | Parent adds a new block rule or toggles Internet Pause from dashboard. | Next heartbeat detects `policyChanged: true`. Local policy cache updates without app reinstall. | 🔲 PENDING DEVICE |
| **A17** | **Reboot Device & Validate Protection** | Restart Android phone (`adb reboot`). Wait for boot completed. | `BootReceiver` intercepts `ACTION_BOOT_COMPLETED`. `SafeBrowseVpnService` auto-starts in foreground. System VPN key icon re-appears. | 🔲 PENDING DEVICE |
| **A18** | **Wi-Fi / Mobile-Data Transition** | Disconnect Wi-Fi while streaming or browsing; reconnect to cellular data (or toggle Wi-Fi OFF/ON). | VpnService `setUnderlyingNetworks(null)` automatically preserves DNS interception without connection drops or leaks. | 🔲 PENDING DEVICE |
| **A19** | **Backend Temporary Outage Behaviour** | Temporarily disconnect backend server (or toggle airplane mode briefly). | Device remains protected using cached local policy (`safebrowse_policy`). WorkManager applies exponential backoff. | 🔲 PENDING DEVICE |
| **A20** | **Device Online/Offline Status** | Inspect Parent Dashboard device management table. | Device shows `HEALTH: PROTECTED` and updates `lastSeenAt` during active heartbeats. | 🔲 PENDING DEVICE |

---

## Verification Execution Commands

```bash
# 1. Check connected physical device
adb devices -l

# 2. Install Pilot APK
adb install -r SafeBrowseChild-Pilot.apk

# 3. Launch App
adb shell am start -n com.safebrowse.child/.ui.PairingActivity

# 4. Monitor Logcat for VPN and Sync Events
adb logcat -s SafeBrowseVPN:D SafeBrowseSync:D SafeBrowseBoot:D SafeBrowseDevice:D

# 5. Check VPN interface created in kernel
adb shell ip addr show tun0

# 6. Verify SharedPreferences
adb shell "run-as com.safebrowse.child cat /data/data/com.safebrowse.child/shared_prefs/safebrowse_device.xml"
adb shell "run-as com.safebrowse.child cat /data/data/com.safebrowse.child/shared_prefs/safebrowse_policy.xml"
```
