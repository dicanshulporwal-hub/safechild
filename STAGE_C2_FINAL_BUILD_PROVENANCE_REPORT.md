# STAGE C.2 FINAL BUILD PROVENANCE REPORT

**Report Date:** 2026-10-22T08:22:00Z  
**Classification:** `READY FOR PHYSICAL VALIDATION`  
*(Strict Invariant: NOT classified as PILOT READY, PRODUCTION READY, or RELEASE READY until physical validation has completed)*  
**Repository:** `/home/agdev/projects/safebrowse`  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Final Source SHA:** `8470382b404aa8b3725c947b17339652ec361570`  
**Parent Source SHA:** `00748e77dda2ffdabcd0cb81624d3b0e28d0ec33`  
**Baseline Source SHA:** `e2589b8ba43e46e25cd15287d41e91aa09ec1400`  
**Public Release Created:** `false` (`v1.0.3-pilot` preserved untouched)

---

## 1. Executive Summary

In accordance with Stage C.2 directives, the self-referential provenance problem has been permanently resolved through automated **BUILD-TIME Git SHA injection** for both Windows and Android toolchains. Hardcoded commit constants were removed from source code:
1. **Windows Toolchain:** `generate-build-info.js` dynamically extracts `git rev-parse HEAD` and generates untracked `packages/agent-windows/src/build-info.ts` prior to TypeScript compilation and `esbuild` Single Executable Application bundling.
2. **Android Toolchain:** `getGitCommit()` in `app/build.gradle.kts` resolves `git rev-parse HEAD` during Gradle configuration and injects it into `BuildConfig.BUILD_COMMIT`. `AgentConfig.BUILD_COMMIT` dynamically exposes `BuildConfig.BUILD_COMMIT`.
3. **Commit & Build Flow:** The build-provenance implementation was committed as `8470382` and pushed to remote tracking branch. All validation binaries were cleanly rebuilt **after** `8470382` existed.
4. **Binary Verification:** Direct byte-level binary inspection confirms `buildCommit == 8470382b404aa8b3725c947b17339652ec361570` in both Windows executable and Android DEX bytecode.

---

## 2. Commit Triad Verification

| Entity | SHA Value | Match Status |
| :--- | :--- | :---: |
| **Final Source SHA** | `8470382b404aa8b3725c947b17339652ec361570` | Reference Baseline |
| **Windows Embedded `buildCommit`** | `8470382b404aa8b3725c947b17339652ec361570` | ✅ **100% IDENTICAL** |
| **Android Embedded `buildCommit`** | `8470382b404aa8b3725c947b17339652ec361570` | ✅ **100% IDENTICAL** |

---

## 3. Validation Artifacts & SHA-256 Checksums

```text
release/SHA256SUMS-validation.txt:

7af5193b52bfd9bf9b0fb91bbe0021e7e6d4ac8c39a328d32d28c835991bf085  release/android/SafeBrowseChild-Validation-1.0.4.apk
327818c80d2bb288b7007793b58ab35a548badf9dd9363895c56e09dfd0ae040  release/windows-validation/SafeBrowseChild-Validation.msi
9dc93a3c6a00a3c41d1de17da7c56f11f3722192a54551337535205a2f5aa197  release/windows-validation/SafeBrowseChild-Validation.exe
39a58161968c7ace728425c652e725d53a97f27d0a63c4dd0fd4d62f4ae640bb  release/windows-validation/SafeBrowseServiceHost.exe
```

### Detailed Artifact Registry

| Component | File Path | File Size | SHA-256 Checksum |
| :--- | :--- | :---: | :--- |
| **Android Validation APK** | `release/android/SafeBrowseChild-Validation-1.0.4.apk` | 5,641,033 B | `7af5193b52bfd9bf9b0fb91bbe0021e7e6d4ac8c39a328d32d28c835991bf085` |
| **Windows Installer (MSI)** | `release/windows-validation/SafeBrowseChild-Validation.msi` | 23,453,696 B | `327818c80d2bb288b7007793b58ab35a548badf9dd9363895c56e09dfd0ae040` |
| **Windows Executable (SEA)** | `release/windows-validation/SafeBrowseChild-Validation.exe` | 73,102,848 B | `9dc93a3c6a00a3c41d1de17da7c56f11f3722192a54551337535205a2f5aa197` |
| **Windows Service Host** | `release/windows-validation/SafeBrowseServiceHost.exe` | 37,888 B | `39a58161968c7ace728425c652e725d53a97f27d0a63c4dd0fd4d62f4ae640bb` |

---

## 4. Inspection & Verification Summary

1. **Android APK Inspection:**
   - Package: `com.safebrowse.child`
   - `versionName`: `1.0.4-validation`
   - `versionCode`: `4`
   - DEX Bytecode Scan: `classes.dex` contains exact `8470382b404aa8b3725c947b17339652ec361570`. 0 occurrences of old baseline `e2589b8` or previous commit `00748e7`.
   - Heartbeat Telemetry: `SyncWorker` and `SafeBrowseVpnService` transmit both `agentVersion: "1.0.4-validation"` and `buildCommit: "8470382b404aa8b3725c947b17339652ec361570"`.
2. **Windows Binary Inspection:**
   - `ProductVersion`: `1.0.4.0`
   - `WINDOWS_AGENT_VERSION`: `1.0.4-validation`
   - PE SEA Blob Scan: Exact `8470382b404aa8b3725c947b17339652ec361570` embedded. 0 occurrences of `e2589b8` or `00748e7`.
   - SCM Recovery: Automatic startup restoration logic intact under `NOT REMOVE`.
   - Heartbeat Telemetry: `PolicySyncClient` transmits both `agentVersion: "1.0.4-validation"` and `buildCommit: "8470382b404aa8b3725c947b17339652ec361570"`.
3. **Workflow & Release Protection:**
   - `.github/workflows/build-windows-msi.yml`: Step `Update GitHub Release Assets (v1.0.3-pilot)` was disabled with `if: false`, protecting `v1.0.3-pilot` from being clobbered during push runs.
4. **Automated Regression Testing:**
   - `@safebrowse/shared`: 9 / 9 passed (2 suites)
   - `@safebrowse/agent-windows`: 239 / 239 passed (10 suites)
   - `@safebrowse/backend`: 236 / 236 passed (45 suites)
   - Android Unit Tests: 13 / 13 passed (`LocalPolicyManagerTest`)

---

## 5. Final Classification

```
================================================================================
FINAL CLASSIFICATION: READY FOR PHYSICAL VALIDATION
================================================================================
```
