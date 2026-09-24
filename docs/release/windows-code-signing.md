# SafeBrowse Windows Authenticode Release Code Signing Architecture & Pipeline Specification

- **Specification Version:** `1.1.0`
- **Classification:** `RELEASE PREPARATION — NOT GA READY`
- **Target Platform:** Windows 10 / Windows 11 x64
- **Digest Standard:** SHA-256 with RFC3161 Authenticode Timestamping
- **Release Packaging Workflow:** [`.github/workflows/build-windows-release.yml`](file:///home/agdev2/projects/safebrowse/.github/workflows/build-windows-release.yml)
- **Pilot Packaging Workflow (Preserved):** [`.github/workflows/build-windows-msi.yml`](file:///home/agdev2/projects/safebrowse/.github/workflows/build-windows-msi.yml)

---

## 1. Executive Summary & Architectural Motivation

Production deployment of SafeBrowse on Microsoft Windows requires digital Authenticode signatures across all distributed executables and installer packages. Unsigned binaries trigger high-friction operating system security interventions that degrade user experience and endanger child safety enforcement:

1. **Windows SmartScreen Filter:** Unsigned or poorly signed installers trigger severe warnings (*"Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognized app from starting"*), requiring manual override.
2. **User Account Control (UAC):** Unsigned MSI installers display a high-risk yellow/orange UAC prompt identifying the publisher as *"Unknown Publisher"*, rather than a verified commercial publisher.
3. **Anti-Malware Scan Interface (AMSI) & System Services:** Background services running under `NT AUTHORITY\SYSTEM` (e.g. `SafeBrowseServiceHost.exe`) with network interception capabilities face aggressive scrutiny by third-party EDR/antivirus solutions unless signed by a trusted code-signing certificate.
4. **Binary Integrity & Anti-Tamper:** Authenticode guarantees that binaries have not been altered or corrupted in transit between GitHub CI compilation and local device execution.

---

## 2. Release Signing Pipeline Sequence

To ensure that the Windows Installer package contains verified signed binaries, signing must occur in a strict hierarchical order:

```
[1. Tag & Version Validation Gate] ───> Validates refs/tags/v* -> ProductVersion (Major.Minor.Build.0)
                                                │
                                                ▼
[2. Build TypeScript SEA Bundle]   ───> SafeBrowseChild-Pilot.exe (Unsigned)
[3. Compile C# Host Wrapper]      ───> SafeBrowseServiceHost.exe (Unsigned)
                                                │
                                                ▼
                                  [4. Authenticode Sign SafeBrowseChild-Pilot.exe]
                                  [5. Authenticode Sign SafeBrowseServiceHost.exe]
                                                │
                                                ▼
                                  [6. Strict Dual Verification Gate]
                                  (Get-AuthenticodeSignature & signtool.exe verify /pa /all /v)
                                                │
                                                ▼
                                  [7. WiX Toolset v4 MSI Assembly with Injected ProductVersion]
                                  (Packs signed executables into SafeBrowseChild-Pilot.msi)
                                                │
                                                ▼
                                  [8. Strict Actual MSI ProductVersion Verification Gate]
                                  (Queries WindowsInstaller.Installer COM Property table)
                                                │
                                                ▼
                                  [9. Authenticode Sign SafeBrowseChild-Pilot.msi]
                                                │
                                                ▼
                                  [10. Strict MSI Dual Verification Gate]
                                  (Get-AuthenticodeSignature & signtool.exe verify /pa /all /v)
                                                │
                                                ▼
                                  [11. Generate signing-manifest.json & SHA256SUMS.txt]
                                                │
                                                ▼
                                  [12. Publish SafeBrowse-Windows-Release-Candidate Artifact]
```

### Critical Ordering Invariants
- Executables (`SafeBrowseChild-Pilot.exe` and `SafeBrowseServiceHost.exe`) **must be signed before WiX MSI assembly**. WiX embeds these files into the MSI's internal cabinet (`cab`) file. Signing them after MSI assembly would require unpacking or would leave the installed files unsigned.
- The assembled MSI (`SafeBrowseChild-Pilot.msi`) **must be signed as the final binary step**.
- The release job **fails closed**: if signature verification fails at any stage, or if metadata/versioning mismatches, the build aborts immediately, and no release artifacts are published.

---

## 3. Cryptographic Standards & Certificate Requirements

### 3.1 Algorithm Standards
- **File Digest Algorithm:** `SHA-256` (strictly `/fd SHA256`).
- **Timestamp Digest Algorithm:** `SHA-256` (strictly `/td SHA256`).
- **Timestamp Protocol:** **RFC3161** compliant timestamping.
- **Timestamp Server Allowlist:** Only approved, trusted RFC3161 timestamping endpoints may be used:
  - Primary: `http://timestamp.digicert.com` (or `https://timestamp.digicert.com`)
  - Fallback: `http://timestamp.sectigo.com` (or `https://timestamp.sectigo.com`)
  - Any server outside this allowlist is rejected, causing the workflow to fail closed.
- **Legacy Algorithms:** **Zero SHA-1 usage**. SHA-1 is cryptographically broken and rejected by modern Windows Defender and SmartScreen policies.

### 3.2 Preferred Production Key Storage: Cloud HSM & Non-Exportable Keys
Commercial code signing certificates must adhere to CA/Browser Forum Baseline Requirements. The **preferred production architecture** utilizes hardware-backed or cloud-managed non-exportable keys:
- **Cloud HSM / Managed Code Signing (Preferred Public Production Model):**
  - Private keys reside inside FIPS 140-2 Level 2+ / Level 3 Hardware Security Modules.
  - Private key material **never leaves the HSM** and is never exported as a file to the GitHub runner.
  - Integration options include:
    - Azure Trusted Signing / Azure Key Vault HSM via OpenID Connect (OIDC) federation (`id-token: write`).
    - DigiCert ONE / Software Trust Manager (SSM) client tools.
    - AWS CloudHSM or vendor-neutral PKCS#11 cryptographic providers.
- **Software PFX Container (Compatibility / Staging / Private PKI Only):**
  - Exported `.pfx` / `.p12` containers stored as repository secrets are supported strictly as a compatibility path for internal testing, staging, and automated CI pipelines.
  - PFX containers in GitHub Secrets are **not** the preferred public production model due to exportability and long-lived credential risks.

---

## 4. Protected GitHub Signing Environment (`windows-production-signing`)

To isolate production signing credentials and prevent unauthorized or unapproved releases:

1. **Dedicated Environment:** The production signing job is bound to GitHub Environment `windows-production-signing`.
2. **Environment Protection Rules:**
   - **Deployment Branches / Tags:** Restricted strictly to approved release tags (`v*`). Feature branches and pull requests **cannot** access this environment.
   - **Required Reviewers:** Release engineering leads / designated security administrators must approve any execution referencing `windows-production-signing`.
   - **Prevent Self-Approval:** Self-approval is disabled where supported.
3. **Environment Secrets:**
   - `WINDOWS_SIGNING_CERT_BASE64`
   - `WINDOWS_SIGNING_CERT_PASSWORD`
   - (Or Cloud HSM / OIDC client credentials)
4. **Dry-Run Job Isolation:** The `dry-run-windows-build` job does **not** define an environment and has zero access to production credentials.

---

## 5. Ephemeral Runner Credential Handling & Forensic Semantics

When the PFX compatibility mode is used on the GitHub runner:

1. **Log Masking:** The certificate passphrase is immediately masked from runner logs using `::add-mask::$certPassword`.
2. **Ephemeral File Creation:** The temporary PFX file is written to `$RUNNER_TEMP` (an isolated ephemeral runner path).
3. **Accurate Storage & Erasure Semantics:**
   - `$RUNNER_TEMP` is an ephemeral directory on the runner host disk; it is **not guaranteed to reside in RAM**.
   - Before deletion, the temporary certificate file is overwritten with cryptographically secure pseudo-random bytes (`[RandomNumberGenerator]::Create().GetBytes(...)`) inside a `finally` block before calling `Remove-Item -Force`.
   - **Forensic Reality:** While best-effort overwrite defends against simple casual inspection, it does **not** provide cryptographic guarantees of forensic erasure on modern copy-on-write filesystems, SSDs with wear-leveling controllers, or virtualized cloud block devices.
   - **Architectural Mitigation:** This limitation is precisely why **hardware-backed / cloud-backed non-exportable keys** (Section 3.2) represent the preferred production model, eliminating disk-based private keys on CI runners entirely.

---

## 6. Dual Verification Gates & Required Tooling

### 6.1 Strict SignTool Requirement
Production Authenticode signing strictly requires the official Windows SDK `signtool.exe`. If `signtool.exe` is absent from the runner environment, the release workflow **fails closed** immediately. Silent downgrade to PowerShell `Set-AuthenticodeSignature` is forbidden in production signing.

### 6.2 Dual Verification Policy
Every binary (`SafeBrowseChild-Pilot.exe`, `SafeBrowseServiceHost.exe`) and installer (`SafeBrowseChild-Pilot.msi`) must pass two independent verification gates:

1. **PowerShell `Get-AuthenticodeSignature`:**
   ```powershell
   $sig = Get-AuthenticodeSignature -FilePath $targetFile
   if ($sig.Status -ne "Valid") {
       throw "Authenticode signature validation failed for $targetFile: $($sig.StatusMessage)"
   }
   if (-not $sig.TimeStamperCertificate) {
       throw "Missing RFC3161 timestamp certificate on $targetFile"
   }
   ```
2. **Windows SDK `signtool.exe verify`:**
   ```cmd
   signtool.exe verify /pa /all /v <targetFile>
   ```
   - `/pa`: Authenticode verification policy check.
   - `/all`: Validates all signatures.
   - `/v`: Full chain-of-trust, root CA, and RFC3161 timestamp verification.

Failure of either verification command aborts the pipeline immediately.

---

## 7. Versioning, Upgrade Code Invariance & Tag Mapping

### 7.1 UpgradeCode Invariance
- **`UpgradeCode` (`B7C5E643-81D2-4A7F-991A-7110C99AA511`):** **IMMUTABLE**. The `UpgradeCode` identifies the application family across all releases. Changing it breaks Windows Installer `MajorUpgrade` detection, resulting in orphaned parallel installations.
- **`ProductCode`:** Auto-generated (`*`) per build by WiX v4 to enable clean major upgrade semantics.

### 7.2 Deterministic ProductVersion Injection
In [`packages/agent-windows/wix/SafeBrowseChild-Pilot.wxs`](file:///home/agdev2/projects/safebrowse/packages/agent-windows/wix/SafeBrowseChild-Pilot.wxs):
```xml
<?ifndef ProductVersion?>
<?define ProductVersion = "1.0.0.0" ?>
<?endif?>
<Package
    Name="SafeBrowse Child Pilot"
    Manufacturer="SafeBrowse"
    Version="$(var.ProductVersion)"
    UpgradeCode="B7C5E643-81D2-4A7F-991A-7110C99AA511"
    Scope="perMachine">
```
- In pilot builds and local dev, `ProductVersion` defaults to `1.0.0.0`.
- In release builds, `wix build` receives `-d ProductVersion="$effectiveVersion"`.
- Format must strictly follow `Major.Minor.Build.0` (e.g. `1.0.1.0`).

### 7.3 Release Tag Validation & Deterministic Mapping
Production release packaging triggered by Git tags must follow strict semantic tag rules:
- **Tag Format:** `refs/tags/v<Major>.<Minor>.<Patch>` (e.g. `refs/tags/v1.0.1`).
- **Deterministic Mapping:** `v1.0.1` maps to `ProductVersion 1.0.1.0`.
- **Fail-Closed Mismatch Check:** If an explicit `releaseVersion` input was provided and does not equal the tag-derived version, or if the tag does not conform to the pattern, the job aborts immediately (`exit 1`).
- Production signing on non-tag branches is blocked.

### 7.4 Actual MSI ProductVersion Verification Gate
After `SafeBrowseChild-Pilot.msi` is compiled, the workflow queries the Windows Installer COM database directly:
```powershell
$com = New-Object -ComObject WindowsInstaller.Installer
$db = $com.OpenDatabase($msiPath, 0)
$view = $db.OpenView("SELECT Value FROM Property WHERE Property = 'ProductVersion'")
$view.Execute()
$rec = $view.Fetch()
$actualVersion = $rec.StringData(1)
```
If `$actualVersion` does not match the expected version, the workflow **fails closed**.

---

## 8. Dry-Run vs. Release Candidate Separation

| Attribute | Dry-Run Build (`dry-run-windows-build`) | Production Release (`production-sign-windows-release`) |
|---|---|---|
| **Trigger** | `workflow_dispatch` with `dryRun: true` | Pushed release tag (`v*`) |
| **GitHub Environment** | None (unprotected) | `windows-production-signing` (protected) |
| **Signing Secrets Access** | None | Ephemeral injection |
| **Artifact Name** | `SafeBrowse-Windows-Dry-Run-UNSIGNED` | `SafeBrowse-Windows-Release-Candidate` |
| **Labeling** | `UNSIGNED - NOT FOR DISTRIBUTION - NOT RELEASE CANDIDATE - TEST ONLY` | `AUTHENTICODE_SIGNED RELEASE CANDIDATE` |
| **ProductVersion Injection** | Enabled (`releaseVersion` input) | Enabled (deterministic tag mapping) |
| **Actual MSI Verification** | Yes (Property table query) | Yes (Property table query) |
| **Signing & Verification** | None | Mandatory dual verification (`signtool` + `pwsh`) |

---

## 9. Supply-Chain Hardening: Pinned GitHub Actions

All external GitHub Actions used in [`.github/workflows/build-windows-release.yml`](file:///home/agdev2/projects/safebrowse/.github/workflows/build-windows-release.yml) are pinned to immutable 40-character full commit SHAs:

| Action | Pinned Commit SHA | Official Release Tag |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | `v4.4.0` |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `v4.6.2` |

---

## 10. Truthful Signing Manifest (`signing-manifest.json`)

The manifest records only **actual observed, verified parameters** rather than requested or default parameters:
- `buildType`: `SIGNED_RELEASE_CANDIDATE` (or `UNSIGNED_DRY_RUN`)
- `distributionAllowed`: boolean (`true` only if fully signed and verified)
- `releaseCandidate`: boolean (`true` only if fully signed and verified)
- `actualMsiProductVersion`: Extracted directly from MSI database
- `commitSha`: Verified Git commit SHA
- `gitRef`: Git tag or branch
- `workflowRunId` & `workflowRunNumber`: Official GitHub run identifiers
- SHA256 hashes for all binaries and MSI
- Actual observed signature status, signer certificate metadata, and RFC3161 timestamp metadata

---

## 11. Backend URL Audit & GA Scope Boundary

- **Audit Result:** The previous workflow input `backendUrl` only populated release metadata and did **not** configure or alter the compiled `SafeBrowseChild-Pilot.exe` binary.
- **Current Operational Baseline:** The client agent continues to default to the pilot Tailscale backend endpoint (`http://100.88.17.16:11002`) or accepts runtime configuration via `SafeBrowse-Pair.cmd`.
- **Misleading Metadata Removed:** The `backendUrl` parameter has been removed from release workflow inputs to ensure no false claims of production HTTPS endpoint configuration are published.
- **GA Blocker:** Provisioning high-availability production HTTPS endpoints (`https://api.safebrowse.io`) with strict certificate validation and mTLS remains an independent release milestone.

---

## 12. Security Controls & Incident Response

### 12.1 Key Compromise Procedure
1. Contact issuing Certificate Authority (DigiCert / Sectigo) immediately to revoke the certificate with reason *Key Compromise*.
2. Due to RFC3161 timestamping, binaries signed prior to the revocation timestamp remain valid, while subsequent signatures are rejected.
3. Update GitHub Environment secrets or Cloud HSM key identifiers.
4. Trigger an emergency release build with incremented `ProductVersion`.

### 12.2 Rollback Procedure
If a regression is discovered in a signed release:
1. Revoke the release tag in GitHub Releases.
2. Signal device rollbacks via backend policy or maintenance flags.
3. Distribute a known-good signed MSI installer (`1.0.x.0`) with incremented version number or via clean uninstall/reinstall.
