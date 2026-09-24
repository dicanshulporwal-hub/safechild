# SafeBrowse Stage 11 Step 4: Windows MSI Pilot Physical Validation Procedure

**Target Platform:** Windows 10 / Windows 11 x64
**Target Package:** `SafeBrowseChild-Pilot.msi`
**Pilot Backend Endpoint:** `http://100.88.17.16:11002` (VM1 Tailscale-only mesh IP)
**Binary Architecture:** WiX Toolset v4 MSI + Native Service Host (`SafeBrowseServiceHost.exe`) + Node SEA (`SafeBrowseChild-Pilot.exe`)
**Storage Root:** `C:\ProgramData\SafeBrowse\`
**Installation Directory:** `C:\Program Files\SafeBrowse\`

---

## 1. Pre-Installation Phase

Open PowerShell as **Administrator** on the physical Windows laptop.

### 1.1 Verify Tailscale Mesh Connectivity
Ensure the laptop is connected to the Tailscale tailnet and can reach VM1:
```powershell
# Ping Tailscale IP
Test-NetConnection -ComputerName 100.88.17.16 -Port 11002
```
*Expected Result:* `TcpTestSucceeded : True`

### 1.2 Verify Backend Health API
```powershell
curl.exe -s http://100.88.17.16:11002/health
```
*Expected Result:* HTTP 200 JSON status response (e.g. `{"status":"ok",...}`).

### 1.3 Record Current Network Adapter DNS Configuration
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4 | Format-Table InterfaceAlias, InterfaceIndex, ServerAddresses
```
*Record the output to compare post-uninstall.*

---

## 2. Installation Phase

### 2.1 Elevated MSI Installation
Copy `SafeBrowseChild-Pilot.msi` to the laptop (e.g., `C:\Install\SafeBrowseChild-Pilot.msi`).
Open an elevated Command Prompt or PowerShell and execute:
```cmd
msiexec.exe /i "C:\Install\SafeBrowseChild-Pilot.msi" /l*v "C:\Install\safebrowse_install.log"
```
Or double-click the MSI and approve the UAC elevation prompt.

### 2.2 Confirm Presence in Windows Installed Apps
```powershell
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object DisplayName -like "*SafeBrowse*" | Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation
```
*Expected Result:*
- `DisplayName`: SafeBrowse Child Pilot
- `DisplayVersion`: 1.0.0.0
- `Publisher`: SafeBrowse
- Visible in Windows **Settings > Apps > Installed apps** (or **Programs and Features**).

### 2.3 Confirm Program Files Structure
```powershell
Get-ChildItem "C:\Program Files\SafeBrowse"
```
*Expected Files:*
- `SafeBrowseChild-Pilot.exe`
- `SafeBrowseServiceHost.exe`
- `SafeBrowse-Pair.cmd`
- `SafeBrowse-EmergencyRestore.cmd`
- `scripts\configure-dns.ps1`
- `scripts\restore-dns.ps1`

### 2.4 Confirm Service Registration
```cmd
sc.exe query SafeBrowseChildService
```
*Expected Result:*
- Service is registered with `START_TYPE: 2 DELAYED-AUTO`.
- Notice: If the device is not yet paired, the service enters standby waiting for pairing code claim.

---

## 3. Pairing Phase

### 3.1 Generate Pairing Code
1. Open the SafeBrowse Parent Web Portal in a browser: `http://100.88.17.16:11000` (or parent portal address).
2. Go to **Child Profiles > Rahul > Devices > Add Device**.
3. Select **Windows PC** to generate a 6-character code (e.g., `SB-849201`).

### 3.2 Execute Pairing Command
Run elevated PowerShell or Command Prompt:
```cmd
"C:\Program Files\SafeBrowse\SafeBrowse-Pair.cmd" SB-XXXXXX "Rahul's Windows Laptop"
```
*Alternative direct CLI:*
```cmd
"C:\Program Files\SafeBrowse\SafeBrowseChild-Pilot.exe" --pair SB-XXXXXX --name "Rahul's Windows Laptop" --backend-url http://100.88.17.16:11002
```

### 3.3 Confirm Pairing & Credential Storage
```powershell
# Confirm pairing output:
# [SafeBrowse] SUCCESS: Device successfully paired!
# Config saved to: C:\ProgramData\SafeBrowse\device-config.json

# Inspect persisted configuration
Get-Content "C:\ProgramData\SafeBrowse\device-config.json"
```
*Verification:*
- `deviceId`: Valid UUID string
- `deviceTokenEncrypted`: Non-empty Base64 DPAPI machine-scope ciphertext
- `backendUrl`: `http://100.88.17.16:11002`

