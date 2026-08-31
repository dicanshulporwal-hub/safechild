<#
.SYNOPSIS
  Configures active Windows network adapters to route DNS queries to local SafeBrowse Proxy (127.0.0.1).
.DESCRIPTION
  Requires Administrator privileges.
#>

Write-Host "🛡️ Configuring Active Network Adapters for SafeBrowse Local DNS..." -ForegroundColor Cyan

$adapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" }

foreach ($adapter in $adapters) {
    Write-Host "Configuring adapter: $($adapter.Name) ($($adapter.InterfaceDescription))..." -ForegroundColor Yellow
    try {
        Set-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -ServerAddresses ("127.0.0.1", "1.1.1.1")
        Write-Host "✅ Set DNS on $($adapter.Name) to 127.0.0.1" -ForegroundColor Green
    } catch {
        Write-Warning "Could not configure $($adapter.Name): $_"
    }
}

# Flush DNS Cache
Clear-DnsClientCache
Write-Host "✨ Windows DNS Cache Flushed." -ForegroundColor Green
