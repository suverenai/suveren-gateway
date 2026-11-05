<#
.SYNOPSIS
  CI only: wait for the gateway's /health and assert which bundled connectors run
  in the gateway's current mode.

.DESCRIPTION
  A gateway is simulation OR production, never both (0.41.3):
    production : records-mcp (no simulation mode) runs with tools; crm-mcp and
                 erp-mcp (default mode "simulation") are paused —
                 running=false, paused='production', no error.
    simulation : crm-mcp and erp-mcp run with tools; records-mcp is paused —
                 running=false, paused='simulation', no error.
  "paused" is the mode working as designed; an `error` on a paused entry is a
  real start failure and fails the check. Prints the final /health body, throws
  "<Label>: ..." on the first violation. Not shipped in the installer or the
  signing kit.
#>
param(
  [Parameter(Mandatory)][string]$Label,
  [Parameter(Mandatory)][ValidateSet('production', 'simulation')][string]$Mode,
  [string]$McpPort = '3430',
  [string]$ControlPlanePort = '',   # when set, the control plane's /health must also answer status 'ok'
  [int]$TimeoutSec = 240,
  [string]$Hint = ''
)
$ErrorActionPreference = 'Stop'

$running = if ($Mode -eq 'production') { @('records') } else { @('crm', 'erp') }
$paused  = if ($Mode -eq 'production') { @('crm', 'erp') } else { @('records') }

function Test-Expected($body) {
  foreach ($id in $running) {
    $e = $body.integrations | Where-Object { $_.id -eq $id }
    if (-not $e -or -not $e.running -or $e.toolCount -le 0) { return $false }
  }
  foreach ($id in $paused) {
    $e = $body.integrations | Where-Object { $_.id -eq $id }
    if (-not $e -or $e.running -or $e.paused -ne $Mode) { return $false }
  }
  return $true
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$body = $null
$cpOk = -not $ControlPlanePort
while ((Get-Date) -lt $deadline) {
  try {
    if (-not $cpOk) {
      $cp = Invoke-RestMethod -Uri "http://localhost:$ControlPlanePort/health" -TimeoutSec 5
      $cpOk = ($cp.status -eq 'ok')
    }
    if ($cpOk) {
      $body = Invoke-RestMethod -Uri "http://localhost:$McpPort/health" -TimeoutSec 5
      if (Test-Expected $body) { break }
    }
  } catch {}
  Start-Sleep -Seconds 3
}
if (-not $cpOk) { throw "${Label}: the control plane's /health on port $ControlPlanePort never reported status 'ok' within ${TimeoutSec}s (the UI half did not come up)" }
if (-not $body) { throw "${Label}: the gateway's /health on port $McpPort never answered within ${TimeoutSec}s" }
Write-Host ($body | ConvertTo-Json -Depth 5)

foreach ($id in $running) {
  $e = $body.integrations | Where-Object { $_.id -eq $id }
  if (-not $e) { throw "${Label}: $id not in the integration registry ($Mode mode)$Hint" }
  if (-not $e.running) { throw "${Label}: $id registered but not running in $Mode mode (paused='$($e.paused)', error='$($e.error)')$Hint" }
  if ($e.toolCount -le 0) { throw "${Label}: $id running but discovered 0 tools in $Mode mode" }
}
foreach ($id in $paused) {
  $e = $body.integrations | Where-Object { $_.id -eq $id }
  if (-not $e) { throw "${Label}: $id not in the integration registry ($Mode mode)$Hint" }
  if ($e.running) { throw "${Label}: $id is running in $Mode mode — it must be paused ('$Mode') because a gateway is simulation OR production, never both" }
  if ($e.paused -ne $Mode) { throw "${Label}: $id is not running and not paused by the mode (paused='$($e.paused)', error='$($e.error)') — expected paused='$Mode'" }
  if ($e.error) { throw "${Label}: $id is paused but carries an error: $($e.error)" }
}
$what = if ($Mode -eq 'production') { "records running ($(($body.integrations | Where-Object id -eq 'records').toolCount) tools), crm + erp paused (production)" }
        else { "crm + erp running, records paused (simulation)" }
Write-Host "${Label}: $Mode mode confirmed — $what"