### 3.4 Confirm Policy Cache Synchronized
```powershell
Get-ChildItem "C:\ProgramData\SafeBrowse\cache"
```
*Expected:* `policy-<deviceId>.json` is present with active parental rules.

---

## 4. Enforcement Verification Phase

### 4.1 Verify Service Running State
```cmd
sc.exe query SafeBrowseChildService
```
*Expected Result:* `STATE: 4 RUNNING`

### 4.2 Verify Port 53 UDP DNS Proxy
```cmd
netstat -ano | findstr ":53 "
```
*Expected Result:* UDP `127.0.0.1:53` listening under PID of `SafeBrowseChild-Pilot.exe`.

### 4.3 Verify Network Adapter DNS
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses -contains "127.0.0.1" }
```
*Expected Result:* Active Wi-Fi/Ethernet adapters have DNS set strictly to `127.0.0.1`.

### 4.4 Test Known Allowed Domain
```cmd
nslookup wikipedia.org 127.0.0.1
```
*Expected Result:* Authoritative or upstream answer returning Wikipedia's public IP address. Browsing in Edge/Chrome succeeds.

### 4.5 Test Configured Blocked Domain
```cmd
nslookup gambling-test-site.com 127.0.0.1
```
*Expected Result:*
- Returns `*** 127.0.0.1 can't find gambling-test-site.com: Non-existent domain` (`NXDOMAIN`).
- In Edge/Chrome, navigating to `http://127.0.0.1:8880/?domain=gambling-test-site.com` presents the SafeBrowse Block Page with 'Ask Parent for Access'.

### 4.6 Test SafeSearch VIP Rewriting
```cmd
nslookup google.com 127.0.0.1
nslookup bing.com 127.0.0.1
nslookup duckduckgo.com 127.0.0.1
nslookup youtube.com 127.0.0.1
```
*Expected Results:*
- `google.com` -> `216.239.38.120` (`forcesafesearch.google.com`)
- `bing.com` -> `204.79.197.220` (`strict.bing.com`)
- `duckduckgo.com` -> `52.142.124.215` (`safe.duckduckgo.com`)
- `youtube.com` -> `216.239.38.119` (`restrict.youtube.com`)

### 4.7 Test IPv6 / AAAA Bypass Protection
```cmd
nslookup -type=AAAA google.com 127.0.0.1
```
*Expected Result:* Returns `NOERROR` with `0` answer records (`NODATA`), forcing dual-stack browsers to resolve via IPv4 SafeSearch VIP.

### 4.8 Test Real-Time Policy Update
1. In Parent Portal, toggle a rule (e.g. unblock a domain or toggle Internet Pause).
2. Check `C:\ProgramData\SafeBrowse\logs\service-host.log` or console:
   *Expected:* Instant WebSocket event received (`POLICY_UPDATED`) and cache updated without service restart.

### 4.9 Test Offline / Disconnected Behavior
1. Disconnect laptop Wi-Fi / Ethernet.
2. Run:
   ```cmd
   nslookup gambling-test-site.com 127.0.0.1
   ```
*Expected Result:* Local DNS proxy resolves against local policy cache in `C:\ProgramData\SafeBrowse\cache` and continues to block the domain authoritatively.

---

## 5. Reboot Recovery Phase

### 5.1 Reboot System
```cmd
shutdown /r /t 5
```

### 5.2 Post-Boot Verification
Log in after restart:
```cmd
sc.exe query SafeBrowseChildService
netstat -ano | findstr ":53 "
```
*Expected Result:*
- `SafeBrowseChildService` started automatically (Delayed-Auto).
- Local DNS proxy on `127.0.0.1:53` is active.
- Adapter DNS points to `127.0.0.1`.
- Protection resumed with zero user intervention.

---

## 6. Uninstallation & Rollback Phase

### 6.1 Clean MSI Uninstall
Open **Settings > Apps > Installed apps**, locate **SafeBrowse Child Pilot**, and click **Uninstall**.
Or execute from an elevated Command Prompt:
```cmd
msiexec.exe /x "C:\Install\SafeBrowseChild-Pilot.msi" /l*v "C:\Install\safebrowse_uninstall.log"
```

### 6.2 Verify Service Teardown
```cmd
sc.exe query SafeBrowseChildService
```
*Expected Result:* `[SC] EnumQueryServicesStatus:OpenService FAILED 1060: The specified service does not exist as an installed service.`

