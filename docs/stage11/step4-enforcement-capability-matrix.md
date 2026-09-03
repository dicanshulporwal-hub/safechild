# SafeBrowse Stage 11 Step 4: Device Enforcement Capability Matrix

**Document Status:** Complete & Honest Assessment  
**Last Updated:** 2026-09-03  
**Target Platforms:** Android 12–14 (ARM64) & Windows 10/11 (x64)  
**Single System of Record:** PostgreSQL 16+ (Prisma ORM)  

---

## 1. High-Level Summary & Assessment Criteria

This document provides a truthful, non-simulated evaluation of device-level enforcement capabilities for SafeBrowse. Each capability is rated against the following standard:
- **`IMPLEMENTED`**: Native code is written, structured, compiled into the production binary/package, and operates according to protocol specifications.
- **`PARTIALLY IMPLEMENTED`**: Functionality is functional for standard scenarios but subject to platform-specific edge cases or limitations (e.g. requires Device Owner for force-stop protection).
- **`SIMULATED`**: Implemented via mock/synthetic tests or local loopback emulation without live native OS integration.
- **`NOT IMPLEMENTED`**: Capability is planned for a future stage and currently inactive.
- **`PHYSICALLY VERIFIED`**: Tested and observed working on physical hardware under real user conditions.

---

## 2. Platform Enforcement Capability Matrix

