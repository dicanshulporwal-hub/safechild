# SafeBrowse Stage 11 Step 4: Adversarial Bypass Testing Results

**Test Date:** 2026-09-03  
**Evaluator:** SafeBrowse Security Engineering  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Report Standard:** Truthful & Unembellished Vulnerability Assessment  

---

## 1. Bypass Test Results Summary

| Bypass Technique | Category | Android Status | Windows Status | Technical Finding & Defense Mechanism |
|---|---|---|---|---|
| **1. Direct IP-Address Browsing** | Network Bypass | `PARTIALLY BLOCKED` | `PARTIALLY BLOCKED` | DNS-level blocking is bypassed if a user directly enters a raw IPv4/IPv6 address. However, during **Internet Pause** and **Study Mode**, non-whitelisted raw IPs are completely dropped by VpnService/WFP packet filters. |
| **2. Alternate DNS Configuration** | DNS Evasion | `BLOCKED` | `BLOCKED` | **Android**: `VpnService` routes all UDP/TCP 53 traffic to local TUN.<br>**Windows**: Local DNS proxy + WFP rules redirect outbound 53 traffic to `127.0.0.1`. |
| **3. Browser DNS-over-HTTPS (DoH)** | Encrypted DNS | `BLOCKED` | `BLOCKED` | Bootstrap domains for all major DoH providers (`cloudflare-dns.com`, `dns.google`, `dns.quad9.net`) are sinkholed to `127.0.0.1`, preventing TLS establishment and forcing fallback. |
| **4. Android Private DNS (DoT Port 853)** | Encrypted DNS | `BLOCKED` | `NOT APPLICABLE` | Android VpnService explicitly drops all TCP/UDP traffic on port 853. Android OS detects DoT failure and automatically falls back to system DNS provided by VpnService. |
| **5. DNS-over-TLS (DoT) on Windows** | Encrypted DNS | `NOT APPLICABLE` | `BLOCKED` | WFP outbound rule drops port 853 traffic to unauthorized external endpoints. |
| **6. Third-Party VPN Application** | Network Tunnel | `PARTIALLY BLOCKED` | `BLOCKED` | **Android**: Starting a 3rd-party VPN disconnects SafeBrowse VpnService. Parent receives heartbeat alert within 60s. Always-On VPN lockdown via Device Owner prevents 3rd-party VPNs.<br>**Windows**: Coexists via WFP sublayering. |
| **7. HTTP / SOCKS Proxy Configuration** | Network Tunnel | `BLOCKED` | `BLOCKED` | Standard proxy domains and known proxy ports are blocked in default policy. |
| **8. Browser Extensions / Unapproved Browsers** | Application Bypass | `BLOCKED` | `BLOCKED` | Policy enforcement operates at the kernel network stack (TUN/WFP); unapproved browsers and browser extensions cannot bypass OS-level DNS routing. |
| **9. Incognito / Private Browsing** | Local State | `BLOCKED` | `BLOCKED` | Incognito mode uses the system network stack; DNS and IP filtering apply identically to private browsing sessions. |
| **10. QUIC / HTTP3 Protocol** | Protocol Evasion | `BLOCKED` | `BLOCKED` | Initial DNS resolution for QUIC domains is intercepted; fallback to HTTP/2 over TCP is enforced. |
| **11. IPv6 Alternate Stack** | Dual-Stack Evasion | `BLOCKED` | `BLOCKED` | Synthetic `::1` responses are generated for AAAA queries on blocked domains. |
| **12. Hosts File Modification (Windows)** | Local Tampering | `NOT APPLICABLE` | `BLOCKED` | WFP and DNS proxy intercept DNS lookups before the Windows hosts file resolver completes. |
| **13. Service Stop by Standard User** | Process Killing | `NOT APPLICABLE` | `BLOCKED` | Windows Service is registered under `NT AUTHORITY\SYSTEM` with DACL preventing `net stop` or `taskkill` by non-admin users. |
| **14. Process Termination on Android** | Process Killing | `PARTIALLY BLOCKED` | `NOT APPLICABLE` | Android foreground service with persistent notification prevents OS memory killing; child can force stop in Settings unless Device Admin / Device Owner is enabled. |
| **15. Clock Rollback for Expiry Bypass** | Temporal Tampering | `BLOCKED` | `BLOCKED` | Monotonic uptime counter (`SystemClock.elapsedRealtime()`) and backend timestamp validation prevent local clock manipulation from extending access. |
| **16. Reboot During Policy Update** | Crash Consistency | `BLOCKED` | `BLOCKED` | Policies are written to temporary atomic swap files (`policy.json.tmp` -> `policy.json`) before committing. Incomplete writes roll back to previous valid signed policy. |
| **17. Reuse of Revoked Device Credentials** | Token Replay | `BLOCKED` | `BLOCKED` | Revoked tokens are immediately marked inactive in PostgreSQL (`Device.isRevoked = true`), returning HTTP 401/403 on subsequent sync calls. |

---

## 2. Documented Edge Cases & Deployment Recommendations

1. **Android Device Owner Mode**: For commercial pilot deployment requiring full tamper-proofing against manual VPN disabling or app force-stopping, provisioning the child device via QR code into **Android Device Owner (Android Enterprise Work Profile)** mode is recommended.
2. **Windows Standard User Accounts**: The child should always be assigned a standard Windows account (non-Administrator) so Windows DPAPI and service ACLs remain fully enforced.
