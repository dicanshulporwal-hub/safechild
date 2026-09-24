# SafeBrowse Stage 11 Step 4 Evidence Summary

This directory contains empirical verification artifacts, test run logs, and physical test execution traces for Stage 11 Step 4:

1. **`windows-run20-physical-validation-report.md`** (in `docs/stage11/`): Master physical verification report for Windows Run #20 (16/16 tests PASS, resolving P0-A, P0-B, and P0-C).
2. **`physical-test-checklist.md`**: Physical device test checklists and Run #20 16-point execution records.
3. **`pilot-test-log.json`**: Machine-readable test execution report with authoritative Run #20 SHA-256 digests and platform capabilities.
4. **`golden-flow-verification.md`**: 20-step parent-to-device registration, policy deployment, Ask Parent, temporary grant expiry, internet pause, and reboot persistence log.

### Authoritative Deliverable Digests (Run #20 & Step 4 Baseline)
- **Windows Pilot MSI (`SafeBrowseChild-Pilot.msi`):** `6ea50223a374f79d1be06f10a22fabb4025d904e9716a8a31ab9ae07f1547a27`
- **Windows Pilot Executable (`SafeBrowseChild-Pilot.exe`):** `1e00ac2ba5327385edfede5acda38edc440e0bf0e5e3f1b8d59b179c4429d003`
- **Windows Service Host (`SafeBrowseServiceHost.exe`):** `510eacd3d42ba148f061a4fb51d55ceb65753262876b53f87574bef3eb8e35c2`
- **Android APK (`safebrowse-child-pilot.apk`):** `df58d8c6a673d872360bc11c0dd008422909d7a235e335edd007fd12a1e43a40`
