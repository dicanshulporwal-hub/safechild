param(
  [ValidateSet('Installed','PostUninstall')] [string]$Mode = 'Installed',
  [string]$ExpectedCommit = '',
  [string]$ExpectedExeSha256 = '',
  [string]$OutputDirectory = "$env:USERPROFILE\Desktop\SafeBrowse-Validation"
)

$ErrorActionPreference = 'Continue'
$results = @()

function Add-Result([string]$Id,[string]$Name,[string]$Status,[string]$Observed,[string]$Expected) {
  $script:results += [pscustomobject]@{ Id=$Id; Name=$Name; Status=$Status; Observed=$Observed; Expected=$Expected }
}

function To-Text($Value) {
  if ($null -eq $Value) { return '' }
  return (($Value | Out-String).Trim())
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$jsonPath = Join-Path $OutputDirectory ("SafeBrowse-{0}-{1}.json" -f $Mode,$stamp)
$txtPath = Join-Path $OutputDirectory ("SafeBrowse-{0}-{1}.txt" -f $Mode,$stamp)
$exe = 'C:\Program Files\SafeBrowse\SafeBrowseChild-Pilot.exe'
$svcName = 'SafeBrowseChildService'

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Add-Result 'SYS01' 'Windows version' 'INFO' ("{0} {1} Build {2}" -f $os.Caption,$os.Version,$os.BuildNumber) 'Record only'
Add-Result 'SYS02' 'Current user' 'INFO' ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) 'Record only'

if ($Mode -eq 'Installed') {
  $svc = Get-Service $svcName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running' -and $svc.StartType -eq 'Automatic') { Add-Result 'I01' 'SafeBrowse service' 'PASS' ("{0} / {1}" -f $svc.Status,$svc.StartType) 'Running / Automatic' }
  elseif ($svc) { Add-Result 'I01' 'SafeBrowse service' 'FAIL' ("{0} / {1}" -f $svc.Status,$svc.StartType) 'Running / Automatic' }
  else { Add-Result 'I01' 'SafeBrowse service' 'FAIL' 'Service not found' 'Running / Automatic' }

  if (Test-Path $exe) {
    Add-Result 'I02' 'Installed agent binary' 'PASS' $exe 'File present'
    $hash = (Get-FileHash $exe -Algorithm SHA256).Hash
    if ($ExpectedExeSha256) {
      if ($hash -eq $ExpectedExeSha256.ToUpperInvariant()) { $hs='PASS' } else { $hs='FAIL' }
      Add-Result 'I03' 'Installed EXE SHA256' $hs $hash $ExpectedExeSha256.ToUpperInvariant()
    } else { Add-Result 'I03' 'Installed EXE SHA256' 'INFO' $hash 'No expected hash supplied' }
    try {
      $versionOutput = (& $exe --version 2>&1 | Out-String).Trim()
      $vs='INFO'
      if ($ExpectedCommit) { if ($versionOutput -match [regex]::Escape($ExpectedCommit.Substring(0,[Math]::Min(7,$ExpectedCommit.Length)))) { $vs='PASS' } else { $vs='FAIL' } }
      Add-Result 'I04' 'Agent build identity' $vs $versionOutput $(if ($ExpectedCommit) { 'Expected commit ' + $ExpectedCommit } else { 'Record only' })
    } catch { Add-Result 'I04' 'Agent build identity' 'FAIL' $_.Exception.Message 'Agent --version succeeds' }
  } else {
    Add-Result 'I02' 'Installed agent binary' 'FAIL' 'Not found' $exe
    Add-Result 'I03' 'Installed EXE SHA256' 'SKIP' 'Binary absent' 'Hash available'
    Add-Result 'I04' 'Agent build identity' 'SKIP' 'Binary absent' 'Agent --version succeeds'
  }

  $udp53 = @(Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1')
  Add-Result 'I05' 'Local DNS resolver' $(if ($udp53.Count -gt 0) {'PASS'} else {'FAIL'}) (To-Text $udp53) '127.0.0.1:53 listening'

  $adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up'
  $dnsRows = @()
  foreach ($a in $adapters) {
    $d = Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
    $dnsRows += [pscustomobject]@{ Adapter=$a.Name; Servers=($d.ServerAddresses -join ',') }
  }
  $hasLoopback = @($dnsRows | Where-Object Servers -match '127\.0\.0\.1').Count -gt 0
  Add-Result 'I06' 'Active adapter DNS enforcement' $(if ($hasLoopback) {'PASS'} else {'FAIL'}) (To-Text $dnsRows) 'At least one active protected adapter uses 127.0.0.1'

  try {
    $resolved = Resolve-DnsName www.microsoft.com -Type A -DnsOnly -ErrorAction Stop | Select-Object -First 1
    Add-Result 'I07' 'Allowed external DNS resolution' 'PASS' (To-Text $resolved) 'www.microsoft.com resolves'
  } catch { Add-Result 'I07' 'Allowed external DNS resolution' 'FAIL' $_.Exception.Message 'www.microsoft.com resolves' }

  $helpers = @(Get-Process SafeBrowseUserHelper -ErrorAction SilentlyContinue)
  Add-Result 'I08' 'User helper process count' 'INFO' ([string]$helpers.Count) 'Record current interactive helper count'

  $statePath = 'C:\ProgramData\SafeBrowse\state'
  foreach ($file in @('sanitized-config.json','profile-mappings.json','family-profiles-cache.json','active-session.json')) {
    $p = Join-Path $statePath $file
    Add-Result ('STATE-' + $file) ('State file: ' + $file) $(if (Test-Path $p) {'PASS'} else {'INFO'}) $(if (Test-Path $p) {'Present'} else {'Absent'}) 'Presence depends on onboarding stage'
  }

  try {
    $statusOutput = (& $exe --status 2>&1 | Out-String).Trim()
    Add-Result 'I09' 'Agent status command' 'PASS' $statusOutput 'Status command succeeds'
  } catch { Add-Result 'I09' 'Agent status command' 'FAIL' $_.Exception.Message 'Status command succeeds' }
}

if ($Mode -eq 'PostUninstall') {
  $svc = Get-Service $svcName -ErrorAction SilentlyContinue
  Add-Result 'U01' 'Service removed' $(if ($null -eq $svc) {'PASS'} else {'FAIL'}) $(if ($svc) {'Present: ' + $svc.Status} else {'Not found'}) 'Service absent'
  $sbProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object ProcessName -like 'SafeBrowse*')
  Add-Result 'U02' 'SafeBrowse processes removed' $(if ($sbProcesses.Count -eq 0) {'PASS'} else {'FAIL'}) (To-Text ($sbProcesses | Select-Object ProcessName,Id)) 'Zero SafeBrowse processes'
  $udp53 = @(Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1')
  Add-Result 'U03' 'Loopback DNS listener removed' $(if ($udp53.Count -eq 0) {'PASS'} else {'FAIL'}) (To-Text $udp53) 'No UDP 127.0.0.1:53 listener'

  $adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up'
  $dnsRows = @()
  foreach ($a in $adapters) {
    $d = Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
    $dnsRows += [pscustomobject]@{ Adapter=$a.Name; Servers=($d.ServerAddresses -join ',') }
  }
  $loopbackDns = @($dnsRows | Where-Object Servers -match '127\.0\.0\.1|::1')
  Add-Result 'U04' 'DNS restored away from loopback' $(if ($loopbackDns.Count -eq 0) {'PASS'} else {'FAIL'}) (To-Text $dnsRows) 'No active adapter uses loopback DNS'
  try {
    $resolved = Resolve-DnsName www.microsoft.com -Type A -DnsOnly -ErrorAction Stop | Select-Object -First 1
    Add-Result 'U05' 'Internet DNS after uninstall' 'PASS' (To-Text $resolved) 'External DNS resolves'
  } catch { Add-Result 'U05' 'Internet DNS after uninstall' 'FAIL' $_.Exception.Message 'External DNS resolves' }
  $rules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'SafeBrowse*' -or $_.Name -like 'SafeBrowse*' })
  Add-Result 'U06' 'SafeBrowse firewall rules removed' $(if ($rules.Count -eq 0) {'PASS'} else {'FAIL'}) (To-Text ($rules | Select-Object Name,DisplayName,Enabled)) 'Zero SafeBrowse-owned firewall rules'
}

