$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
  Write-Output 'Windows administrator approval is required to allow phone access.'
  $quotedScript = '"' + $PSCommandPath + '"'
  try {
    $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile', '-File', $quotedScript) -Wait -PassThru
    exit $elevated.ExitCode
  } catch {
    throw 'Administrator approval was not granted. The firewall rule was not changed.'
  }
}

$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$lanIp = (Get-NetIPAddress -InterfaceAlias 'WLAN' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)
if (-not $lanIp) { throw 'WLAN is not connected. Connect this computer to the same router as the phone.' }

$activeProfile = Get-NetConnectionProfile -InterfaceAlias 'WLAN' -ErrorAction Stop
$firewallProfile = Get-NetFirewallProfile -PolicyStore ActiveStore -Name $activeProfile.NetworkCategory
if ($firewallProfile.AllowLocalFirewallRules -eq $false) {
  throw 'A managed firewall policy prevents local allow rules. Ask the computer administrator to allow TCP 5173 and 8443 from the WLAN subnet.'
}

$ruleName = 'Inspection Platform - Phone Access'
$ruleGroup = 'InspectionPlatformLan'
$existing = Get-NetFirewallRule -Group $ruleGroup -ErrorAction SilentlyContinue
if ($existing) { $existing | Remove-NetFirewallRule }

$rule = New-NetFirewallRule -DisplayName $ruleName -Group $ruleGroup `
  -Direction Inbound -Action Allow -Enabled True -Profile Any `
  -Protocol TCP -LocalPort 5173,8443 -RemoteAddress LocalSubnet `
  -Program $nodeExe -InterfaceAlias 'WLAN' `
  -Description 'Allow this Node.js web service on ports 5173 and 8443 from the local WLAN subnet only.'

Write-Output "Firewall rule enabled: $($rule.DisplayName)"
Write-Output "Local connection guide: http://${lanIp}:5173/"
Write-Output "Secure workbench: https://${lanIp}:8443/"
