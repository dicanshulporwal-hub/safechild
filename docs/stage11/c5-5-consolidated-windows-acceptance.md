# SafeBrowse C.5.5 — Consolidated Windows Acceptance Plan

Baseline: Gate A physical build from commit `97392bf992731fae3dd54ac0bd241fcbd5867f4a`.
Remediation branch: `fix/c5.5-physical-validation-ux`.

## Confirmed physical findings retained

- D01 helper recovery: fixed in Gate A code; physical recovery retest still required.
- D02 Parent Management Lock: fail-closed behavior and correct-PIN unlock physically passed.
- D04 uninstall network restoration: physical uninstall retest remains mandatory and must be last.
- D05 YouTube Restricted Mode enforcement gap: pending Gate B.
- D06 control-plane exemption gap: pending Gate B.
- D07 screen-time/app quota live-sync gap: pending Gate B.
- D08 Windows APP quota portal label says Android Native App: pending UX fix.
- D09 process limiter observability gap: pending telemetry work.
- D10 Ask Parent opens a new tab/window: pending UX improvement.
- D11 child-visible localhost block URL: pending branded UX improvement without TLS MITM.
- D12 device page should visibly show Windows account to child mapping.
- D13 diagnostics claims must be limited to actually measured capabilities.
- D14 brief Wi-Fi reconnect timeout: observation, low priority.
- D15 wrong Parent PIN lacked visible feedback and attempt throttling.
- D16 paired device could transiently/stale-render the Connect This Computer landing screen.
- D17 account management uses a separate elevated window and needs a clearer, more coherent UX.
- D18 account role/mapping presentation is ambiguous; saved vs automatic bypass must be explicit.

## Changes in this remediation branch

1. Parent PIN authentication now reports remaining attempts.
2. Three consecutive incorrect PINs trigger a 60-second local verification lockout.
3. The PIN modal shows errors inline and displays the lockout countdown.
4. Successful verification resets failed-attempt state.
5. Initial GUI status loading retries before showing onboarding, reducing stale Connect This Computer rendering on already-paired devices.
6. Added `scripts/windows-physical-validation.ps1` for repeatable read-only installed/post-uninstall evidence collection.

## Automated acceptance

Run the Windows agent test suite in CI. In particular, the Parent PIN suite must verify:

- no-PIN fail-closed behavior;
- wrong PIN returns 401 plus attempts remaining;
- third wrong PIN returns 429 and lockout metadata;
- correct PIN is rejected during lockout;
- correct PIN succeeds after lockout expiry;
- successful PIN creates a 5-minute SID-bound management session;
- Fast User Switching invalidates the management session.

## One-command physical evidence collection

Installed state:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-physical-validation.ps1 -Mode Installed -ExpectedCommit <COMMIT> -ExpectedExeSha256 <SHA256>
```

Post-uninstall state:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-physical-validation.ps1 -Mode PostUninstall
```

The script writes JSON and text reports under `Desktop\SafeBrowse-Validation` and returns exit code 2 when a hard check fails.

## Manual-only physical checks after the next MSI

These cannot be certified purely from CI and remain human/device checks:

1. Parent PIN/UAC presentation and usability.
2. Child session block page visibly appears after helper termination/recovery.
3. Fast User Switching between parent and child desktops.
4. Browser-visible Ask Parent flow and approval experience.
5. Sleep/wake and real Wi-Fi reconnect behavior.
6. Final MSI uninstall and confirmation that ordinary internet/DNS works without manual repair.

## Release rule

Do not classify the next build as physical PASS until the automated suite is green and the six manual-only checks above are completed. Uninstall/DNS restoration remains the final physical gate.