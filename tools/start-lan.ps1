$ErrorActionPreference = 'Stop'
$LanIp = (Get-NetIPAddress -InterfaceAlias 'WLAN' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$certDir = Join-Path $env:LOCALAPPDATA 'InspectionPlatform\lan-tls'
$caPath = Join-Path $projectRoot 'data\lan-ca.crt'
$caCert = Join-Path $certDir 'lan-ca.crt'
$caKey = Join-Path $certDir 'lan-ca.key.pem'
$serverCert = Join-Path $certDir 'server.crt'
$serverKey = Join-Path $certDir 'server.key.pem'
$serverCsr = Join-Path $certDir 'server.csr.pem'
$serverExt = Join-Path $certDir 'server.ext'

if (-not $LanIp) { throw 'No WLAN IPv4 address found. Connect this computer to the local network.' }
foreach ($path in @($caPath, $caCert, $caKey, $serverKey)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing startup file: $path" }
}

$runningServices = Get-NetTCPConnection -State Listen -LocalPort 3300,5173,8443 -ErrorAction SilentlyContinue
if (-not $runningServices) {
  $npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
  Push-Location $projectRoot
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
      Write-Output 'Installing project dependencies...'
      & $npmCmd ci
      if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    Write-Output 'Building the current project...'
    & $npmCmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Project build failed.' }
  } finally { Pop-Location }
} else {
  Write-Output 'A project port is already in use; the existing build will be used.'
}
foreach ($path in @((Join-Path $projectRoot 'apps\api\dist\server.js'), (Join-Path $projectRoot 'apps\admin-web\dist\index.html'))) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing built file: $path" }
}

$openssl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
if (-not (Test-Path -LiteralPath $openssl)) { throw "OpenSSL is required to renew the LAN certificate: $openssl" }
$renewCertificate = -not (Test-Path -LiteralPath $serverCert)
if (-not $renewCertificate) {
  $san = & $openssl x509 -in $serverCert -noout -ext subjectAltName
  if ($LASTEXITCODE -ne 0) { throw "Cannot inspect server certificate: $serverCert" }
  & $openssl x509 -in $serverCert -noout -checkend 86400 | Out-Null
  $expectedSan = "IP Address:$LanIp, IP Address:127.0.0.1, DNS:localhost"
  $renewCertificate = $LASTEXITCODE -ne 0 -or ($san -join ' ') -notlike "*$expectedSan*"
}
if ($renewCertificate) {
  @(
    'basicConstraints=critical,CA:FALSE'
    'keyUsage=critical,digitalSignature,keyEncipherment'
    'extendedKeyUsage=serverAuth'
    "subjectAltName=IP:$LanIp,IP:127.0.0.1,DNS:localhost"
  ) | Set-Content -LiteralPath $serverExt -Encoding Ascii
  & $openssl req -new -key $serverKey -subj "/CN=$LanIp" -out $serverCsr
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create the LAN server certificate request.' }
  & $openssl x509 -req -in $serverCsr -CA $caCert -CAkey $caKey -CAcreateserial -out $serverCert -days 397 -sha256 -extfile $serverExt
  if ($LASTEXITCODE -ne 0) { throw 'Cannot sign the LAN server certificate.' }
  & $openssl verify -CAfile $caCert -verify_ip $LanIp $serverCert
  if ($LASTEXITCODE -ne 0) { throw 'The new LAN server certificate failed verification.' }
  Write-Output "Renewed HTTPS certificate for $LanIp"
}

$nodeExe = (Get-Command node.exe).Source
function Start-NodeEndpoint($name, $address, $port, $script, $environment) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq $address } | Select-Object -First 1
  if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($process.CommandLine -notlike "*$script*") { throw "${address}:$port is in use by another program." }
    Write-Output "$name already running at ${address}:$port"
    return
  }

  $previous = @{}
  foreach ($key in $environment.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process')
  }
  try {
    $stderrPath = Join-Path $projectRoot "service-$name.stderr.log"
    $process = Start-Process -FilePath $nodeExe -ArgumentList $script -WorkingDirectory $projectRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $projectRoot "service-$name.stdout.log") `
      -RedirectStandardError $stderrPath -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      $ready = [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq $address -and $_.OwningProcess -eq $process.Id } |
        Select-Object -First 1)
      if ($ready) { break }
      if ($process.HasExited) { break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "$name failed to listen at ${address}:$port. Check $stderrPath" }
    Write-Output "$name started at ${address}:$port (PID $($process.Id))"
  } finally {
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  }
}

Start-NodeEndpoint 'api' '127.0.0.1' 3300 'apps/api/dist/server.js' @{ API_HOST = '127.0.0.1'; API_PORT = '3300' }
Start-NodeEndpoint 'web-local' '127.0.0.1' 5173 'tools/static-server.mjs' @{ WEB_HOST = '127.0.0.1'; WEB_PORT = '5173'; WEB_TLS_CERT = $null; WEB_TLS_KEY = $null; WEB_REDIRECT_HTTPS_PORT = $null; WEB_CA_CERT = $null }
Start-NodeEndpoint 'web-lan' $LanIp 5173 'tools/static-server.mjs' @{ WEB_HOST = $LanIp; WEB_PORT = '5173'; WEB_TLS_CERT = $null; WEB_TLS_KEY = $null; WEB_REDIRECT_HTTPS_PORT = '8443'; WEB_CA_CERT = $caPath }
if ($renewCertificate) {
  $oldHttps = Get-NetTCPConnection -State Listen -LocalPort 8443 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq $LanIp } | Select-Object -First 1
  if ($oldHttps) {
    $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($oldHttps.OwningProcess)"
    if ($oldProcess.CommandLine -notlike '*tools/static-server.mjs*') { throw "${LanIp}:8443 is in use by another program." }
    Stop-Process -Id $oldHttps.OwningProcess
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if (-not (Get-NetTCPConnection -State Listen -LocalPort 8443 -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq $LanIp })) { break }
      Start-Sleep -Milliseconds 250
    }
  }
}
Start-NodeEndpoint 'web-https' $LanIp 8443 'tools/static-server.mjs' @{ WEB_HOST = $LanIp; WEB_PORT = '8443'; WEB_TLS_CERT = $serverCert; WEB_TLS_KEY = $serverKey; WEB_REDIRECT_HTTPS_PORT = $null; WEB_CA_CERT = $caPath }

Write-Output "LAN URL: https://${LanIp}:8443/"
Write-Output "CA certificate: http://${LanIp}:5173/lan-ca.crt"
