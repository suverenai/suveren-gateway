# Isolates why the gateway's toast does not appear while an interactive one does.
# Each variant runs the SAME payload file; only the spawn differs.
# Errors are captured to files instead of vanishing into a hidden window.
#
# Run from the directory containing win-toast-a.ps1 / win-toast-b.ps1:
#   powershell -ExecutionPolicy Bypass -File .\win-toast-run.ps1
#
# Relative paths on purpose: an earlier version interpolated a $here variable
# and lost a backslash in generation, which produced "file does not exist" and
# looked exactly like "the toast did not appear".
# ASCII only + BOM: PowerShell 5.1 reads .ps1 as ANSI otherwise.

if (-not (Test-Path .\win-toast-a.ps1)) {
  Write-Host "ERROR: run this from the folder containing win-toast-a.ps1"
  exit 1
}

Write-Host "--- C: run in-process (known good control) ---"
& powershell -NoProfile -ExecutionPolicy Bypass -File .\win-toast-a.ps1
Start-Sleep -Seconds 6

Write-Host "--- A: detached, exits immediately (what the gateway does) ---"
Start-Process powershell -RedirectStandardError .\err-a.txt -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','.\win-toast-a.ps1'
Start-Sleep -Seconds 6

Write-Host "--- B: detached, stays alive 3s after Show() ---"
Start-Process powershell -RedirectStandardError .\err-b.txt -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','.\win-toast-b.ps1'
Start-Sleep -Seconds 8

Write-Host ""
Write-Host "stderr from A:"
if (Test-Path .\err-a.txt) { Get-Content .\err-a.txt } else { Write-Host "  (none)" }
Write-Host "stderr from B:"
if (Test-Path .\err-b.txt) { Get-Content .\err-b.txt } else { Write-Host "  (none)" }
Write-Host ""
Write-Host "Which toasts appeared? C / A / B"
