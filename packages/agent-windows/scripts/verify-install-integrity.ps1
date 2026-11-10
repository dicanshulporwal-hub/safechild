<#
.SYNOPSIS
    SafeBrowse Windows Pilot Post-Install Integrity & Upgrade Verification Script
.DESCRIPTION
    Verifies that the SafeBrowse Windows Pilot installation/upgrade is healthy, all required
    binaries exist, file hashes match the release manifest, SCM service is Running/Automatic,
    backend service worker is running, and GUI server on localhost:8885 is responsive.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "C:\Program Files\SafeBrowse",
    [string]$ManifestPath = ""
)

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "SafeBrowse Windows Pilot Post-Install Integrity Check" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$passed = $true

# 1. Verify all required binaries exist
$requiredFiles = @(
    "SafeBrowseChild-Pilot.exe",
    "SafeBrowseServiceHost.exe",
    "SafeBrowseUserHelper.exe",
    "SafeBrowseGuiLauncher.exe",
    "SafeBrowse-Pair.cmd",
    "SafeBrowse-EmergencyRestore.cmd",
    "scripts\configure-dns.ps1",
    "scripts\restore-dns.ps1"
)

Write-Host "`n[1/5] Verifying Installed Files in '$InstallDir'..." -ForegroundColor Yellow
foreach ($file in $requiredFiles) {
    $filePath = Join-Path $InstallDir $file
    if (Test-Path $filePath) {
        $size = (Get-Item $filePath).Length
        $version = (Get-Item $filePath).VersionInfo.FileVersion
        Write-Host "  [OK] $file exists (Size: $size bytes, FileVersion: $version)" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Missing required file: $file" -ForegroundColor Red
        $passed = $false
    }
}

# 2. Verify SHA-256 Hashes against Manifest (if manifest available)
Write-Host "`n[2/5] Verifying SHA-256 Hashes against Manifest..." -ForegroundColor Yellow
if (-not $ManifestPath) {
    $candidateManifests = @(
        (Join-Path $PSScriptRoot "SHA256SUMS.txt"),
        (Join-Path $InstallDir "SHA256SUMS.txt"),
        (Join-Path $PWD "SHA256SUMS.txt")
    )
    foreach ($c in $candidateManifests) {
        if (Test-Path $c) { $ManifestPath = $c; break }
    }
}

