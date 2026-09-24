# SafeBrowse Windows Authenticode Release Code Signing Architecture & Pipeline Specification

- **Specification Version:** `1.0.0`
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
[1. Build TypeScript SEA Bundle] ───> SafeBrowseChild-Pilot.exe (Unsigned)
[2. Compile C# Host Wrapper]    ───> SafeBrowseServiceHost.exe (Unsigned)
                                               │
                                               ▼
                              [3. Authenticode Sign SafeBrowseChild-Pilot.exe]
                              [4. Authenticode Sign SafeBrowseServiceHost.exe]
                                               │
                                               ▼
                              [5. Strict Signature Verification Gate]
                              (Get-AuthenticodeSignature & signtool verify)
                                               │
                                               ▼
                              [6. WiX Toolset v4 MSI Assembly]
                              (Packs signed executables into SafeBrowseChild-Pilot.msi)
                                               │
                                               ▼
                              [7. Authenticode Sign SafeBrowseChild-Pilot.msi]
                                               │
                                               ▼
                              [8. Strict MSI Signature Verification Gate]
                                               │
                                               ▼
                              [9. Generate signing-manifest.json & SHA256SUMS.txt]
                                               │
                                               ▼
                              [10. Publish Signed Release Candidate Artifact]
```

### Critical Ordering Invariants
- Executables (`SafeBrowseChild-Pilot.exe` and `SafeBrowseServiceHost.exe`) **must be signed before WiX MSI assembly**. WiX embeds these files into the MSI's internal cabinet (`cab`) file. Signing them after MSI assembly would require unpacking or would leave the installed files unsigned.
- The assembled MSI (`SafeBrowseChild-Pilot.msi`) **must be signed as the final binary step**.
- The release job **fails closed**: if signature verification fails at any stage, the build aborts immediately, and no release artifacts are published.

---

## 3. Cryptographic Standards & Certificate Requirements

### 3.1 Algorithm Standards
- **File Digest Algorithm:** `SHA-256` (strictly `/fd SHA256`).
- **Timestamp Digest Algorithm:** `SHA-256` (strictly `/td SHA256`).
- **Timestamp Protocol:** **RFC3161** compliant timestamping.
- **Legacy Algorithms:** **Zero SHA-1 usage**. SHA-1 is cryptographically broken and rejected by modern Windows Defender and SmartScreen policies.

### 3.2 Certificate Types & Key Storage
Commercial code signing certificates must adhere to CA/Browser Forum Baseline Requirements:
- **Extended Validation (EV) or Cloud Hardware Security Module (HSM):** Private keys must be stored on FIPS 140-2 Level 2+ hardware (e.g. YubiKey, Azure Key Vault, AWS CloudHSM, DigiCert KeyLocker).
- **Standard Code Signing (OV):** Allowed during beta/staging cohorts, but requires building SmartScreen reputation.

---

## 4. GitHub Actions CI Secret & Provider Interface

### 4.1 Model A: Secret PFX Provider (Staging / Automated CI)
For automated runner signing using an exported PFX certificate:
- **Secret: `WINDOWS_SIGNING_CERT_BASE64`**
  - Content: Base64-encoded string of the `.pfx` (or `.p12`) certificate container.
  - Injected into runner environment only during the signing step.
- **Secret: `WINDOWS_SIGNING_CERT_PASSWORD`**
  - Content: Strong passphrase protecting the PFX container.
  - Automatically masked from all build logs via `::add-mask::`.

#### Ephemeral Lifetime & Secure Cleanup
Temporary certificate files are written to `$RUNNER_TEMP` (an isolated ramdisk/temp path) and securely scrubbed using cryptographically secure random bytes prior to file deletion:
```powershell
try {
    # Execute signtool sign ...
} finally {
    if (Test-Path $tempCertPath) {
        $len = (Get-Item $tempCertPath).Length
        $wipe = New-Object byte[] $len
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($wipe)
        [System.IO.File]::WriteAllBytes($tempCertPath, $wipe)
        Remove-Item -Path $tempCertPath -Force
    }
}
```

### 4.2 Model B: Cloud HSM / OIDC Provider (Production Release Candidate)
For production environments where private keys cannot be exported from hardware:
- **Azure Trusted Signing / Azure Key Vault:** Uses Azure CLI or Azure Sign Tool with GitHub Actions OIDC federation (`id-token: write`).
- **DigiCert ONE / KeyLocker:** Uses DigiCert Secure Software Manager (SSM) client tools.
- **Architecture Compatibility:** The build pipeline `.github/workflows/build-windows-release.yml` structures the signing step around `signtool.exe`, allowing drop-in substitution of cloud CSP/KSP providers (e.g., `/csp "eToken Base Cryptographic Provider"` or Azure Sign Tool) without changing the surrounding build sequence.

---

## 5. Verification Gates & Manifest Generation

### 5.1 Verification Commands
Every binary and installer package is verified through two complementary Windows verification mechanisms:

1. **PowerShell `Get-AuthenticodeSignature`:**
   ```powershell
   $sig = Get-AuthenticodeSignature -FilePath $targetFile
   if ($sig.Status -ne "Valid") {
       throw "Signature verification failed: $($sig.StatusMessage)"
   }
   ```
2. **Windows SDK `signtool verify`:**
   ```cmd
   signtool.exe verify /pa /all /v <targetFile>
   ```
   - `/pa`: Uses Default Authentication Verification Policy (Authenticode).
   - `/all`: Verifies all signatures in multi-signed files.
   - `/v`: Verbose output detailing chain of trust, root CA, and RFC3161 timestamp.

### 5.2 Machine-Readable Signing Manifest (`signing-manifest.json`)
The release build generates a structured JSON manifest accompanying every build artifact:
```json
{
  "manifestVersion": "1.0",
  "buildType": "SIGNED_RELEASE_CANDIDATE",
  "productName": "SafeBrowse Child Protection",
  "productVersion": "1.0.0.0",
  "commitSha": "256e4863835e4ffbb8cd599f6f560db0c9f58f65",
  "branch": "feature/stage11-step4-device-enforcement",
  "workflowRunId": "35578114690",
  "workflowRunNumber": 20,
  "timestamp": "2026-09-24T05:50:00.000Z",
  "signingMode": "PRODUCTION_AUTHENTICODE",
  "timestampServer": "http://timestamp.digicert.com",
  "digestAlgorithm": "SHA256",
  "artifacts": [
    {
      "name": "SafeBrowseChild-Pilot.exe",
      "path": "release/windows/SafeBrowseChild-Pilot.exe",
      "sha256": "1e00ac2ba5327385edfede5acda38edc440e0bf0e5e3f1b8d59b179c4429d003",
      "signatureStatus": "Valid",
      "statusMessage": "Signature verified.",
      "signerCertificate": {
        "subject": "CN=SafeBrowse Technologies Inc., O=SafeBrowse Technologies Inc., C=US",
        "issuer": "CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=DigiCert Inc, C=US",
        "thumbprint": "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
        "validFrom": "2026-01-01T00:00:00.000Z",
        "validTo": "2029-01-01T23:59:59.000Z"
      },
      "timestamp": {
        "subject": "CN=DigiCert Timestamp 2026, O=DigiCert Inc, C=US",
        "issuer": "CN=DigiCert Trusted G4 RSA4096 SHA384 2021 CA1, O=DigiCert Inc, C=US",
        "thumbprint": "1234567890ABCDEF1234567890ABCDEF12345678"
      }
    }
  ]
}
```

---

## 6. Pilot vs. Release Candidate Workflow Separation

To guarantee that internal physical validation and ongoing development are never blocked by certificate access or signing infrastructure:

| Attribute | Pilot Workflow (`build-windows-msi.yml`) | Release Workflow (`build-windows-release.yml`) |
|---|---|---|
| **Trigger** | Push to `feature/*` or manual dispatch | Protected tags (`v*`) or manual release dispatch |
| **Output Type** | `UNSIGNED (Local Pilot Physical Validation)` | `SIGNED_RELEASE_CANDIDATE` (or `DRY_RUN`) |
| **Signing Enforcement** | None (Unsigned) | Mandatory Authenticode SHA-256 + RFC3161 |
| **Failure Policy** | Continues without signing | **Fails closed** if signing fails |
| **Artifact Name** | `SafeBrowseChild-Pilot-MSI` | `SafeBrowse-Windows-Release-Candidate` |
| **Target Audience** | Engineering lab & physical pilot testing | Staging cohort, beta testers, public release |

---

## 7. Versioning & Upgrade Strategy

### 7.1 Windows Installer Identifiers
- **`UpgradeCode` (`B7C5E643-81D2-4A7F-991A-7110C99AA511`):** **NEVER CHANGE**. The UpgradeCode identifies the application family across all versions. Changing it breaks automatic upgrades and leaves orphaned previous installations.
- **`ProductCode`:** Auto-generated (`*`) per build by WiX v4. This enables clean major-upgrade semantics.
- **`ProductVersion`:** Format must be strictly `Major.Minor.Build.0` (e.g. `1.0.1.0`, `1.1.0.0`).
  - Windows Installer compares only the first three fields (`Major.Minor.Build`).
  - Same-version installations (e.g., installing `1.0.0.0` over `1.0.0.0`) are treated as maintenance/repair mode and do not run standard `MajorUpgrade` uninstall/reinstall sequences.

### 7.2 Release Versioning Recommendation
1. For pilot testing: Keep `1.0.0.0` (requiring clean uninstall before reinstall, as documented in Run #20).
2. For first signed Release Candidate: Increment to `1.0.1.0`.
3. For General Availability: Start with `1.1.0.0`.
4. Connect CI input `releaseVersion` to dynamically pass `-d Version="$releaseVersion"` during WiX compilation.

---

## 8. Dry-Run & Test Mode Specifications

Because production signing credentials should not be created unnecessarily or committed to git:
- The release workflow supports a **`dryRun`** input (boolean).
- If `dryRun == true`:
  - Binaries are built and packaged normally.
  - The signing step detects missing secrets and issues a visible GitHub warning: `::warning::[DRY-RUN / TEST MODE] Windows code signing is not configured.`
  - The build succeeds and generates an `UNSIGNED_DRY_RUN` manifest.
  - **Crucial Rule:** Dry-run artifacts are explicitly labelled `UNSIGNED` and must **never** be distributed as release candidates.
- If `dryRun == false` (default for release builds):
  - Missing `WINDOWS_SIGNING_CERT_BASE64` secret results in an immediate **fatal exit 1**, preventing unsigned builds from being produced in production workflows.

---

## 9. Security Controls & Operational Procedures

### 9.1 Fork PR Isolation
- Secrets (`WINDOWS_SIGNING_CERT_*`) are restricted to repository maintainers.
- Fork pull requests do not have access to repository secrets by GitHub Actions default security design.
- The release workflow only triggers on pushes to the base repository or manual dispatches by authenticated collaborators.

### 9.2 Key Compromise & Revocation Procedure
In the event of private key exposure:
1. Immediately contact the issuing Certificate Authority (e.g., DigiCert / Sectigo) and request immediate certificate revocation with an explicit revocation reason (*Key Compromise*).
2. Because RFC3161 timestamps record the exact signing time, binaries signed **prior** to the revocation timestamp remain valid, while binaries signed **after** the revocation timestamp are rejected.
3. Update GitHub repository secrets with a freshly issued certificate and new password.
4. Trigger an immediate emergency release build with incremented `ProductVersion`.

### 9.3 Release Rollback Procedure
If a signed release exhibits an unexpected regression:
1. Revoke the release tag in GitHub Releases.
2. In the Parent Web Portal and device management API, deploy a policy update or maintenance flag directing client agents to roll back or stop enforcement.
3. Distribute the previous known-good signed MSI installer (`1.0.x.0`). Because `MajorUpgrade` prevents automatic downgrade, the rollback installer should be executed with clean uninstall parameters or built with an incremented version number containing reverted binary payloads.
