# SafeBrowse Stage 11 Step 4: Physical Device Pilot Test Checklist

**Tester Name:** `[ USER_FILL ]`  
**Physical Device Android Model & OS:** `[ USER_FILL: e.g. Samsung Galaxy S22, Android 14 ]`  
**Physical Device Windows Model & OS:** `[ USER_FILL: e.g. Dell XPS 15, Windows 11 23H2 ]`  
**Test Date:** `[ USER_FILL: YYYY-MM-DD ]`  
**Stage Status:** `IMPLEMENTED — AWAITING PHYSICAL VALIDATION`  

---

## 1. Android Physical Device Testing Protocol

### 1.1 Installation & Package Inspection
1. Connect physical Android device via USB with USB debugging enabled.
2. Run installation:
   ```bash
   adb install -r release/android/safebrowse-child-pilot.apk
   ```
3. Inspect package registration and permissions:
   ```bash
   adb shell dumpsys package com.safebrowse.child
   ```
4. Verify VPN connectivity state:
   ```bash
   adb shell dumpsys connectivity | grep -i vpn
   ```

### 1.2 Android Test Matrix (To be completed by Tester)

| # | Test Case Description | User Action / Command | Observed Result | Pass / Fail | Timestamp |
|---|---|---|---|---|---|
| **A1** | **App Launch & Enrollment** | Launch app; enter 6-digit pairing code from Parent Portal | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A2** | **VpnService Permission Prompt** | Tap 'Enroll Device' and accept system VPN connection prompt | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A3** | **Active Foreground Notification** | Check Android notification shade for persistent SafeBrowse indicator | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A4** | **Website Blocking in Chrome** | In Chrome, navigate to a blocked domain (e.g. `gambling-test-site.com`) | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A5** | **Multi-Browser Test (Firefox)** | In Firefox, navigate to the same blocked domain | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A6** | **Ask Parent Request** | On block screen, tap 'Ask Parent for Access' and enter reason | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A7** | **Parent Approval & Unlock** | Approve request in Parent Web Portal; refresh browser on phone | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A8** | **Temporary Expiry** | Wait 15 minutes or grant duration; refresh domain | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A9** | **Internet Pause Override** | Activate Internet Pause in Parent Portal; test browsing | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A10**| **Offline Enforcement** | Turn on Airplane Mode; attempt to visit blocked domain | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A11**| **Reboot Recovery** | Restart physical Android device; check if VPN restarts automatically | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **A12**| **Private DNS (DoT 853) Bypass** | Enable Private DNS in Android Settings (e.g. `one.one.one.one`); test block | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |

---

## 2. Windows Physical Device Testing Protocol

### 2.1 Installation & Service Verification
1. Open PowerShell or Command Prompt as **Administrator** on the physical Windows PC.
2. Run installer setup:
   ```cmd
   .\release\windows\SafeBrowseChild-Pilot-Setup.cmd --pairing-code SB-XXXXXX
   ```
3. Verify service registration and status:
   ```cmd
   sc.exe query SafeBrowseChildService
   ```
4. Verify port 53 DNS listener:
   ```cmd
   netstat -ano | findstr ":53 "
   ```
5. Check binary signature / Authenticode properties:
   ```powershell
   Get-AuthenticodeSignature .\release\windows\SafeBrowseChild-Pilot.exe
   ```

### 2.2 Windows Test Matrix (To be completed by Tester)

| # | Test Case Description | User Action / Command | Observed Result | Pass / Fail | Timestamp |
|---|---|---|---|---|---|
| **W1** | **Service Installation** | Run installer setup as Admin; verify `sc.exe query` status is RUNNING | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W2** | **Adapter DNS Configuration** | Check `Get-DnsClientServerAddress`; confirm `127.0.0.1` | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W3** | **Website Blocking in Edge** | In Microsoft Edge, navigate to blocked domain | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W4** | **Website Blocking in Chrome** | In Google Chrome, navigate to blocked domain | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W5** | **Ask Parent Flow** | Submit access request; approve in parent portal; confirm access | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W6** | **Bedtime / Pause Enforcement**| Toggle Internet Pause in parent portal; confirm DNS blocks | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W7** | **Offline Enforcement** | Disconnect Wi-Fi/Ethernet; verify cached policy blocks local resolution | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W8** | **Service Non-Admin Protection**| From standard user command prompt, attempt `sc.exe stop SafeBrowseChildService` | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W9** | **Reboot Persistence** | Restart Windows PC; verify `SafeBrowseChildService` auto-starts | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |
| **W10**| **Clean Uninstallation** | Run uninstaller rollback; verify original DNS adapters restored | `[ USER_RECORD ]` | `[ ] PASS / [ ] FAIL` | `____:____:____` |

---

## 3. Physical Evidence Artifacts to Collect
Once tests are executed, attach genuine artifacts into `evidence/stage11-step4/`:
- `adb-install-output.txt`
- `adb-dumpsys-package.txt`
- `windows-sc-query.txt`
- `windows-netstat-port53.txt`
- Android phone screenshots (`android-pairing.png`, `android-blocked.png`)
- Windows screenshots (`windows-edge-blocked.png`, `windows-service-running.png`)
- Redacted backend request logs during pairing and policy sync.