$summary = [pscustomobject]@{ GeneratedAt=(Get-Date).ToString('o'); Mode=$Mode; ComputerName=$env:COMPUTERNAME; Pass=@($results | Where-Object Status -eq 'PASS').Count; Fail=@($results | Where-Object Status -eq 'FAIL').Count; Info=@($results | Where-Object Status -eq 'INFO').Count; Skip=@($results | Where-Object Status -eq 'SKIP').Count; Results=$results }
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding UTF8
$text = @('SafeBrowse Windows Physical Validation',('Generated: ' + $summary.GeneratedAt),('Mode: ' + $Mode),('Computer: ' + $env:COMPUTERNAME),('PASS={0} FAIL={1} INFO={2} SKIP={3}' -f $summary.Pass,$summary.Fail,$summary.Info,$summary.Skip),'')
foreach ($item in $results) { $text += ('[{0}] {1} - {2}' -f $item.Status,$item.Id,$item.Name); $text += ('  Observed: ' + (($item.Observed -replace '[\r\n]+',' | '))); $text += ('  Expected: ' + $item.Expected) }
$text | Set-Content -Path $txtPath -Encoding UTF8
Write-Host ''
Write-Host '=== SafeBrowse Validation Summary ==='
Write-Host ('PASS={0} FAIL={1} INFO={2} SKIP={3}' -f $summary.Pass,$summary.Fail,$summary.Info,$summary.Skip)
Write-Host ('JSON: ' + $jsonPath)
Write-Host ('TEXT: ' + $txtPath)
if ($summary.Fail -gt 0) { exit 2 }
exit 0