if ($ManifestPath -and (Test-Path $ManifestPath)) {
    Write-Host "  Reading manifest from: $ManifestPath"
    $manifestLines = Get-Content $ManifestPath
    foreach ($file in @("SafeBrowseChild-Pilot.exe", "SafeBrowseServiceHost.exe", "SafeBrowseUserHelper.exe", "SafeBrowseGuiLauncher.exe")) {
        $filePath = Join-Path $InstallDir $file
        if (Test-Path $filePath) {
            $actualHash = (Get-FileHash -Algorithm SHA256 -Path $filePath).Hash
            $expectedLine = $manifestLines | Where-Object { $_ -match "\*$file" -or $_ -match "\s$file$" } | Select-Object -First 1
            if ($expectedLine) {
                $expectedHash = ($expectedLine -split '\s+')[0].Trim().ToUpper()
                if ($actualHash.ToUpper() -eq $expectedHash) {
                    Write-Host "  [OK] $file SHA-256 matches manifest ($actualHash)" -ForegroundColor Green
                } else {
                    Write-Host "  [FAIL] $file SHA-256 mismatch!`n    Actual  : $actualHash`n    Expected: $expectedHash" -ForegroundColor Red
                    $passed = $false
                }
            } else {
                Write-Host "  [WARN] No manifest entry found for $file (Actual: $actualHash)" -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host "  [NOTE] SHA256SUMS.txt manifest not found in script or install directory. Skipping hash verification." -ForegroundColor Yellow
}

# 3. Verify SCM Service Configuration and Status
Write-Host "`n[3/5] Verifying SafeBrowseChildService in Service Control Manager..." -ForegroundColor Yellow
$service = Get-Service -Name "SafeBrowseChildService" -ErrorAction SilentlyContinue
$cimService = Get-CimInstance win32_service -Filter "Name = 'SafeBrowseChildService'" -ErrorAction SilentlyContinue

if ($service -and $cimService) {
    Write-Host "  Service Status   : $($service.Status)"
    Write-Host "  Start Mode       : $($cimService.StartMode)"
    Write-Host "  Executable Path  : $($cimService.PathName)"

    if ($cimService.StartMode -ne "Auto") {
        Write-Host "  [FAIL] Service StartMode is '$($cimService.StartMode)' (Expected 'Auto')" -ForegroundColor Red
        $passed = $false
    } else {
        Write-Host "  [OK] Service StartMode is Automatic" -ForegroundColor Green
    }

    if ($service.Status -ne "Running") {
        Write-Host "  [WARN] Service Status is '$($service.Status)'. Attempting to start..." -ForegroundColor Yellow
        Start-Service -Name "SafeBrowseChildService" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        $service.Refresh()
    }

    if ($service.Status -eq "Running") {
        Write-Host "  [OK] SafeBrowseChildService is Running" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] SafeBrowseChildService could not be started (Status: $($service.Status))" -ForegroundColor Red
        $passed = $false
    }
} else {
    Write-Host "  [FAIL] SafeBrowseChildService is not registered in Windows SCM!" -ForegroundColor Red
    $passed = $false
}

# 4. Verify Service Worker Process (SafeBrowseChild-Pilot.exe service)
Write-Host "`n[4/5] Verifying SafeBrowseChild-Pilot Service Worker Process..." -ForegroundColor Yellow
$workerProcs = Get-Process -Name "SafeBrowseChild-Pilot" -ErrorAction SilentlyContinue
if ($workerProcs) {
    foreach ($p in $workerProcs) {
        Write-Host "  [OK] Running SafeBrowseChild-Pilot worker process (PID: $($p.Id), WorkingSet: $([Math]::Round($p.WorkingSet64 / 1MB, 2)) MB)" -ForegroundColor Green
    }
} else {
    Write-Host "  [FAIL] No running SafeBrowseChild-Pilot worker process detected!" -ForegroundColor Red
    $passed = $false
}

# 5. Verify Localhost GUI Server (http://127.0.0.1:8885)
Write-Host "`n[5/5] Verifying http://127.0.0.1:8885 HTTP Endpoints..." -ForegroundColor Yellow
try {
    # Check dedicated lightweight health endpoint
    $healthRes = Invoke-WebRequest -Uri "http://127.0.0.1:8885/api/health" -UseBasicParsing -TimeoutSec 5
    if ($healthRes.StatusCode -eq 200) {
        Write-Host "  [OK] 127.0.0.1:8885/api/health responded with HTTP 200 OK" -ForegroundColor Green
        Write-Host "  Health Payload: $($healthRes.Content.Trim())"
    } else {
        Write-Host "  [FAIL] 127.0.0.1:8885/api/health responded with HTTP $($healthRes.StatusCode)" -ForegroundColor Red
        $passed = $false
    }

    $res = Invoke-WebRequest -Uri "http://127.0.0.1:8885/api/status" -UseBasicParsing -TimeoutSec 15
    if ($res.StatusCode -eq 200) {
        Write-Host "  [OK] 127.0.0.1:8885/api/status responded with HTTP 200 OK" -ForegroundColor Green
        $preview = if ($res.Content.Length -gt 120) { $res.Content.Substring(0, 120) + "..." } else { $res.Content }
        Write-Host "  Status Payload: $preview"
    } else {
        Write-Host "  [FAIL] 127.0.0.1:8885/api/status responded with HTTP $($res.StatusCode)" -ForegroundColor Red
        $passed = $false
    }
} catch {
    Write-Host "  [FAIL] Failed to connect to http://127.0.0.1:8885 : $($_.Exception.Message)" -ForegroundColor Red
    $passed = $false
}

Write-Host "`n========================================================" -ForegroundColor Cyan
if ($passed) {
    Write-Host "INTEGRITY CHECK PASSED: Installation is fully intact and healthy." -ForegroundColor Green
    exit 0
} else {
    Write-Host "INTEGRITY CHECK FAILED: Deficiencies detected above." -ForegroundColor Red
    exit 1
}
