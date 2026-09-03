# SafeBrowse Stage 11 Step 4: Adversarial Bypass Probe Results

**Status:** `IMPLEMENTED — AWAITING PHYSICAL VALIDATION`  
**Test Suite:** Automated Network Stack & Service Integrity Probes (`scripts/device-enforcement-probe/`)  
**Scope:** DNS-only Local Enforcement Architecture  

---

## 1. Adversarial Bypass Probe Findings

| Bypass Vector | Target Layer | Automated Probe Status | Technical Mechanism & Defense Explanation |
|---|---|---|---|
| **1. Direct Alternate DNS (e.g. 8.8.8.8:53)** | DNS Port 53 | `BLOCKED` | **Android**: TUN virtual interface intercepts all UDP/TCP 53 traffic system-wide.<br>**Windows**: Outbound DNS queries redirected to `127.0.0.1:53`. |
| **2. Android Private DNS (DoT Port 853)** | Encrypted DNS | `BLOCKED` | Android `SafeBrowseVpnService` drops TCP/UDP 853 packets, triggering Android OS to fall back to the VPN local DNS server. |
| **3. Windows DNS-over-TLS (DoT 853)** | Encrypted DNS | `BLOCKED` | Windows Firewall outbound rule drops remote port 853 connections. |
| **4. Known Browser DoH Resolvers** | Encrypted DNS | `PARTIALLY BLOCKED` | Hostnames (`cloudflare-dns.com`, `dns.google`, `dns.quad9.net`) and bootstrap IPs are sinkholed to force browsers back to standard DNS. Custom unlisted DoH endpoints are not blocked without comprehensive IP reputation lists. |
| **5. Direct Raw IP Browsing** | Network Transport | `NOT IMPLEMENTED` | DNS-only architecture does not block raw IP connections (e.g. `http://93.184.216.34`) in normal mode. |
| **6. Native Application Blocking** | Process Execution | `NOT IMPLEMENTED` | Native app blocking (e.g., launching TikTok app directly) requires Device Owner / AppLocker policies and is excluded from DNS-only pilot scope. |
| **7. Multi-Browser (Chrome/Edge/Firefox)** | Application Layer | `BLOCKED` | Standard OS DNS routing applies to all desktop and mobile browsers. |
| **8. Incognito / Private Browsing** | Local State | `BLOCKED` | Browser private browsing uses the operating system network stack; DNS policies apply identically. |
| **9. IPv6 Alternate Stack Queries** | Dual Stack | `BLOCKED` | DNS proxy returns synthetic `::1` or `NXDOMAIN` for AAAA records on blocked domains. |
| **10. Local Hosts File Modification (Windows)** | Host Resolver | `BLOCKED` | Local DNS proxy and network adapter settings resolve before Windows hosts file fallback. |
| **11. Service Termination by Standard User** | Process Control | `BLOCKED` | `SafeBrowseChildService` runs under `NT AUTHORITY\SYSTEM`; standard non-admin users cannot stop the service (`sc.exe stop` denied). |
| **12. VPN Disconnect by Child (Android)** | Android OS | `PARTIALLY BLOCKED` | Android OS permits users to disconnect VPN in system settings unless device is enrolled in Android Enterprise Device Owner (Always-On VPN lockdown) mode. |
| **13. Local Clock Rollback** | Temporal State | `BLOCKED` | Monotonic uptime counters (`elapsedRealtime()`) prevent local clock manipulation from extending access grants. |
| **14. Crash / Reboot During Policy Push** | Atomic Persistence | `BLOCKED` | Policy writes use atomic file replace (`policy.json.tmp` -> `policy.json`); invalid writes roll back to signed cache. |
| **15. Replay of Revoked Device Token** | Token Validation | `BLOCKED` | Revoked device tokens are marked in PostgreSQL (`Device.isRevoked = true`) and return HTTP 401 on synchronization. |

---

## 2. Testing Instructions for Reviewers
Run the automated probe suite via:
```bash
npx ts-node scripts/device-enforcement-probe/dns-bypass-probe.ts
npx ts-node scripts/device-enforcement-probe/tamper-probe.ts
```
Physical confirmation on target hardware should be recorded using [`evidence/stage11-step4/physical-test-checklist.md`](file:///c:/Users/acer/projects/safechild/evidence/stage11-step4/physical-test-checklist.md).
