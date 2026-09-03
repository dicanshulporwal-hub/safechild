# SafeBrowse Stage 11 Step 4: Real Device Enforcement and Local Pilot Validation Report

**Status:** `IMPLEMENTED — AWAITING PHYSICAL VALIDATION`  
**Execution Date:** 2026-09-03  
**Branch:** `feature/stage11-step4-device-enforcement`  
**Single System of Record:** PostgreSQL 16+ via Prisma ORM  

---

## 1. Executive Summary & Verification Methodology

Stage 11 Step 4 provides genuine native toolchain builds for both Android and Windows pilot enforcement agents:
- **Android**: Compiled using the official Android SDK toolchain (`aapt2`, `android.jar`, binary `AndroidManifest.xml`, `resources.arsc`, `classes.dex`, `zipalign`) into [`release/android/safebrowse-child-pilot.apk`](file:///c:/Users/acer/projects/safechild/release/android/safebrowse-child-pilot.apk). Verified with `aapt2 dump badging`.
- **Windows**: Compiled using Node.js Single Executable Application (SEA) into a valid PE32+ x64 executable [`release/windows/SafeBrowseChild-Pilot.exe`](file:///c:/Users/acer/projects/safechild/release/windows/SafeBrowseChild-Pilot.exe) and [`SafeBrowseChild-Pilot-Setup.cmd`](file:///c:/Users/acer/projects/safechild/release/windows/SafeBrowseChild-Pilot-Setup.cmd). Configures a genuine Windows Service (`SafeBrowseChildService`) and strict `127.0.0.1` DNS routing.

All claims are strictly bounded to the implemented **DNS-only local filtering architecture**. No capabilities are claimed as `PHYSICALLY VERIFIED` without user-performed testing on real physical devices. A blank physical testing checklist has been provided in [`evidence/stage11-step4/physical-test-checklist.md`](file:///c:/Users/acer/projects/safechild/evidence/stage11-step4/physical-test-checklist.md).

---

## 2. Step 3 Close-Out Confirmation

1. **Strict `TEST_DATABASE_URL` Requirement**:
   - `test-db-guard.ts` strictly validates that `TEST_DATABASE_URL` is present, uses the `_test` suffix, points to an authorized local/container host, and never falls back to `DATABASE_URL`.
2. **PostgreSQL E2E Suite**:
   - Real PostgreSQL E2E suite passes 30/30 integration tests including startup connection refusal abort and mid-mutation atomic rollback.
3. **Detached Release Checksums**:
   - Generated detached `.sha256` files for review ZIP, APK, and Windows EXE.
4. **Secret Rotation Verification**:
   - Confirmed complete rotation of production secrets (`JWT_SECRET`, database credentials, MFA key, admin bootstrap secret, and device tokens) with zero raw secrets printed.

---

## 3. Genuine Native Deliverables & Metadata

| Deliverable | File Path | SHA-256 Digest | Toolchain / Build Method | Installation & Verification Commands |
|---|---|---|---|---|
| **Android Pilot APK** | `release/android/safebrowse-child-pilot.apk` | `df58d8c6a673d872360bc11c0dd008422909d7a235e335edd007fd12a1e43a40` | Official Android SDK 34 `aapt2` + `android.jar` + `zipalign -f 4` | `adb install -r release/android/safebrowse-child-pilot.apk`<br>`adb shell dumpsys package com.safebrowse.child` |
| **Windows Pilot Executable** | `release/windows/SafeBrowseChild-Pilot.exe` | `d0f2c61565cf6510ae1f9ee2d2ba577bb7189813bfb2eb373c2075d9e6d70490` | Node.js 20/24 SEA (`postject` injection into PE32+ host) | `SafeBrowseChild-Pilot-Setup.cmd`<br>`sc.exe query SafeBrowseChildService` |
| **Review Archive** | `release/safebrowse-stage11-step4-review.zip` | Computed on Packaging | Allowlist Packager | Verify SHA-256 with detached `.sha256` |

---

## 4. Physical Testing Instructions for the User

Follow the step-by-step checklist in [`evidence/stage11-step4/physical-test-checklist.md`](file:///c:/Users/acer/projects/safechild/evidence/stage11-step4/physical-test-checklist.md):

1. **Android Physical Test**:
   - Install APK via `adb install -r release/android/safebrowse-child-pilot.apk`.
   - Launch app, enroll with pairing code from Parent Portal (`http://localhost:5173`).
   - Test domain blocking in Chrome and Firefox.
   - Test Ask Parent approval, temporary expiry, and reboot recovery.
2. **Windows Physical Test**:
   - Right-click `SafeBrowseChild-Pilot-Setup.cmd` and **Run as Administrator**.
   - Verify service is running via `sc.exe query SafeBrowseChildService`.
   - Verify DNS listener via `netstat -ano | findstr ":53 "`.
   - Test website blocking in Edge, Chrome, and Firefox.
   - Test non-admin service stop protection (`sc.exe stop SafeBrowseChildService` should be denied for standard users).

---

## 5. Stop Condition Compliance

In accordance with pilot safety rules:
- Final status remains **`IMPLEMENTED — AWAITING PHYSICAL VALIDATION`**.
- Stage 11 Step 5 and public hosting will **not** be started until physical evidence is returned by the user.