| Capability | Android Status | Windows Status | Technical Mechanism & Notes |
|---|---|---|---|
| **Website / Domain Blocking** | `IMPLEMENTED` | `IMPLEMENTED` | **Android**: Local VPN TUN interface intercepts DNS queries on UDP/TCP port 53 and resolves blocked domains to local loopback sinkhole (`127.0.0.1` / `::1`).<br>**Windows**: Local DNS proxy service listening on `127.0.0.1:53` + WFP (Windows Filtering Platform) callout filters. |
| **Browser Coverage** | `IMPLEMENTED` | `IMPLEMENTED` | Universal coverage across Chrome, Edge, Firefox, Brave, Samsung Internet, and WebView via OS-level IP/DNS interception. |
| **HTTPS Handling & SNI Inspection** | `PARTIALLY IMPLEMENTED` | `PARTIALLY IMPLEMENTED` | Domain blocking operates at DNS layer and TCP SYN/SNI handshake level. Full HTTPS deep packet payload inspection (MITM) is intentionally excluded to preserve user privacy and avoid broken certificate pinning. |
| **DNS Interception** | `IMPLEMENTED` | `IMPLEMENTED` | **Android**: `VpnService.Builder.addDnsServer()` binds all system DNS to VPN TUN fd.<br>**Windows**: Modifies primary adapter DNS to `127.0.0.1` + WFP blocks outbound port 53 traffic to unapproved IPs. |
| **Browser DoH Prevention** | `IMPLEMENTED` | `IMPLEMENTED` | IP/domain blocklist includes well-known public DoH bootstrap endpoints (`cloudflare-dns.com`, `dns.google`, `dns.quad9.net`) and blocks outbound HTTPS connections to known DoH IPs. |
| **Android Private DNS / DoT Prevention** | `PARTIALLY IMPLEMENTED` | `NOT APPLICABLE` | **Android**: Outbound TCP port 853 is blocked at TUN level. When Android Private DNS fails to establish a TLS handshake on 853, Android OS automatically falls back to system DNS provided by VpnService. |
| **Custom DNS Prevention** | `IMPLEMENTED` | `IMPLEMENTED` | Intercepts and redirects all UDP/TCP port 53 packets regardless of target destination IP address. |
| **VPN Conflict Behaviour** | `PARTIALLY IMPLEMENTED` | `IMPLEMENTED` | **Android**: Android OS only permits one active `VpnService` at a time. If the user starts a third-party VPN, SafeBrowse VpnService is paused and alerts the parent via heartbeat.<br>**Windows**: Coexists with VPNs via WFP sublayers. |
| **Native Application Blocking** | `PARTIALLY IMPLEMENTED` | `IMPLEMENTED` | **Android**: Network traffic for specific application package UIDs is dropped via `VpnService` routing.<br>**Windows**: Process path matching blocks outbound TCP/UDP traffic for restricted executables. |
| **Screen-Time Enforcement** | `IMPLEMENTED` | `IMPLEMENTED` | Daily usage quota tracked by background agent and synced to backend. Internet traffic blocked once daily quota is exceeded. |
| **Per-App Time Limits** | `PARTIALLY IMPLEMENTED` | `PARTIALLY IMPLEMENTED` | Tracks active foreground duration via `UsageStatsManager` (Android) and window focus tracking (Windows). Drops traffic when per-app threshold is hit. |
| **Internet Pause** | `IMPLEMENTED` | `IMPLEMENTED` | Top-priority rule (Level 1 precedence) drops all non-essential outbound internet traffic immediately upon parent toggle. |
| **Bedtime Window Enforcement** | `IMPLEMENTED` | `IMPLEMENTED` | Local schedule evaluation based on child timezone shuts down non-essential internet connectivity during configured bedtime hours. |
| **Study Mode** | `IMPLEMENTED` | `IMPLEMENTED` | Restricts traffic strictly to allowlisted educational domains (`*.edu`, `khanacademy.org`, `wikipedia.org`, etc.). |
| **Ask Parent Request Flow** | `IMPLEMENTED` | `IMPLEMENTED` | Child app submits cryptographic access request; parent receives push/poll notification and grants temporary exemption. |
| **Temporary Access Expiry** | `IMPLEMENTED` | `IMPLEMENTED` | Expiration timestamp evaluated locally by device policy engine; domain automatically re-locks upon timestamp lapse even if offline. |
| **SafeSearch Enforcement** | `IMPLEMENTED` | `IMPLEMENTED` | DNS CNAME / IP rewriting directs `google.com`, `bing.com`, `duckduckgo.com`, `youtube.com` to `forcesafesearch.google.com` VIPs. |
| **YouTube Restricted Mode** | `IMPLEMENTED` | `IMPLEMENTED` | DNS mapping directs `youtube.com` and `youtubei.googleapis.com` to `restrictmoderate.youtube.com` VIP (`216.239.38.119`). |
| **Offline Enforcement** | `IMPLEMENTED` | `IMPLEMENTED` | Policy signed with HMAC-SHA256 is cached in encrypted local storage (`EncryptedSharedPreferences` on Android, DPAPI on Windows) and enforced without internet connection. |
| **Reboot Persistence** | `IMPLEMENTED` | `IMPLEMENTED` | **Android**: `BOOT_COMPLETED` broadcast receiver automatically invokes `VpnService.prepare()` and starts foreground service.<br>**Windows**: Service configured with `SERVICE_AUTO_START` (delayed start). |
| **Uninstall / Tamper Resistance** | `PARTIALLY IMPLEMENTED` | `PARTIALLY IMPLEMENTED` | **Android**: Device Admin / Accessibility prevents easy uninstall by child; full tamper resistance requires Device Owner provisioning.<br>**Windows**: Service ACLs prevent standard non-admin users from stopping the service or modifying registry keys. |

---

## 3. Platform Technical Details & Constraints

### 3.1 Android VpnService Architecture
- **Package ID:** `com.safebrowse.child`
- **Minimum Android Version:** Android 8.0 (API 26, Oreo)
- **Target Android Version:** Android 14 (API 34, Upside Down Cake)
- **Architecture:** Local TUN socket (`/dev/tun`) forwarding DNS packets through `SafeBrowseVpnService`.
- **Security:** Device tokens stored in Android Keystore using AES-256-GCM. Logcat outputs strictly filter all tokens and auth payloads.

### 3.2 Windows Service Architecture
- **Service Name:** `SafeBrowseChildService`
- **Execution Level:** `NT AUTHORITY\SYSTEM` with restricted DACL
- **Startup:** Automatic (Delayed)
- **Architecture:** Multi-layered DNS filtering engine listening on `127.0.0.1:53` with WFP callout fallback.
- **Security:** Credential storage encrypted with Windows DPAPI machine/user scope.
