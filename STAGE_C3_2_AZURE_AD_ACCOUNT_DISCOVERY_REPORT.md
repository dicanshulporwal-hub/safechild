# SafeBrowse Stage C.3.2: Windows Azure AD / Entra & Domain Account Discovery Report

**Repository:** `/home/agdev/projects/safebrowse`  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Commit SHA:** `378040d14bd290e57f66112807bb4524ab1cba15`  
**Parent Commit:** `1ad8b455165168862a08fa530be8401638db5878`  
**Baseline Commit:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`  
**Validation Version:** `1.0.4-validation`  
**Windows ProductVersion:** `1.0.4.3`  
**Classification:** **`READY FOR WINDOWS ACCOUNT-MAPPING PHYSICAL RETEST`**  

---

## 1. Executive Summary & Defect Root Cause

### Physical Machine Defect
On physical test laptop `LAPTOP-AAN0K715`, launching the elevated "Configure Computer Accounts" window displayed:
```
ADMINISTRATOR APPROVED
"No interactive human accounts detected."
```
While the agent diagnostics (`GET /api/status`) confirmed:
```json
{
  "activeUser": "AzureAD\\AnshulPorwal",
  "isManaged": false,
  "mappings": []
}
```

### Root Cause Analysis
1. **Single-Source Local-Only Discovery Query:**  
   `account-manager.ts` in `discoverAccounts()` previously queried solely:
   ```powershell
   Get-CimInstance Win32_UserAccount -Filter "LocalAccount = True"
   ```
   On Microsoft Entra ID / Azure AD-joined or Hybrid-joined devices, interactive user accounts are cloud-backed Entra accounts rather than local accounts recorded in `Win32_UserAccount`. Thus, `Win32_UserAccount` returned zero results.
2. **Domain Prefix Stripping in Service Host:**  
   `SafeBrowseServiceHost.cs` was stripping the domain prefix from `account.Value` (`AzureAD\AnshulPorwal` -> `AnshulPorwal`), creating discrepancy between the active token's domain-qualified identity and the local profile name.
3. **Save Validation Rejection:**  
   `applyMappingSaveRequest()` enforces strict SID validation against `discoverAccounts()`. Because `discoverAccounts()` returned zero accounts, any attempt to save an Entra identity was blocked.

---

## 2. Required Behavior & Architectural Resolution

### Merged Account Discovery Strategy
`discoverAccounts()` now aggregates accounts across multiple authoritative Windows sources:
1. **Local Accounts:** `Get-CimInstance Win32_UserAccount -Filter 'LocalAccount = True'`
2. **Active Console Identity (Mandatory Source B):** Queries `Win32_ComputerSystem.UserName` and translates to `SecurityIdentifier`, and verifies with `getActiveConsoleSession()`.
3. **Interactive Explorer Sessions:** Inspects running `explorer.exe` process tokens via `Win32_Process` and translates owners to SIDs.
4. **Registry ProfileList (Entra / Domain Accounts):** Enumerates `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` for human profile SIDs matching `^S-1-5-21-` (domain/local) and `^S-1-12-1-` (Azure AD / Entra). Resolves the SID via `System.Security.Principal.SecurityIdentifier.Translate([System.Security.Principal.NTAccount])` with fallback to `ProfileImagePath` leaf.

### Authoritative SID Identity & Azure AD Exemption
- All discovered identities are keyed and deduplicated by uppercase SID.
- Azure AD SIDs (`S-1-12-1-*`) and domain-qualified names (`AzureAD\*`) are explicitly protected from service/system account filtering (`isSystemOrServiceAccount()` returns `false`).
- System and virtual service identities (`NT AUTHORITY\SYSTEM`, `LOCAL SERVICE`, `NETWORK SERVICE`, `AppPool`, `UMFD-*`, `DWM-*`, `TrustedInstaller`) remain strictly excluded.
- The full domain-qualified username (`AzureAD\AnshulPorwal`) is preserved in `SafeBrowseServiceHost.cs` and `active-session.json`.
- `getMappingForUsername()` supports bidirectional prefix matching (`mappingName.endsWith('\\' + cleanName)` or `cleanName.endsWith('\\' + mappingName)`).

---

## 3. Implementation Details

### File Changes

1. **`packages/agent-windows/src/account-manager.ts`:**
   - Updated `isSystemOrServiceAccount()` to explicitly exempt `S-1-12-1-*` SIDs and `AzureAD\` / `Azure AD\` accounts from service account filters.
   - Refactored `discoverAccounts()` to merge base accounts, console sessions, and registry profiles into a SID-keyed map.
   - Replaced WMI-only query with `queryWindowsAccountsViaPowerShell()` inspecting local accounts, console users, `explorer.exe` process owners, and `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`.
   - Updated `getMappingForUsername()` to support bidirectional domain-matching.
   - Updated `getActiveConsoleSession()` to support testing mocks with arbitrary usernames.

2. **`packages/agent-windows/service-host/SafeBrowseServiceHost.cs`:**
   - Removed the stripping of domain prefix (`username = username.Substring(...)`), preserving the full domain-qualified username (`AzureAD\AnshulPorwal`).

3. **`packages/agent-windows/src/elevated-config-server.ts`:**
   - Ensured case-insensitive SID matching when highlighting `isCurrentConsoleUser`.

4. **`packages/agent-windows/wix/SafeBrowseChild-Pilot.wxs` & `.github/workflows/build-windows-msi.yml`:**
   - Updated `ProductVersion` default and build parameter to `1.0.4.3`.

---

## 4. Automated Verification Results

### Dedicated Entra / Domain Test Suite
Created `packages/agent-windows/tests/account-discovery-entra-domain.test.ts` covering 10 required scenarios:
```
▶ SafeBrowse Windows Pilot — Stage C.3.2 Azure AD / Entra & Domain Account Discovery
  ✔ 1. Local account discovery works and discovers local users (19.9ms)
  ✔ 2. AzureAD active console identity (AzureAD\AnshulPorwal with S-1-12-1-...) appears in discovery (1.1ms)
  ✔ 3. Domain account (CORP\Alice) appears in discovery with domain intact (0.7ms)
  ✔ 4. Active interactive identity appears even when Win32_UserAccount returns none (0.7ms)
  ✔ 5. Duplicate SID across multiple discovery sources is deduplicated and marked correctly (0.8ms)
  ✔ 6. SYSTEM and service identities are strictly excluded from discovery and classification (0.5ms)
  ✔ 7. AzureAD SID is accepted by mapping validation and persists correctly (957.5ms)
  ✔ 8. Persisted AzureAD mapping resolves as managed child in resolveUserPolicy() (7.6ms)
  ✔ 9. Parent or unmanaged AzureAD account remains unmanaged when mapped accordingly (4.7ms)
  ✔ 10. Existing security and privilege protection invariants remain intact (15.6ms)
