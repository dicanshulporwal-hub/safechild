<#
.SYNOPSIS
  Restores Windows network adapters to automatic DHCP DNS configuration.
#>

Write-Host "🔄 Restoring Windows Network Adapters to DHCP DNS..." -ForegroundColor Cyan

$adapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" }

foreach ($adapter in $adapters) {
    Write-Host "Restoring adapter: $($adapter.Name)..." -ForegroundColor Yellow
    try {
        Set-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -ResetServerAddresses
        Write-Host "✅ Reset DNS on $($adapter.Name) to DHCP" -ForegroundColor Green
    } catch {
        Write-Warning "Could not restore $($adapter.Name): $_"
    }
}

Clear-DnsClientCache
Write-Host "✨ Windows DNS Cache Flushed." -ForegroundColor Green
