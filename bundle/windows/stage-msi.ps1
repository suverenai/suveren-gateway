<#
.SYNOPSIS
  Stage a payload for the MSI: the bulky node_modules trees go into ONE archive.

.DESCRIPTION
  Windows Installer registers, copies and (on upgrade/uninstall) removes every
  file one by one. With the connectors' and the gateway's node_modules shipped
  as loose files (~18,000 after pruning) an upgrade took ~4 minutes. This script
  copies the payload into a staging directory, but packs `integrations\` and
  `gateway\node_modules\` into a single `runtime.zip` (plus `runtime.stamp`, its
  SHA-256). The launcher unpacks it on the first start after an install or
  upgrade (`suveren-gateway.cmd prepare`, see launcher.cmd) and only compares the
  stamp afterwards.

  Run AFTER signing: build-signed.ps1 signs every .exe/.dll/.node in the
  unpacked payload first, so the binaries inside the archive carry the
  signature IT applied. Used by build-signed.ps1 and by the CI workflow, so the
  shipped msi and IT's re-signed msi are staged identically.

.PARAMETER PayloadDir
  The unpacked payload (node\, gateway\, integrations\) from build-payload.mjs.

.PARAMETER StageDir
  Output directory, recreated. Pass it to `wix build -d PayloadDir=<StageDir>`.
#>
param(
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [Parameter(Mandatory = $true)][string]$StageDir
)
$ErrorActionPreference = 'Stop'

$PayloadDir = (Resolve-Path $PayloadDir).Path
foreach ($required in @('node', 'gateway', 'integrations')) {
  if (-not (Test-Path (Join-Path $PayloadDir $required))) { throw "payload is missing $required\ ($PayloadDir)" }
}

if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
$StageDir = (Resolve-Path $StageDir).Path

# Loose files: node\ and gateway\ without its node_modules.
Copy-Item -Recurse (Join-Path $PayloadDir 'node') (Join-Path $StageDir 'node')
$gwSrc = Join-Path $PayloadDir 'gateway'
$gwDst = Join-Path $StageDir 'gateway'
New-Item -ItemType Directory -Force -Path $gwDst | Out-Null
Get-ChildItem -Force $gwSrc | Where-Object { $_.Name -ne 'node_modules' } |
  ForEach-Object { Copy-Item -Recurse $_.FullName (Join-Path $gwDst $_.Name) }

# One archive for the bulk. Windows' built-in tar (bsdtar) writes a zip with -a and
# reads it back on every supported Windows 10/11 — no extra tooling on the laptop.
$zip = Join-Path $StageDir 'runtime.zip'
Push-Location $PayloadDir
try {
  & tar.exe -a -c -f $zip integrations 'gateway/node_modules'
  if ($LASTEXITCODE -ne 0) { throw "tar failed creating $zip (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
$hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
Set-Content -Path (Join-Path $StageDir 'runtime.stamp') -Value $hash -NoNewline -Encoding ascii

$loose = (Get-ChildItem -Recurse -File $StageDir).Count
$packed = (Get-ChildItem -Recurse -File (Join-Path $PayloadDir 'integrations')).Count +
          (Get-ChildItem -Recurse -File (Join-Path $gwSrc 'node_modules') -ErrorAction SilentlyContinue).Count
Write-Host "[stage-msi] $loose files in the msi (incl. runtime.zip), $packed packed into runtime.zip ($([math]::Round((Get-Item $zip).Length / 1MB)) MB), stamp $hash"