### 6.3 Verify DNS Settings Restored
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4
```
*Expected Result:*
- Adapters are no longer pointing to `127.0.0.1`.
- Original DHCP or static DNS configuration from Pre-Install has been restored.

### 6.4 Verify Normal Browsing Restored
```cmd
nslookup google.com
```
*Expected Result:* Resolves via standard ISP/DHCP DNS server. All standard internet access is restored.

### 6.5 Verify Firewall Rules Cleaned Up
```cmd
netsh advfirewall firewall show rule name="SafeBrowse_Block_DoT_853_TCP"
netsh advfirewall firewall show rule name="SafeBrowse_Block_DoH_Bootstrap"
```
*Expected Result:* `No rules match the specified criteria.`

---

## 7. Emergency Manual Recovery Command

If an unexpected crash occurs during manual testing, execute the standalone emergency restore utility at any time:
```cmd
"C:\Program Files\SafeBrowse\SafeBrowse-EmergencyRestore.cmd"
```
Or via PowerShell:
```powershell
Get-NetAdapter | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }
Clear-DnsClientCache
```
This guarantees immediate restoration of standard Internet connectivity.

---

## 8. Run #20 Physical Validation Closure Addendum (2026-09-24)

**Status:** `PHYSICALLY VALIDATED — RUN #20 COMPLETE (PILOT PASS)`
**Validated Commit:** `256e4863835e4ffbb8cd599f6f560db0c9f58f65`
**CI Workflow:** `Windows MSI Pilot Packaging` (Run #20, ID: `35578114690`)
**Artifact ID:** `10629450446` (`SafeBrowseChild-Pilot-MSI`)

### Authoritative Run #20 SHA-256 Hashes
- `SafeBrowseChild-Pilot.exe`: `1e00ac2ba5327385edfede5acda38edc440e0bf0e5e3f1b8d59b179c4429d003`
- `SafeBrowseServiceHost.exe`: `510eacd3d42ba148f061a4fb51d55ceb65753262876b53f87574bef3eb8e35c2`
- `SafeBrowseChild-Pilot.msi`: `6ea50223a374f79d1be06f10a22fabb4025d904e9716a8a31ab9ae07f1547a27`

### 16/16 Verification Items: All PASS
1. SCM automatic recovery configuration (`sc.exe qfailure` confirms RESTART actions)
2. Hard ServiceHost crash recovery cycle #1 (auto-restart in ~5s)
3. Hard ServiceHost crash recovery cycle #2 (auto-restart in ~5s)
4. Hard ServiceHost crash recovery cycle #3 (auto-restart in ~5s)
5. Job Object / orphan child cleanup (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
6. No duplicate SafeBrowse processes (exactly 1 host, 1 child at all times)
7. UDP 127.0.0.1:53 ownership recovery (freed immediately, re-bound cleanly)
8. Truthful Degraded status when service is stopped (`sc.exe query` verification)
9. Safe DNS fail-open (zero trapped DNS states during crash)
10. Automatic DNS re-protection (reconciliation restores 127.0.0.1 within 3s)
11. Backend outage with cached policy (`OFFLINE_BACKEND_CACHED_POLICY`)
12. Backend automatic recovery (seamless reconnect and policy delta sync)
13. Controlled Windows reboot recovery (`Delayed-Auto` start confirmed)
14. Wi-Fi -> mobile hotspot -> Wi-Fi roaming (reconciliation re-binds adapter)
15. Modern Standby / Sleep -> Wake (persists across sleep/resume)
16. Internet availability throughout applicable fail-open scenarios (browsing preserved)

### Final Healthy State Baseline
- `SafeBrowseChildService` : `RUNNING`
- Process Tree            : 1 `SafeBrowseServiceHost`, 1 `SafeBrowseChild-Pilot`
- UDP `127.0.0.1:53`      : Owned by child process
- Wi-Fi DNS              : `127.0.0.1` (Local Resolver HEALTHY)
- Parent Status          : `Protected`
- Internet Access        : Fully Functional

### Physical Resolution of Prior Defects
- **P0-A (SCM Recovery Actions):** **PHYSICALLY RESOLVED**
- **P0-B (Orphan Process on Port 53):** **PHYSICALLY RESOLVED**
- **P0-C (Misleading "Protected" Status):** **PHYSICALLY RESOLVED**

### Remaining Release-Hardening & GA Blockers
> [!WARNING]
> **PILOT PASS — NOT GA READY**: Commercial release requires completing:
> 1. Windows executable and MSI Authenticode code signing.
> 2. Secure silent background auto-updater.
> 3. Production HTTPS backend and public endpoint replacing pilot Tailscale endpoint.
> 4. Windows multi-user and Fast User Switching validation.
> 5. Android production signing and physical validation.
> 6. Dependency and security hardening (SBOM, vulnerability audit).
> 7. Final Release Candidate validation soak test.
