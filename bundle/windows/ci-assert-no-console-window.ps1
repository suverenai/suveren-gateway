<#
.SYNOPSIS
  CI only: fail if any VISIBLE top-level window belongs to the installed gateway.

.DESCRIPTION
  A console window is owned by its console host (conhost.exe / OpenConsole.exe),
  not by node.exe — so checking node.exe's MainWindowHandle missed the window a
  real Windows 11 VM showed for the whole gateway lifetime. This enumerates every
  visible top-level window, maps a console host to the program it hosts (its
  parent process), and fails when that program — or any of its ancestors — is
  the gateway: an executable under the install dir, or the installer's
  launcher.cmd. Not shipped in the installer or the signing kit.
#>
param([string]$InstallRoot = "$env:LOCALAPPDATA\Programs\Suveren", [switch]$Diagnose)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SuverenWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Visible() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        r.Add(pid + "|" + sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }

function Test-GatewayTree($p) {
  for ($i = 0; $p -and $i -lt 25; $i++) {
    if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith("$InstallRoot\", [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($p.CommandLine -and $p.CommandLine -like '*\Programs\Suveren\suveren-gateway.cmd*') { return $true }
    $p = $procs[[int]$p.ParentProcessId]
  }
  return $false
}

$windows = [SuverenWin]::Visible()
$offending = foreach ($w in $windows) {
  $windowPid, $title = $w -split '\|', 2
  $owner = $procs[[int]$windowPid]
  if (-not $owner) { continue }
  # A console window is drawn by its host; the hosted program is the host's parent.
  $hosted = if ($owner.Name -in @('conhost.exe', 'OpenConsole.exe')) { $procs[[int]$owner.ParentProcessId] } else { $owner }
  if ($hosted -and (Test-GatewayTree $hosted)) {
    "window owner=$($owner.Name) pid=$windowPid title='$title' hosts=$($hosted.Name) pid=$($hosted.ProcessId) cmd=$($hosted.CommandLine)"
  }
}

Write-Host "checked $($windows.Count) visible top-level window(s)"
if ($Diagnose) {
  Write-Host "session: $([System.Diagnostics.Process]::GetCurrentProcess().SessionId) user: $env:USERNAME interactive: $([Environment]::UserInteractive)"
  foreach ($w in $windows) {
    $windowPid, $title = $w -split '\|', 2
    $o = $procs[[int]$windowPid]
    Write-Host ("  window pid={0} owner={1} parent={2} exe={3} title='{4}'" -f $windowPid, $o.Name, $o.ParentProcessId, $o.ExecutablePath, $title)
  }
  Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object {
    $c = $procs[[int]$_.Id]
    Write-Host ("  node pid={0} session={1} mainWindow={2} title='{3}' exe={4} parent={5}" -f $_.Id, $_.SessionId, $_.MainWindowHandle, $_.MainWindowTitle, $_.Path, $c.ParentProcessId)
  }
  Get-CimInstance Win32_Process -Filter "Name='conhost.exe' OR Name='OpenConsole.exe'" | ForEach-Object {
    Write-Host ("  host {0} pid={1} parent={2} session={3} cmd={4}" -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.SessionId, $_.CommandLine)
  }
}
if ($offending) {
  $offending | ForEach-Object { Write-Host "VISIBLE GATEWAY WINDOW: $_" }
  throw "$(@($offending).Count) visible window(s) belong to the gateway — it must run without any window"
}
Write-Host "confirmed: no visible window belongs to the gateway (console hosts included)"
