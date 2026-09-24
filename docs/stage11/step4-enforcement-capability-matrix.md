# SafeBrowse Stage 11 Step 4: Enforcement Capability Matrix

**Status:** `WINDOWS PILOT VALIDATED (RUN #20 COMPLETE — PILOT PASS) — AWAITING RELEASE HARDENING (NOT GA)`
**Evaluation Standard:** Truthful, Unembellished Native Protocol & OS Assessment
**Android Architecture:** DNS-only Local TUN Interception via `VpnService`
**Windows Architecture:** Local UDP DNS Proxy (`127.0.0.1:53`) + ServiceHost SCM Supervision + Windows Job Objects
**Validation Date:** 2026-09-24 (Windows Run #20 Physical Closure)

---

## 1. 21-Point Capability Matrix

| # | Capability Name | Android Native Status | Windows Native Status | Architecture & Enforcement Mechanism |
|---|---|---|---|---|
| **1** | **Website / Domain Blocking** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | **Android**: Resolves blocked domains to `127.0.0.1` sinkhole via TUN.<br>**Windows**: DNS filter proxy returns synthetic `NXDOMAIN` (RCODE 3). |
| **2** | **Multi-Browser Coverage** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Universal OS-level DNS interception applies equally to Chrome, Edge, Firefox, Brave, and Opera. |
| **3** | **HTTPS Handling & SNI Inspection** | `PARTIALLY IMPLEMENTED` | `PARTIALLY IMPLEMENTED` | Handled via pre-connection DNS sinkholing; deep HTTPS SNI payload parsing is DNS-bound (no TLS MITM certificate installation required). |
| **4** | **Subdomain & Wildcard Matching** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Hierarchical label matching (`*.badsite.com` matches `m.badsite.com`, `api.badsite.com`). |
| **5** | **DNS Port 53 Interception** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | **Android**: `VpnService.Builder.addDnsServer("10.240.0.2")` routes port 53 to local TUN.<br>**Windows**: Adapter DNS set strictly to `127.0.0.1`. |
| **6** | **Browser DoH Evasion Prevention** | `PARTIALLY IMPLEMENTED` | `PARTIALLY IMPLEMENTED` | Known public DoH bootstrap hostnames (`cloudflare-dns.com`, `dns.google`, `dns.quad9.net`) and bootstrap IPs are sinkholed to force standard DNS fallback. Unlisted custom DoH endpoints require firewall IP block rules. |
| **7** | **Private DNS / DoT (Port 853)** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | **Android**: Outbound TCP/UDP 853 packets dropped in `SafeBrowseVpnService`, triggering OS fallback.<br>**Windows**: Windows Firewall outbound block rule for port 853. |
| **8** | **Custom / Alternate DNS Prevention** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Intercepts all port 53 UDP packets system-wide regardless of destination server address. |
| **9** | **Native App Blocking** | `NOT IMPLEMENTED` | `NOT IMPLEMENTED` | Pilot release is DNS-only filtering. OS-level process killing / UID packet dropping requires Android Device Owner mode / Windows AppLocker and is not in pilot scope. |
| **10** | **Screen Time / Daily Limits** | `PARTIALLY IMPLEMENTED` | `PARTIALLY IMPLEMENTED` | Tracked via backend usage event reporting; hard OS screen lock requires Device Owner on Android / Windows Family Safety API. |
| **11** | **Internet Pause (Level 1 Override)** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Immediate top-precedence evaluation: non-whitelisted DNS lookups immediately return NXDOMAIN. |
| **12** | **Bedtime Window Enforcement** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Local schedule evaluation based on child timezone; blocks traffic outside allowable hours. |
| **13** | **Study Mode (Educational Allowlist)** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Restricts queries exclusively to approved educational domains (e.g. `wikipedia.org`, `khanacademy.org`). |
| **14** | **Ask Parent Access Request Flow** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Child submits domain access request; parent receives dashboard alert to approve. |
| **15** | **Temporary Grant Auto-Expiry** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Local monotonic timer expires temporary grants automatically upon deadline lapse. |
| **16** | **SafeSearch & YouTube Restricted VIP** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | DNS proxy synthesizes CNAME/A records pointing to `forcesafesearch.google.com` and `restrictmoderate.youtube.com`. |
| **17** | **Offline Policy Enforcement** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | Signed local policy cache evaluated offline; fail-closed default if cache is unreadable. |
| **18** | **Reboot Auto-Restart Persistence** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | **Android**: `BootReceiver` on `BOOT_COMPLETED`.<br>**Windows**: Windows Service with `delayed-auto` startup under `NT AUTHORITY\SYSTEM` + boot pre-flight stale DNS recovery. |
| **19** | **Tamper-Resistance / Crash Recovery** | `PARTIALLY IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | **Android**: Foreground service with ongoing notification.<br>**Windows**: SCM automatic recovery (RESTART on 1st/2nd/3rd failures with 5s delay), Job Object child lifetime binding (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), parent watchdog (`SAFEBROWSE_PARENT_PID`), and stale instance cleanup. |
| **20** | **Raw Direct-IP Browsing Blocking** | `NOT IMPLEMENTED` | `NOT IMPLEMENTED` | DNS-only release does not inspect non-DNS raw IP sockets during normal mode. |
| **21** | **Device Credential Protection** | `IMPLEMENTED` | `PHYSICALLY VERIFIED (RUN #20)` | **Android**: Android Keystore / EncryptedSharedPreferences.<br>**Windows**: Windows DPAPI machine/user scope encryption. |

---

## 2. Capability Status Legend
- **`IMPLEMENTED`**: Fully coded in native agent repository, compiled into genuine binaries, and verified via automated integration suites.
- **`PARTIALLY IMPLEMENTED`**: Functional within architectural boundaries (e.g., DNS-only scope) with documented limitations.
- **`NOT IMPLEMENTED`**: Out of scope for DNS-only pilot; accurately excluded from claims.
- **`PHYSICALLY VERIFIED (RUN #20)`**: Confirmed on physical hardware in Run #20 (16/16 tests PASS; P0-A, P0-B, and P0-C resolved).

---

## 3. Physical Defect Resolution Summary (Run #20)
- **P0-A (SCM Recovery Configuration):** **PHYSICALLY RESOLVED** (`sc.exe failure` and WiX `<util:ServiceConfig>` restart recovery).
- **P0-B (Orphan Process on Port 53 Surviving Crash):** **PHYSICALLY RESOLVED** (Job Object `KILL_ON_JOB_CLOSE` + watchdog + stale cleanup).
- **P0-C (Misleading "Protected" Status When Service Stopped):** **PHYSICALLY RESOLVED** (`evaluateSystemStatus()` SCM state query).

---

## 4. Remaining Release-Hardening & GA Blockers
> [!WARNING]
> **PILOT PASS — NOT GA READY**: Commercial release requires completing:
> 1. Windows executable and MSI Authenticode code signing.
> 2. Secure silent background auto-updater.
> 3. Production HTTPS backend and public endpoint replacing pilot Tailscale endpoint.
> 4. Windows multi-user and Fast User Switching validation.
> 5. Android production signing and physical validation.
> 6. Dependency and security hardening (SBOM, vulnerability audit).
> 7. Final Release Candidate validation soak test.
