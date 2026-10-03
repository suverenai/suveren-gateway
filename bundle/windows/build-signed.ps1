#Requires -Version 5.1
<#
.SYNOPSIS
  Sign the Suveren gateway Windows installer kit with YOUR OWN code-signing
  certificate, then build and sign the .msi.

.DESCRIPTION
  Suveren ships this installer UNSIGNED (decision, Andreas, 2026-10-02: "we do
  not sell the software, so we do not sign it"). This script is what your own
  IT department runs, after verifying the kit's origin (see
  docs/windows-it-guide.md — sha256sum + `gh attestation verify`), to turn it
  into something your own systems trust:

    1. Sign every .exe / .dll / .node file in the unpacked payload — the
       Node.js runtime, and every connector's native modules (e.g.
       better-sqlite3's prebuilt binary). Strict policies (WDAC, AppLocker)
       check every loaded binary, not just the installer.
    2. Build the .msi from the (now-signed) payload + the WiX source.
    3. Sign the .msi itself.
    4. Write SHA256SUMS for everything produced.

  Requires:
    - A code-signing certificate already installed in a Windows certificate
      store (or a PFX — see -PfxPath), referenced by its SHA-1 thumbprint.
    - signtool.exe (Windows SDK — typically already present on a machine
      that does code signing; otherwise `winget install Microsoft.WindowsSDK`
      or use the one bundled with Visual Studio).
    - The WiX v5 CLI as a dotnet tool: `dotnet tool install --global wix --version 5.0.2`
      (requires the .NET SDK).

.PARAMETER Thumbprint
  SHA-1 thumbprint of the code-signing certificate to use (as shown by
  `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert`). Mutually exclusive
  with -PfxPath.

.PARAMETER PfxPath
  Path to a .pfx file containing the code-signing certificate + private key,
  as an alternative to a certificate already in a store. Requires -PfxPassword.

.PARAMETER PfxPassword
  Password for -PfxPath, as a SecureString. Prompted for if omitted.

.PARAMETER PayloadDir
  The unpacked payload directory (node\, gateway\, integrations\) from the
  release zip. Defaults to .\payload next to this script.

.PARAMETER WixSourceDir
  Directory containing Product.wxs. Defaults to .\wix next to this script.

.PARAMETER OutDir
  Where to write the signed .msi and SHA256SUMS. Defaults to .\out.

.PARAMETER TimestampUrl
  RFC 3161 timestamp server — makes the signature remain valid after the
  certificate itself expires. Defaults to DigiCert's public server.

.EXAMPLE
  .\build-signed.ps1 -Thumbprint 0123456789ABCDEF0123456789ABCDEF01234567

.EXAMPLE
  .\build-signed.ps1 -PfxPath .\our-cert.pfx
#>
[CmdletBinding(DefaultParameterSetName = 'Store')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Store')]
  [string]$Thumbprint,

  [Parameter(Mandatory = $true, ParameterSetName = 'Pfx')]
  [string]$PfxPath,

  [Parameter(ParameterSetName = 'Pfx')]
  [System.Security.SecureString]$PfxPassword,

  [string]$PayloadDir = (Join-Path $PSScriptRoot 'payload'),
  [string]$WixSourceDir = (Join-Path $PSScriptRoot 'wix'),
  [string]$OutDir = (Join-Path $PSScriptRoot 'out'),
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [string]$ProductVersion
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "${env:ProgramFiles}\Windows Kits\10\bin"
  )
  foreach ($root in $roots) {
    if (Test-Path $root) {
      $found = Get-ChildItem -Path $root -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  }
  throw "signtool.exe not found. Install the Windows SDK (winget install Microsoft.WindowsSDK) or Visual Studio Build Tools."
}

function Find-Wix {
  $cmd = Get-Command wix.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command wix -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "wix CLI not found. Install it with: dotnet tool install --global wix --version 5.0.2"
}

$signtool = Find-SignTool
$wix = Find-Wix
Write-Host "[build-signed] signtool: $signtool"
Write-Host "[build-signed] wix:      $wix"

if (-not (Test-Path $PayloadDir)) { throw "Payload dir not found: $PayloadDir" }
if (-not (Test-Path (Join-Path $WixSourceDir 'Product.wxs'))) { throw "Product.wxs not found under: $WixSourceDir" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $ProductVersion) {
  $gatewayPkg = Join-Path $PayloadDir 'gateway\package.json'
  if (Test-Path $gatewayPkg) {
    $ProductVersion = (Get-Content $gatewayPkg -Raw | ConvertFrom-Json).version
  } else {
    throw "Could not infer -ProductVersion (no $gatewayPkg) — pass it explicitly."
  }
}
Write-Host "[build-signed] product version: $ProductVersion"

