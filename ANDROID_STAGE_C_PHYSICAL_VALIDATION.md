# SafeBrowse Stage C — Android Physical Validation Checklist

**Document Version:** `1.0.0-validation`  
**Execution Environment:** Physical Android Phone (Android 8.0 through Android 14/15)  
**Baseline Commit SHA:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`  
**Candidate Release Package:** `SafeBrowseChild-Validation-1.0.0.apk` (`SafeBrowseChild-Pilot.apk`)  
**SHA-256 Checksum:** `71730bcb9d17a999a721c25c969c0f407ae5a4ac6192f99ec7e51f7f53be43c9`  
**Package Name / App ID:** `com.safebrowse.child`  
**Target Backend:** `https://safebrowse.porwal.online`  
**Status:** `READY FOR PHYSICAL EXECUTION`

---

## Prerequisites for Physical Device Testing

1. **Physical Android Handset:** Running Android 8.0+ (API 26) through Android 14/15 (API 34/35).
2. **Network Connection:** Standard Wi-Fi or cellular network (zero Tailscale required on child phone).
3. **ADB Enabled:** Optional for developer log monitoring:
   ```bash
   adb devices -l
   ```
4. **Parent Web Portal Access:** Active parent account at `https://safebrowse.porwal.online` with at least one active child profile.

---

## 10-Step Sequential Physical Execution Matrix

### A1. INSTALLATION & ENROLMENT
* **Objective:** Install validation candidate APK, pair device to child profile, grant Android VPN permission.
* **Execution:**
  1. Transfer `SafeBrowseChild-Validation-1.0.0.apk` to Android device or install via ADB:
     ```bash
     adb install -r SafeBrowseChild-Validation-1.0.0.apk
     ```
  2. In Parent Web Dashboard (`/devices`), generate 6-digit pairing code (e.g. `SB-XXXXXX`).
  3. Open `SafeBrowse Pilot` app icon on phone.
  4. Type pairing code and device label ("Android Phone"); tap **Enroll Device**.
  5. When prompted by system modal ("SafeBrowse Pilot wants to set up a VPN connection..."), tap **OK**.
* **Expected Result:**
  - App displays dark slate UI with green status badge: **`PROTECTION: Active`**.
  - System VPN key icon appears in Android status bar.
  - Device record created in PostgreSQL under correct family and child tenancy.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A2. HEARTBEAT CADENCE & ONLINE STABILITY
* **Objective:** Observe periodic heartbeats and verify phone stays online without flapping offline.
* **Execution:**
  1. Leave phone connected to Wi-Fi with screen on for 3 minutes.
  2. Observe Parent Portal Device Inventory table.
  3. Track at least 3 successive heartbeat intervals (~45–60s).
* **Expected Result:**
  - `lastHeartbeatAt` updates every ~60 seconds.
  - Device remains continuously marked **`Online`** (never flips to `Offline` inside the 120-second timeout window).
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A3. REAL-TIME POLICY SYNCHRONIZATION
* **Objective:** Verify remote policy edits push down to Android within seconds.
* **Execution:**
  1. In Parent Portal, add a new blocked domain (e.g. `distraction-test.com`).
  2. Save policy.
  3. Wait 15 seconds; on Android phone, navigate to `http://distraction-test.com` in Chrome.
* **Expected Result:**
  - Android agent receives updated policy version via background worker or heartbeat sync.
  - Domain is blocked immediately without restarting app or VPN.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A4. ACTIVITY TELEMETRY & ATTRIBUTION TRACE
* **Objective:** Confirm both allowed and blocked domain events transmit reliably with accurate metadata.
* **Execution:**
  1. In mobile browser, visit allowed domain: `https://wikipedia.org`.
  2. Visit blocked domain: `http://gambling-test-site.com`.
  3. In Parent Dashboard, open Child Activity Feed.