✔ SafeBrowse Windows Pilot — Stage C.3.2 Azure AD / Entra & Domain Account Discovery (1011.5ms)
ℹ tests 10, suites 1, pass 10, fail 0
```

### Full Agent-Windows Test Suite (All 13 Suites)
```
- tests/config-manager.test.ts                PASS (36 tests)
- tests/dns-proxy.test.ts                     PASS (10 tests)
- tests/network-manager.test.ts               PASS (52 tests)
- tests/process-limiter.test.ts               PASS (12 tests)
- tests/recovery-and-hardening.test.ts        PASS (120 tests)
- tests/shared-laptop-enforcement.test.ts     PASS (15 tests)
- tests/pilot-v1-device-management.test.ts    PASS (6 tests)
- tests/account-mapping-and-profiles.test.ts  PASS (42 tests)
- tests/elevated-pairing-and-privilege.test.ts PASS (15 tests)
- tests/dinner-bedtime-p0-hotfix.test.ts       PASS (14 tests)
- tests/user-session-block-presentation.test.ts PASS (12 tests)
- tests/service-block-ipc-integration.test.ts PASS (6 tests)
- tests/account-discovery-entra-domain.test.ts PASS (10 tests)
Total: 340+ tests across 13 suites — 100% PASSING, 0 FAILS
```

### Cross-Workspace Verification
- `@safebrowse/shared`: 9/9 tests PASS
- `@safebrowse/parent-web`: Production build PASS (`tsc && vite build`)
- `@safebrowse/backend`: 236/236 tests PASS across 45 suites (`tsc --noEmit` clean)

---

## 5. Artifact Provenance & Embedded Git Commit Verification

| Component | Target Version | ProductVersion / VersionCode | Build-Time Git Commit Verification |
| :--- | :--- | :--- | :--- |
| **Git Source Baseline** | `1.0.4-validation` | - | `378040d14bd290e57f66112807bb4524ab1cba15` |
| **Windows MSI** | `1.0.4-validation` | `1.0.4.3` | WiX Build via GitHub Actions Run `39903266007` |
| **Windows SEA Binary** | `1.0.4-validation` | `1.0.4-validation` | Byte offset 72732661 embeds `378040d14bd290e57f66112807bb4524ab1cba15` |
| **Android APK** | `1.0.4-validation` | `code: 4, name: 1.0.4-validation` | `classes.dex` offset 6363619 embeds `378040d14bd290e57f66112807bb4524ab1cba15` |

### SHA-256 Checksums (`release/SHA256SUMS-validation.txt`)
```
63be99f18c644be7d4577949e0d20c3c305f194c3ab24c8e240a311321a29baa  release/android/SafeBrowseChild-Validation-1.0.4.apk
a0dd5290d8d68e22fc173f49fc185f1e50ac98e3e485b7a82eb66bc10166f4d4  release/windows-validation/SafeBrowseChild-Validation.msi
a243952661713d15d7ce04fbad3cb4bf5051b344186ea511909a5b40e097806f  release/windows-validation/SafeBrowseChild-Validation.exe
3a85d91bad30fdebd6e130c6f7bd25eca2c7976901cf978dceb3f40ccf4e67d1  release/windows-validation/SafeBrowseServiceHost.exe
6e93f7f05f5ecf49136d2d06aa83475b430c8cf91fd9be5dd0b227d1a311fc9f  release/windows-validation/SafeBrowseUserHelper.exe
```

---

## 6. Physical Retest Instructions for Laptop `LAPTOP-AAN0K715`

1. **Install Updated MSI:**
   Install `release/windows-validation/SafeBrowseChild-Validation.msi` (ProductVersion `1.0.4.3`).
2. **Launch Elevated Account Mapping:**
   Open the elevated "Configure Computer Accounts" window (`SafeBrowse-Pair.cmd` or Start Menu shortcut).
3. **Verify Account Discovery:**
   - Confirm that `AzureAD\AnshulPorwal` is discovered and listed with its real SID (`S-1-12-1-...`).
   - Confirm that `isCurrentConsoleUser` is properly identified and highlighted.
4. **Map to Child:**
   - Select child profile (`Manjari`) for `AzureAD\AnshulPorwal` and click Save.
5. **Verify Diagnostics (`/api/status`):**
   - Confirm:
     ```json
     {
       "activeUser": "AzureAD\\AnshulPorwal",
       "isManaged": true,
       "childName": "Manjari",
       "protectionState": "PROTECTED"
     }
     ```
6. **Verify Automatic Block Page:**
   - Browse to a blocked domain (e.g., `reddit.com` or `tiktok.com`).
   - Confirm browser shows NXDOMAIN and SafeBrowse block page is automatically presented in child's interactive desktop session.
