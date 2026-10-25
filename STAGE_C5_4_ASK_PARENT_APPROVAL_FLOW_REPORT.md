# SafeBrowse Stage C.5.4: Ask Parent Approval Scope & Continuation Report

**Date:** 2026-10-24  
**Classification:** **`READY FOR C5.4 ASK-PARENT APPROVAL PHYSICAL VALIDATION`**  
*(Strict Notice: DO NOT classify as Pilot Ready until Cloud VM2 deployment, production migration reconciliation, and clean physical laptop validation succeed.)*  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Git Baseline Commit:** `276741b476f7d46f57d061f33a0692e9404e3180`  
**Git Source Commit (HEAD):** `4c0ee6d3f46e6c522691ebfbc3f3a67df52b0d88`  
**GitHub Actions Build Run:** [#40105310946](https://github.com/dicanshulporwal-hub/safechild/actions/runs/40105310946) (SUCCESS)  
**Candidate Version:** `1.0.4-validation`  
**Windows Protocol Version:** `3`  
**Windows MSI ProductVersion:** `1.0.4.11`  
**Android Release versionCode:** `5` (versionName `1.0.4-validation`)  
**Production Backend URL:** `https://safebrowse.porwal.online`  

---

## 1. Executive Summary & Physical Defect Resolution

During physical validation of Stage C.5.3 on the Windows laptop under Fast User Switching:
- Block presentation, named-pipe DACL, helper session targeting, Ask Parent delivery, Parent Portal visibility, parent approval, and policy synchronization were all verified working.
- **Physical Defect:** When the parent approved the request, the approval was recorded as:
  `ncs.roblox.com TEMPORARY_ALLOW`
  while the blocking rule in the policy remained:
  `roblox.com BLOCK`
- Consequently:
  `Resolve-DnsName ncs.roblox.com -Server 127.0.0.1` resolved successfully.
  However, `Resolve-DnsName www.roblox.com -Server 127.0.0.1` still returned `NXDOMAIN`.
- In addition, the child had to manually run `Clear-DnsClientCache` in PowerShell to flush stale DNS records, and the local block page remained open indefinitely even after approval.

### Root Cause Analysis
1. **Approval Scope Discarded in Evaluator Callback:**  
   `DnsFilterProxy` evaluated incoming DNS queries using `evaluatePolicy(policy, domain)`. For `ncs.roblox.com` blocked by rule `roblox.com`, the evaluator returned `result.matchedDomain = 'roblox.com'`. However, `DnsFilterProxy` discarded `matchedDomain` and passed only the raw DNS hostname (`ncs.roblox.com`) to `onBlockExperienceTriggered(domain, reason)`. The child then submitted an approval request for the incidental service hostname rather than the parent rule scope (`roblox.com`).
2. **Subdomain Fanout Experience Redundancy:**  
   Opening complex web applications like Roblox causes the browser to issue parallel DNS queries (`www.roblox.com`, `auth.roblox.com`, `ncs.roblox.com`, `realtime.roblox.com`). Because debouncing was previously keyed solely on the raw queried hostname, opening the application generated multiple block events for different subdomains of the same rule.
3. **Manual DNS Cache Flush Dependency:**  
   When the cloud broadcast `ACCESS_REQUEST_RESOLVED` and the Windows service updated the child's policy cache, Windows OS DNS client cache (`DnsCache`) retained cached negative (`NXDOMAIN`) entries until TTL expired or until a user manually executed `Clear-DnsClientCache`.
4. **Indefinite Block Page Staleness:**  
   `BlockPageServer` previously discarded the backend request response body on `/submit-request`, returning only `{ success: true }`. The client block page had no polling mechanism or awareness of approval events, leaving the child stuck on the block screen indefinitely.

### Resolution Summary
Stage C.5.4 corrects the approval flow from end to end:
1. **Authoritative Approval Scope (`BlockExperienceContext`):**  
   `DnsFilterProxy` creates a structured `BlockExperienceContext` where `approvalDomain` is set to `result.matchedDomain` (e.g. `roblox.com`) whenever available, falling back to `requestedDomain` for category or curfew blocks.
2. **Logical Scope Debouncing:**  
   `BlockIpcServer` debounces block presentations based on `approvalDomain`. Simultaneous queries for `www.roblox.com`, `auth.roblox.com`, `ncs.roblox.com`, and `realtime.roblox.com` trigger exactly **one** block experience.
3. **Child-Friendly Approval Display & Request Submission:**  
   The block page prominently displays `roblox.com` (with technical host `ncs.roblox.com` shown only as a subtle diagnostic detail). The request sent to `POST /api/requests` specifies `domain: roblox.com`.
4. **Resolution Tracking & Resilient Active-Policy Fallback:**  
   `/submit-request` returns `{ success: true, requestId, domain }`. `BlockPageServer` tracks requests in a bounded resolution map. `PolicySyncClient.setOnAccessRequestResolved` dispatches resolution events for both `APPROVED` and `DENIED`. Local `GET /request-status?id=...&domain=...` checks the resolution map and directly evaluates the active policy, ensuring immediate continuation even if the WebSocket event was missed.
5. **Zero-PowerShell Automatic DNS Cache Flush:**  
   Upon receiving `ACCESS_REQUEST_RESOLVED` with `status === 'APPROVED'`, the service automatically executes `await networkManager.flushDnsCache()`, clearing Windows resolver cache without user intervention.
6. **Smooth Post-Approval Continuation UX:**  
   After clicking "Send Request", the button disables to prevent duplicate submissions. The page displays "Request sent to your parent. Waiting for approval..." and polls `/request-status` locally every 1.5 seconds. Once approved, the card updates to "Approved by your parent (Access: 15 minutes)", offers a "Continue to website" button, and auto-redirects after 1.5 seconds to `https://roblox.com`.

---

## 2. Technical Architecture & Approval Flow

```
+----------------------------------------------------------------------------------------------------+
|                                    WINDOWS SERVICE (Session 0)                                     |
|                                                                                                    |
|  DnsFilterProxy                                                                                    |
|    +-- Query: ncs.roblox.com                                                                       |
|    +-- evaluatePolicy(policy, 'ncs.roblox.com') -> BLOCK, matchedDomain: 'roblox.com'             |
|    +-- BlockExperienceContext:                                                                     |
|          requestedDomain: 'ncs.roblox.com'                                                         |
|          approvalDomain:  'roblox.com'                                                             |
|          reason:          'EXPLICIT_BLOCK'                                                         |
|                                                                                                    |
|  BlockIpcServer                                                                                    |
|    +-- Debounce Key: 'roblox.com' (suppresses fanout for www, auth, realtime)                       |
|    +-- Safe Block Landing URL:                                                                     |
|          http://127.0.0.1:8880/blocked?domain=ncs.roblox.com&approvalDomain=roblox.com&reason=... |
|    +-- PRESENT_BLOCK sent to active Session 5 SafeBrowseUserHelper                                 |
+----------------------------------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------------------------------+
|                               ACTIVE CONSOLE (Session 5: Child)                                    |
|                                                                                                    |
|  Browser loads: http://127.0.0.1:8880/blocked?domain=ncs.roblox.com&approvalDomain=roblox.com    |
|    +-- Displays: "This site is blocked: roblox.com" (Requested: ncs.roblox.com)                    |
|    +-- Child clicks "Ask Parent" -> "Send Request"                                                 |
|    +-- POST /submit-request { domain: 'roblox.com' } -> returns { success: true, requestId: '...' } |
|    +-- Button disables ("Sending..."). Page shows: "Waiting for parent approval..."                 |
|    +-- Local polling: GET /request-status?id=...&domain=roblox.com every 1.5s                      |
+----------------------------------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------------------------------+
|                                       CLOUD & PARENT PORTAL                                        |
|                                                                                                    |
|  POST /api/requests -> Creates AccessRequest { domain: 'roblox.com', childId: '...' }              |
|  Parent Portal displays request: "roblox.com" (NOT "ncs.roblox.com")                               |
|  Parent clicks "Approve for 15 minutes"                                                            |
|  Backend broadcasts ACCESS_REQUEST_RESOLVED:                                                       |
|    request: { id: '...', status: 'APPROVED', domain: 'roblox.com', duration: 15 }                  |
|    policy:  { rules: [ { domain: 'roblox.com', action: 'TEMPORARY_ALLOW', expiresAt: ... }, ... ] }|
+----------------------------------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------------------------------+
|                                    WINDOWS SERVICE (Session 0)                                     |
|                                                                                                    |
|  PolicySyncClient: ACCESS_REQUEST_RESOLVED received                                                |
|    +-- Updates active child policy cache: roblox.com TEMPORARY_ALLOW + roblox.com BLOCK            |
|    +-- Fires onAccessRequestResolved callback                                                      |
|    +-- BlockPageServer updates resolutionMap: reqId -> APPROVED                                    |
|    +-- AUTOMATIC DNS CACHE FLUSH: await networkManager.flushDnsCache()                             |
|        Log: [AskParent] Approval policy applied for 'roblox.com'; DNS cache flushed.               |
+----------------------------------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------------------------------+
|                               ACTIVE CONSOLE (Session 5: Child)                                    |
|                                                                                                    |
|  Browser poll GET /request-status receives { allowed: true, status: 'APPROVED', duration: 15 }    |
|    +-- Polling stops                                                                               |
|    +-- Page immediately changes to:                                                                |
|          "Approved by your parent"                                                                 |
|          "Access is available for: 15 minutes"                                                     |
|          [ Continue to website ]                                                                   |
|    +-- Auto-redirects after 1.5s to safe HTTPS continue URL: https://roblox.com                    |
|    +-- All Roblox subdomains resolve normally without any manual PowerShell intervention           |
+----------------------------------------------------------------------------------------------------+
```

---

## 3. Implementation Details

### 1. `packages/agent-windows/src/dns-proxy.ts`
- Added `BlockExperienceContext` interface:
  ```typescript
  export interface BlockExperienceContext {
    requestedDomain: string;
    approvalDomain: string;
    reason: string;
    matchedDomain?: string;
    matchedRuleType?: string;
  }
  ```
- Updated `DnsFilterProxy.setOnBlockExperienceTriggered` with method overloads supporting both `BlockExperienceContext` and legacy `(domain, reason)` signatures for full backwards compatibility.
- On policy block decision:
  ```typescript
  const normDomain = domain.toLowerCase().replace(/\.+$/, '');
  const approvalDomain = result.matchedDomain
    ? result.matchedDomain.toLowerCase().replace(/\.+$/, '')
    : normDomain;
  const blockContext: BlockExperienceContext = {
    requestedDomain: normDomain,
    approvalDomain,
    reason: result.reason || 'Blocked by family rules',
    matchedDomain: result.matchedDomain,
    matchedRuleType: result.matchedRuleType,
  };
  this._onBlockExperienceTriggered(blockContext);
  ```

### 2. `packages/agent-windows/src/block-ipc.ts`
- Extended `BlockPresentationMessage` and `PendingBlockPresentation` with `requestedDomain` and `approvalDomain` (while preserving legacy `domain = requestedDomain`).
- Updated `presentBlock(target: string | BlockExperienceContext, reason?: string, blockPort: number = 8880)`:
  - Extracts `requestedDomain`, `approvalDomain`, and `finalReason`.
  - Computes `debounceKey = normalizeDomainForDebounce(approvalDomain || requestedDomain)`.
  - Performs debounce check against `debounceKey`.
  - Constructs URL: `http://127.0.0.1:${blockPort}/blocked?domain=${safeReqDomain}&approvalDomain=${safeAppDomain}&reason=${safeReason}`.
  - Updates debounce timestamps for both `debounceKey` and `normalizedReqDomain` when delivered.

### 3. `packages/agent-windows/src/sync-client.ts`
- Added `AccessRequestResolutionEvent`:
  ```typescript
  export interface AccessRequestResolutionEvent {
    requestId?: string;
    status: 'APPROVED' | 'DENIED';
    domain?: string;
    resolvedDuration?: number;
    expiresAt?: string;
    childId?: string;
    policy?: Policy;
  }
  ```
- Added `setOnAccessRequestResolved(cb?: AccessRequestResolvedCallback)`.
- In WebSocket `ACCESS_REQUEST_RESOLVED` handler, always invokes callback for **both** `APPROVED` and `DENIED` events (even when policy is omitted on denial).

### 4. `packages/agent-windows/src/block-server.ts`
- Added in-memory bounded request resolution map (`requestId -> { status, domain, expiresAt, duration, updatedAt }`) with 1-hour TTL and 100-entry max cap.
- Implemented `GET /request-status`:
  - Queries resolution map.
  - Resilience fallback: evaluates current policy directly via `policyProvider` against the requested/approval domain. If policy returns `ALLOW` (via `TEMPORARY_ALLOW`, `EXPLICIT_ALLOW`, or `ESSENTIAL_ALLOW`), reports `allowed: true` and `status: 'APPROVED'` even if the WebSocket event was missed.
- Updated `POST /submit-request`:
  - Parses backend response body to extract `requestId` (`respData.id || respData.requestId`).
  - Records pending request locally.
  - Returns `{ success: true, requestId, domain }` to the client page without exposing secrets.
- Overhauled child-facing HTML & JavaScript:
  - Displays `safeApprovalDomain` as the prominent site title.
  - Shows `Requested: ${safeRequestedDomain}` in subtle secondary text if different.
  - Submits `APPROVAL_DOMAIN` in `/submit-request`.
  - Disables "Send Request" button on submission.
  - Shows animated waiting card and polls `/request-status` every 1.5 seconds.
  - On approval: transitions immediately to green approved card with duration and "Continue to website" button, auto-redirecting to safe HTTPS URL after 1.5 seconds.
  - On denial: transitions to declined state with "Go Back" button.
  - Added `getSafeContinueUrl()` sanitizer that strips wildcards (`*.example.com` -> `https://example.com`) and strictly permits only valid HTTPS hostnames.

### 5. `packages/agent-windows/src/agent-cli.ts`
- Wired `syncClient.setOnAccessRequestResolved`:
  - Delivers event to `blockServer.handleAccessRequestResolved(event)`.
  - On `status === 'APPROVED'`: executes `await networkManager.flushDnsCache()`, logging `[AskParent] Approval policy applied for '${event.domain}'; DNS cache flushed.`.
- Wired `blockServer.setPolicyProvider(() => syncClient?.getActivePolicy() ?? null)`.
- Wired `dnsProxy.setOnBlockExperienceTriggered` to pass `BlockExperienceContext` to `blockIpcServer.presentBlock()`.

---

## 4. Verification Evidence

### 1. GitHub Actions Windows CI Build
- **Run ID:** [40105310946](https://github.com/dicanshulporwal-hub/safechild/actions/runs/40105310946)
- **Workflow:** `.github/workflows/build-windows-msi.yml`
- **Result:** **SUCCESS** (`✓ Completed job in 6m9s`)
- **Key Steps Passed:**
  - `Verify PowerShell Account Discovery Script Syntax (AST Parser Gate)`: PASSED.
  - `Run Windows agent automated tests`: PASSED (All 18 suites passed, including `ask-parent-approval-flow.test.ts` and native Windows named pipe DACL tests).
  - `Compile Windows Service Host Wrapper (SafeBrowseServiceHost.exe)`: PASSED.
  - `Build Single Executable Application (SafeBrowseChild-Pilot.exe)`: PASSED.
  - `Build SafeBrowseChild-Pilot.msi via WiX Toolset`: PASSED (ProductVersion `1.0.4.11`).
  - `Upload SafeBrowse Windows Pilot MSI Artifact`: PASSED.

### 2. Comprehensive Test Suite Results
| Workspace / Suite | Tests Run | Result | Evidence |
| :--- | :--- | :--- | :--- |
| `ask-parent-approval-flow.test.ts` | 8 tests | **PASS (8/8)** | Approval scope, fanout debounce, request ID, approved/denied callbacks, DNS flush, policy fallback, coexistence/expiry, safe continue URL |
| `@safebrowse/agent-windows` | 18 suites | **PASS (391/391)** | 100% pass across all Windows agent integration suites |
| `@safebrowse/backend` | 48 suites | **PASS (264/264)** | Full backend regression suite with PostgreSQL single-source-of-truth pass |
| `@safebrowse/shared` | 2 suites | **PASS (12/12)** | Policy precedence and pairing code helpers pass |
| `@safebrowse/protocol` | Contracts | **PASS** | Contracts verified |
| `@safebrowse/parent-web` | Production Build | **PASS** | Vite production build succeeded in 11.25s |

### 3. Detailed Physical Acceptance Test Assertions (Verified via `ask-parent-approval-flow.test.ts`)
- **ncs.roblox.com blocked by roblox.com:** `evaluatePolicy` returned `BLOCK` with `matchedDomain = 'roblox.com'`. `BlockExperienceContext.approvalDomain` asserted as `'roblox.com'`.
- **Approval request created for roblox.com:** Mock backend verified receiving `POST /api/requests` with `domain: 'roblox.com'` (NOT `'ncs.roblox.com'`).
- **Parent approval produces coexistence:** Evaluated `roblox.com TEMPORARY_ALLOW` alongside existing `roblox.com BLOCK`. During 15-minute grant, `roblox.com`, `www.roblox.com`, `auth.roblox.com`, `ncs.roblox.com`, and `realtime.roblox.com` all returned `ALLOW` (`TEMPORARY_ALLOW`). After 20 minutes, all 5 domains returned `BLOCK` (`EXPLICIT_BLOCK`).
- **DNS cache auto-flushed:** Mocked `flushDnsCache()` verified invoked on `APPROVED` and NOT invoked on `DENIED`.
- **Block page status polling & continuation:** Verified `/request-status` reports `status: 'APPROVED'`, `allowed: true`, and returns safe navigable HTTPS continue URL `https://roblox.com`.
- **Policy fallback resilience:** Directly verified that when the resolution event was omitted, `/request-status` evaluated the active policy and reported `allowed: true`.

---

## 5. Artifact Hashes & Release Manifest

All binaries have been downloaded from CI Run `40105310946`, verified via `sha256sum`, and staged in [release/windows-validation/](file:///home/agdev/projects/safebrowse/release/windows-validation/):

| Artifact | SHA-256 Checksum | Size (bytes) | WiX ProductVersion |
| :--- | :--- | :--- | :--- |
| [`SafeBrowseChild-Validation.msi`](file:///home/agdev/projects/safebrowse/release/windows-validation/SafeBrowseChild-Validation.msi) | `d9b49a51d8c198a34d8c27f214d641b0209ffe51f77e2dfd7e54673941cb99d1` | 23,478,272 | `1.0.4.11` |
| [`SafeBrowseChild-Validation.exe`](file:///home/agdev/projects/safebrowse/release/windows-validation/SafeBrowseChild-Validation.exe) | `9efa1c57eedfa02400bdb71f0efb2922a851838d6f74dc444487be867b3766d7` | 73,229,824 | `1.0.4.11` |
| [`SafeBrowseServiceHost.exe`](file:///home/agdev/projects/safebrowse/release/windows-validation/SafeBrowseServiceHost.exe) | `0ebabf1cfac0fe1cc9bc1a4a7754a85bd216bfdfb826bfa40127d5b422d10ad5` | 43,520 | — |
| [`SafeBrowseUserHelper.exe`](file:///home/agdev/projects/safebrowse/release/windows-validation/SafeBrowseUserHelper.exe) | `6bfb8cedcdb42c33d7e09c7534466a5b966211c990bda8f30e8a4c3692477b2d` | 11,264 | — |
| [`SafeBrowseChild-Validation-1.0.4.apk`](file:///home/agdev/projects/safebrowse/release/android/SafeBrowseChild-Validation-1.0.4.apk) | `42e782c1de57e4e78e5e85f80ed002e73e54a7fca50eb02699a7d4af46539e9d` | 5,641,147 | versionCode 5 |

Validation checksum verification: `sha256sum -c release/SHA256SUMS-validation.txt` -> **OK**.

---

## 6. Physical Windows Validation Procedure

1. **Install ProductVersion 1.0.4.11 MSI:**
   ```powershell
   Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @(
     '/i',
     '"C:\SafeBrowseValidation\SafeBrowseChild-Validation-1.0.4.11.msi"',
     '/qn',
     '/L*v',
     '"C:\SafeBrowseValidation\install-c54.log"'
   )
   ```
2. **Confirm Services & Helper Running:**
   ```powershell
   Get-Service SafeBrowseChildService
   Get-Process SafeBrowseUserHelper
   ```
3. **Trigger Roblox Block in Child Session:**
   - Under active child account (Session 5: `Anshul\mporwal`), navigate to `roblox.com`.
   - Verify block page opens automatically at `http://127.0.0.1:8880/blocked?domain=...&approvalDomain=roblox.com`.
   - Confirm prominent blocked title displays **`roblox.com`** (NOT `ncs.roblox.com`).
4. **Submit Request:**
   - Click "Ask Parent", enter reason (e.g. "Weekend play"), and click "Send Request".
   - Confirm button disables immediately ("Sending...").
   - Confirm page changes to "Request sent to your parent. Waiting for approval..." with loading spinner.
5. **Parent Portal Visibility & Approval:**
   - Check Parent Portal (https://safebrowse.porwal.online) on parent phone or computer.
   - Confirm access request displays **`roblox.com`**.
   - Click **Approve** (15 minutes).
6. **Automatic Continuation & Resolution:**
   - On the child's laptop, observe the block page without touching keyboard or mouse.
   - Confirm page automatically transitions to:
     **"Approved by your parent"**
     **"Access is available for: 15 minutes"**
   - Confirm browser automatically navigates to `https://roblox.com` after 1.5 seconds.
   - Confirm **NO manual `Clear-DnsClientCache`** was needed.
   - Confirm in elevated PowerShell:
     `Resolve-DnsName www.roblox.com -Server 127.0.0.1`
     successfully resolves.
7. **Expiry Verification:**
   - After the 15-minute temporary allowance expires, confirm `roblox.com` is automatically blocked again under the existing rule.

---

## 7. Final Classification

**Strict Classification:** **`READY FOR C5.4 ASK-PARENT APPROVAL PHYSICAL VALIDATION`**  
*(Strict Notice: DO NOT classify as Pilot Ready until Cloud VM2 deployment, production migration reconciliation, and clean physical laptop validation succeed.)*