* **Expected Result:**
  - Blocked event appears with:
    * `childId`: Matching child
    * `deviceId`: Android phone ID
    * `domain`: `gambling-test-site.com`
    * `action`: `BLOCK`
    * `timestamp`: Precise wall-clock timestamp (no timezone drift)
  - Full URLs or search keywords are never logged (privacy-first telemetry).
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A5. DINNER TIME (GLOBAL INTERNET PAUSE)
* **Objective:** Verify family dinner time pauses internet browsing cleanly on Android.
* **Execution:**
  1. In Parent Portal, click **Pause Internet (Dinner Time)**.
  2. Attempt to open any standard webpage in mobile browser.
  3. In Parent Portal, toggle **Pause Internet** back to **OFF**.
  4. Attempt browsing again.
* **Expected Result:**
  - During pause: UDP DNS returns synthetic NXDOMAIN; browser shows internet paused landing screen.
  - Upon resume: Browsing resumes immediately without disconnecting VPN tunnel or toggling Wi-Fi.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A6. BEDTIME & NETWORK CATEGORY RESTRICTION
* **Objective:** Verify network-level routine controls.
* **Execution:**
  1. Schedule a Bedtime curfew window active at current phone time.
  2. Open non-exempt web domain.
* **Expected Result:**
  - Network-level DNS filtering blocks non-whitelisted domains.
  - Note: App does not claim unsupported process/app-killing on Android without root/DPC.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A7. ASK PARENT WORKFLOW FROM BLOCK SCREEN
* **Objective:** Confirm authenticated access request travels from Android TUN block screen to Parent Portal.
* **Execution:**
  1. Trigger block screen on Android device.
  2. In text box, enter: `"Need for science homework"`.
  3. Tap **[Ask Parent for Access]**.
  4. In Parent Dashboard, review request and click **Approve (15 min)**.
  5. Wait 15 seconds and re-load blocked page.
* **Expected Result:**
  - Request displays child name, domain, and reason in Parent Portal.
  - Temporary grant rule is issued with 15-minute TTL.
  - Page loads successfully until grant expires.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A8. DOMAIN USAGE & USAGE_STATS CAPABILITY DISCLOSURE
* **Objective:** Verify truthfulness of app usage metrics vs domain metrics.
* **Execution:**
  1. Browse domains with configured usage budgets.
  2. If Android permission `PACKAGE_USAGE_STATS` has NOT been granted to SafeBrowse:
     - Verify device reports `appUsageAvailable: false` in heartbeat capabilities.
     - Inspect Parent Portal Screen Time section.
* **Expected Result:**
  - Domain-level usage increments accurately in PostgreSQL `ChildUsageRecord`.
  - Parent Portal explicitly surfaces **`Not Available`** for Native App Usage (never displays deceptive "0 minutes").
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A9. LOCAL OUTBOX SURVIVABILITY ON APP RESTART
* **Objective:** Verify SQLite / Room DB activity queue survives app process death and flushes upon reconnection.
* **Execution:**
  1. Put phone in Airplane Mode.
  2. Browse blocked test site (triggers local block event queued in Room DB).
  3. Force-stop SafeBrowse app from Android Settings (`am force-stop com.safebrowse.child`).
  4. Re-open SafeBrowse app and disable Airplane Mode.
* **Expected Result:**
  - Queued activity event is not lost.
  - Event flushes to backend `/api/activity` within 60 seconds with original client timestamp.
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

### A10. ANDROID SYSTEM REBOOT SURVIVABILITY
* **Objective:** Verify `BootReceiver` behavior and automatic service recovery on reboot.
* **Execution:**
  1. Restart phone: `adb reboot` (or manual hardware power cycle).
  2. Unlock device to home screen.
  3. Observe status bar and attempt web browsing.
* **Expected Result:**
  - `BootReceiver` handles `ACTION_BOOT_COMPLETED`.
  - `SafeBrowseVpnService` starts in foreground with system key icon.
  - Device sends heartbeat to cloud within 90 seconds.
  - *Limitation Note:* On Android 10+ Direct Boot, protection resumes once user completes first device unlock (Credential Storage unlocked).
* **Actual Result:** `[ PENDING PHYSICAL EXECUTION ]`

---

## Sign-off Certification Gate

| Role | Name | Status | Timestamp |
| :--- | :--- | :--- | :--- |
| **Android Device Engineer** | | 🔲 PENDING EXECUTION | |
| **QA Lead** | | 🔲 PENDING EXECUTION | |
| **Platform Architect** | | 🔲 PENDING EXECUTION | |