# ─── signtool invocation, shared by every file we sign ──────────────────

function Invoke-Sign {
  param([string[]]$Paths)
  if ($Paths.Count -eq 0) { return }
  $certArgs = if ($PSCmdlet.ParameterSetName -eq 'Pfx') {
    $pw = $PfxPassword
    if (-not $pw) { $pw = Read-Host -AsSecureString "Password for $PfxPath" }
    $plain = [System.Net.NetworkCredential]::new('', $pw).Password
    @('/f', $PfxPath, '/p', $plain)
  } else {
    @('/sha1', $Thumbprint)
  }
  $args = @('sign') + $certArgs + @('/fd', 'sha256', '/tr', $TimestampUrl, '/td', 'sha256') + $Paths
  & $signtool @args
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed (exit $LASTEXITCODE) for: $($Paths -join ', ')" }
}

# ─── 1. Sign every .exe/.dll/.node inside the payload ────────────────────

Write-Host "[build-signed] signing payload binaries (.exe, .dll, .node) …"
# Native connectors (better-sqlite3 and similar) ship prebuilt binaries for
# EVERY platform under node_modules/**/prebuilds/<platform>-<arch>/*.node —
# not just Windows. signtool correctly refuses a macOS/Linux Mach-O/ELF
# "file format cannot be signed because it is not recognized" — exclude
# those up front instead of letting one unsignable file fail the whole
# batch (signtool invocations below are batched, see $batchSize).
$binaries = Get-ChildItem -Path $PayloadDir -Recurse -Include '*.exe', '*.dll', '*.node' -File |
  Where-Object { $_.FullName -notmatch '\\prebuilds\\(darwin|linux|linuxmusl)-' }
Write-Host "[build-signed]   found $($binaries.Count) file(s)"
# signtool accepts multiple files per invocation; batch to stay under the
# command-line length limit on machines with a lot of connectors installed.
$batchSize = 40
for ($i = 0; $i -lt $binaries.Count; $i += $batchSize) {
  $batch = $binaries[$i..([Math]::Min($i + $batchSize - 1, $binaries.Count - 1))].FullName
  Invoke-Sign -Paths $batch
}
Write-Host "[build-signed] payload binaries signed."

# ─── 2. Build the .msi from the (now-signed) payload ─────────────────────

$msiPath = Join-Path $OutDir 'suveren-gateway.msi'
$launcherSource = Join-Path $PSScriptRoot 'launcher.cmd'
if (-not (Test-Path $launcherSource)) {
  # The release zip ships the launcher at the payload root for convenience;
  # fall back there if this script is run from the zip's own layout.
  $launcherSource = Join-Path $PSScriptRoot '..\launcher.cmd'
}
Write-Host "[build-signed] building $msiPath …"
& $wix build (Join-Path $WixSourceDir 'Product.wxs') `
  -d "ProductVersion=$ProductVersion" `
  -d "PayloadDir=$PayloadDir" `
  -d "LauncherSource=$launcherSource" `
  -arch x64 `
  -out $msiPath
if ($LASTEXITCODE -ne 0) { throw "wix build failed (exit $LASTEXITCODE)" }

# ─── 3. Sign the .msi itself ──────────────────────────────────────────────

Write-Host "[build-signed] signing $msiPath …"
Invoke-Sign -Paths @($msiPath)

# ─── 4. SHA256SUMS ─────────────────────────────────────────────────────────

$sumsPath = Join-Path $OutDir 'SHA256SUMS'
Write-Host "[build-signed] writing $sumsPath …"
$lines = Get-ChildItem -Path $OutDir -File | Where-Object { $_.Name -ne 'SHA256SUMS' } | ForEach-Object {
  $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
  "$hash  $($_.Name)"
}
# LF line endings, not Set-Content's CRLF: `sha256sum -c` / `shasum -c` on
# macOS and Linux read the CR as part of the file name and report every file
# as missing.
[System.IO.File]::WriteAllText($sumsPath, (($lines -join "`n") + "`n"), [System.Text.Encoding]::ASCII)

Write-Host ""
Write-Host "[build-signed] done."
Write-Host "  MSI:        $msiPath"
Write-Host "  SHA256SUMS: $sumsPath"
