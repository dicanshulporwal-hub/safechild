<#
.SYNOPSIS
  SafeBrowse Windows Network & DNS Restoration Script
  Guarantees full emergency restoration of network DNS, firewall rules, and terminates helper instances.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "SafeBrowse Emergency Network & DNS Restoration" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Stop SafeBrowseChildService and terminate all SafeBrowse UserHelper instances
Write-Host "[Step 1/6] Stopping SafeBrowseChildService and UserHelper instances..." -ForegroundColor Yellow
try {
    Stop-Service -Name "SafeBrowseChildService" -Force -ErrorAction SilentlyContinue
    Write-Host " [OK] SafeBrowseChildService stopped." -ForegroundColor Green
} catch {}
try {
    Stop-Process -Name "SafeBrowseUserHelper" -Force -ErrorAction SilentlyContinue
    Write-Host " [OK] SafeBrowse UserHelper processes stopped." -ForegroundColor Green
} catch {
    Write-Warning "Notice stopping UserHelper: $_"
}

# 2. Remove SafeBrowse-owned firewall rules
Write-Host "[Step 2/6] Removing SafeBrowse-owned firewall rules..." -ForegroundColor Yellow
$sbRules = @('SafeBrowse_Block_DoT_853_TCP', 'SafeBrowse_Block_DoT_853_UDP', 'SafeBrowse_Block_DoH_Bootstrap')
foreach ($r in $sbRules) {
    try {
        netsh advfirewall firewall delete rule name=$r | Out-Null
    } catch {}
}
Write-Host " [OK] SafeBrowse firewall rules removed." -ForegroundColor Green

# 3. Restore DNS from secure backup or DHCP
Write-Host "[Step 3/6] Restoring network adapters from backup or DHCP..." -ForegroundColor Yellow
$programData = $env:ProgramData
if (-not $programData) { $programData = "C:\ProgramData" }
$backupPath = Join-Path $programData "SafeBrowse\secure\network-backup.json"
if (-not (Test-Path $backupPath)) {
    $backupPath = Join-Path $programData "SafeBrowse\network-backup.json"
}

$restoredFromBackup = $false
if (Test-Path $backupPath) {
    try {
        $raw = Get-Content $backupPath -Raw -ErrorAction Stop
        $records = ConvertFrom-Json $raw -ErrorAction Stop
        $items = @($records)
        foreach ($rec in $items) {
            if ($rec.InterfaceIndex) {
                $idx = [int]$rec.InterfaceIndex
                $cleanAddrs = @($rec.ServerAddresses) | Where-Object { $_ -and $_ -notlike '*127.0.0.1*' -and $_ -notlike '*::1*' }
                if ($rec.DhcpEnabled -eq $true -or $cleanAddrs.Count -eq 0) {
                    Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction SilentlyContinue
                    Write-Host " [OK] Reset adapter $idx to DHCP." -ForegroundColor Green
                } else {
                    Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $cleanAddrs -ErrorAction SilentlyContinue
                    Write-Host " [OK] Restored static DNS for adapter $idx: $($cleanAddrs -join ', ')" -ForegroundColor Green
                }
                $restoredFromBackup = $true
            }
        }
    } catch {
        Write-Warning "Could not parse backup file: $_"
    }
}

if (-not $restoredFromBackup) {
    Write-Host " No valid backup found. Resetting trapped adapters on 127.0.0.1 to DHCP..." -ForegroundColor Yellow
    $trapped = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses -contains '127.0.0.1' })
    $routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' })
    $routeIndexes = @($routes | ForEach-Object { [int]$_.InterfaceIndex })
    foreach ($t in $trapped) {
        $idx = [int]$t.InterfaceIndex
        if ($routeIndexes -contains $idx) {
            Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction SilentlyContinue
            Write-Host " [OK] Reset trapped adapter $idx ($($t.InterfaceAlias)) to DHCP." -ForegroundColor Green
        }
    }
}

# 4. Flush DNS client cache
Write-Host "[Step 4/6] Flushing Windows DNS client cache..." -ForegroundColor Yellow
Clear-DnsClientCache -ErrorAction SilentlyContinue
try { ipconfig /flushdns | Out-Null } catch {}
Write-Host " [OK] Windows DNS cache flushed." -ForegroundColor Green

# 5. Read-back DNS configuration verification
Write-Host "[Step 5/6] Verifying no active adapter remains trapped at 127.0.0.1..." -ForegroundColor Yellow
$trappedPost = @()
$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' })
$routeIndexes = @($routes | ForEach-Object { [int]$_.InterfaceIndex })
$dnsConfigs = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)
foreach ($d in $dnsConfigs) {
    $idx = [int]$d.InterfaceIndex
    if ($routeIndexes -contains $idx) {
        $addrs = @($d.ServerAddresses)
        if ($addrs -contains '127.0.0.1' -or $addrs -contains '::1') {
            $trappedPost += [PSCustomObject]@{ InterfaceIndex = $idx; Alias = $d.InterfaceAlias; Servers = $addrs }
        }
    }
}

if ($trappedPost.Count -gt 0) {
    Write-Error "CRITICAL: DNS read-back verification FAILED. Adapter(s) remain trapped at 127.0.0.1:"
    $trappedPost | ForEach-Object { Write-Error " - Adapter $($_.InterfaceIndex) ($($_.Alias)): $($_.Servers -join ', ')" }
    exit 1
}
Write-Host " [OK] Read-back verification PASSED: Zero active adapters trapped at 127.0.0.1." -ForegroundColor Green

# 6. Verify external DNS resolution
Write-Host "[Step 6/6] Verifying external DNS resolution..." -ForegroundColor Yellow
$resolved = $false
foreach ($domain in @('cloudflare.com', 'google.com', 'microsoft.com')) {
    try {
        $r = Resolve-DnsName -Name $domain -Type A -QuickTimeout -ErrorAction Stop
        if ($r) { $resolved = $true; break }
    } catch {}
}

if (-not $resolved) {
    Write-Error "CRITICAL: External DNS resolution probe FAILED. Cannot resolve test domains."
    exit 1
}
Write-Host " [OK] External DNS resolution verified successfully." -ForegroundColor Green

Write-Host "======================================================================" -ForegroundColor Green
Write-Host "SafeBrowse network restoration complete and verified." -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
exit 0
