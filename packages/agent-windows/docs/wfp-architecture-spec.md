# SafeBrowse Windows Filtering Platform (WFP) Architecture Specification

## 1. Overview
The Windows user-space DNS proxy approach requires adapter-level DNS modification and is vulnerable to browser-level DNS-over-HTTPS (DoH) and process termination. For production deployment, SafeBrowse will implement a **Windows Filtering Platform (WFP)** callout driver and user-mode background service (`SafeBrowseEngine.exe`).

---

## 2. WFP Layer Callout Design

```mermaid
graph TD
    UserApp["Browser / App (Chrome, Edge, Firefox)"] -->|Outbound Connect| WFP["Windows Filtering Platform (Kernel Callout)"]
    
    subgraph "Kernel WFP Filtering Layers"
        WFP -->|Layer: FWPM_LAYER_ALE_AUTH_CONNECT_V4 / V6| InterceptConn["Inspect Target Port & Protocol"]
        WFP -->|Layer: FWPM_LAYER_DATAGRAM_DATA_V4 / V6| InspectDNS["Inspect UDP/TCP Port 53 Payloads"]
    end

    InspectDNS -->|Extract FQDN| SharedEngine["Shared Policy Evaluator (policy.json cache)"]
    SharedEngine -->|BLOCK| SyntheticNX["Synthesize NXDOMAIN In-Kernel or Drop Connection"]
    SharedEngine -->|ALLOW| PermitPacket["FWP_ACTION_PERMIT Upstream"]
    
    InterceptConn -->|Target: Port 853 (DoT)| BlockDoT["FWP_ACTION_BLOCK (Prevent Encrypted Bypass)"]
    InterceptConn -->|Target: Known DoH IPs:443| BlockDoH["FWP_ACTION_BLOCK (Forces Standard DNS)"]
```

---

## 3. Key Technical Advantages of WFP Callout
1. **Zero-Configuration DNS:** Transparently intercepts all outbound UDP/TCP port 53 traffic without requiring adapter IP modification.
2. **DoH/DoT Mitigation:** Blocks outbound traffic to port 853 and known DoH resolvers (Cloudflare, Google, NextDNS), forcing browsers to fall back to the system DNS path.
3. **SNI (Server Name Indication) Filtering:** Can inspect TLS ClientHello SNI on port 443 directly at `FWPM_LAYER_STREAM_V4` to enforce domain blocking even if IP was cached.
4. **Tamper Resistance:** Runs as a protected Windows Service (`SERVICE_SID_TYPE_RESTRICTED`) and kernel driver that non-admin child accounts cannot kill.
