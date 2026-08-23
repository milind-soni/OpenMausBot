# sign-win.ps1 — sign the built Windows artifacts with Authenticode.
#
# Usage (after `pnpm package:win`):
#   pwsh scripts/sign-win.ps1
#   pwsh scripts/sign-win.ps1 -Pfx build/omb-selfsigned.pfx -Password omb-test-2026
#
# For a REAL cert: pass -Pfx <real.pfx> -Password <real> (or set env
# OMB_CERT_FILE / OMB_PFX_PASSWORD). Requires the cert's private key.
#
# NOTE: a self-signed cert only proves the pipeline works. It still shows
# "unknown publisher" on machines that don't trust its root. Add the root to
# Trusted Root CAs (CurrentUser) once to validate locally:
#   $pfx = New-Object Security.Cryptography.X509Certificates.X509Certificate2($Pfx, $Password)
#   $s = New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser'); $s.Open('ReadWrite'); $s.Add($pfx); $s.Close()

param(
  [string]$Pfx = $env:OMB_CERT_FILE,
  [string]$Password = $env:OMB_PFX_PASSWORD,
  [string]$Thumbprint,
  [string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

if (-not $Pfx) { $Pfx = Join-Path $PSScriptRoot '..uild\omb-selfsigned.pfx' }
if (-not $Password) { $Password = 'omb-test-2026' }

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$ver = (node -p "require('./package.json').version" 2>$null)
if (-not $ver) { throw "Could not read package version from package.json" }

$installerPath = Join-Path $root "release\OpenMausBot-$ver-setup.exe"
$unpackedAppPath = Join-Path $root 'release\win-unpacked\OpenMausBot.exe'

$files = @($installerPath, $unpackedAppPath)

# Throw immediately if any of the required files are missing before signing
foreach ($f in $files) {
  if (-not (Test-Path $f)) {
    throw "Missing required build artifact for signing: $f"
  }
}

if ($Thumbprint) {
  $cert = Get-ChildItem "cert:\CurrentUser\My" | Where-Object { $_.Thumbprint -eq $Thumbprint }
  if (-not $cert) { throw "cert with thumbprint $Thumbprint not in CurrentUser\My" }
} else {
  $sec = ConvertTo-SecureString -String $Password -Force -AsPlainText
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($Pfx, $sec, 'PersistKeySet')
}

foreach ($f in $files) {
  $r = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -TimestampServer $TimestampServer
  Write-Host ("{0,-60} {1}" -f $f, $r.Status)
  if ($r.Status -ne 'Valid') { throw ("signing failed: " + $r.StatusMessage) }
}
Write-Host "done."
