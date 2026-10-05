# Reference copy — readable and documented — of the logic Product.wxs's
# StopGateway custom action actually
# run INLINE (via `powershell.exe -Command`, not `-File` against this file).
# They can't call this file directly: StopGateway runs before
# RemoveExistingProducts, which — for a brand-new install — is before any
# file this package ships has even been copied to INSTALLFOLDER, and for the
# exact scenario it exists to fix (upgrading FROM an older release) the OLD
# install never shipped this file at all. The inline version depends on
# nothing but powershell.exe itself and the INSTALLFOLDER property, so this
# file is not part of the installed payload — it's kept here purely so the
# logic has one readable, commented home, and so IT can run it by hand
# (`powershell -File stop-gateway.ps1 -InstallFolder "$env:LOCALAPPDATA\
# Programs\Suveren"`) to stop a stuck gateway without reaching for Task
# Manager. Keep the two in sync by hand if either changes.
#
# Stop every gateway process belonging to THIS install, reliably. Both ways
# the gateway can be running need the SAME robust stop, because neither is
# covered by the other:
#
#   - `launcher.cmd stop` (the CLI's own `stop`) only knows how to stop an
#     instance started via `start --detach`, which writes a PID file. A
#     gateway started by the Windows Task Scheduler task (`launcher.cmd run`
#     -> server.js directly, no PID file — see launcher.cmd's `run_foreground`
#     label) makes the CLI print "suveren-gateway is running under the login
#     service, which this command does not manage" and exit WITHOUT stopping
#     anything — confirmed with the same CLI on macOS, and the actual cause
#     of a Windows installer upgrade hanging forever at "Please wait while
#     Windows configures Suveren Gateway": node.exe (bundled, under
#     INSTALLFOLDER) stayed locked while Windows Installer tried to replace
#     it, and ending the process in Task Manager let the stuck install
#     continue — confirmed on a real Windows 11 VM.
#   - Ending the scheduled task's current run (`schtasks /End`) does nothing
#     for an instance started interactively (`start --detach` / the Start
#     Menu's `open-ui`) — there IS no task run to end.
#
# So: always try both, and ALSO kill by executable path (every one of
# server.js, its control-plane child, and its mcp-server child run the exact
# same bundled node.exe — see bundle/server.js's spawn calls — so filtering
# on "this install's own node.exe" catches every process in the tree
# regardless of which of the two ways it was started).
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallFolder
)

$ErrorActionPreference = 'SilentlyContinue'

# Ends the task's CURRENT run if one is active. Does nothing (silently) if
# the task doesn't exist or isn't running — both expected outcomes, not
# errors: a fresh install has no task yet, and a plain "stop before
# uninstall" may run while the task isn't mid-execution at all.
& schtasks.exe /End /TN Suveren 2>$null | Out-Null

# Kill every node.exe whose OWN executable is the one this install shipped —
# not by command line (fragile: differs between `run` and `start --detach`,
# and between the parent and its two children) but by the actual on-disk
# path, which is identical for all of them.
$prefix = $InstallFolder.TrimEnd('\')
# Get-Process, not Get-CimInstance: the CIM query took ~45 s under x64 emulation
# on Windows 11 ARM (same logic as the StopGateway custom action in Product.wxs).
$targets = Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -and $_.Path.StartsWith("$prefix\", [System.StringComparison]::OrdinalIgnoreCase)
  }

foreach ($p in $targets) {
  try {
    Stop-Process -Id $p.Id -Force -ErrorAction Stop
  } catch {
    # Already gone (e.g. a child whose parent was just killed) — fine.
  }
}

# Never fail the MSI action on anything above; the custom actions that call
# this script are Return="ignore" too (belt and suspenders — a stop that
# can't run should never be what blocks an uninstall or upgrade).
exit 0
