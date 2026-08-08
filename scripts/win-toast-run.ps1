# Isolates why the gateway toast does not appear while an interactive one does.
# Each variant runs the SAME payload file; only the spawn differs.
# Errors are captured to files instead of vanishing into a hidden window.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "--- C: run in-process (known good control) ---"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$herewin-toast-a.ps1"
Start-Sleep -Seconds 6

Write-Host "--- A: detached, exits immediately (what the gateway does) ---"
$a = Start-Process powershell -PassThru -RedirectStandardError "$hereerr-a.txt" -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"$herewin-toast-a.ps1"
Start-Sleep -Seconds 6

Write-Host "--- B: detached, stays alive 3s after Show() ---"
$b = Start-Process powershell -PassThru -RedirectStandardError "$hereerr-b.txt" -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"$herewin-toast-b.ps1"
Start-Sleep -Seconds 8

Write-Host ""
Write-Host "stderr from A:"; if (Test-Path "$hereerr-a.txt") { Get-Content "$hereerr-a.txt" } else { Write-Host "  (none)" }
Write-Host "stderr from B:"; if (Test-Path "$hereerr-b.txt") { Get-Content "$hereerr-b.txt" } else { Write-Host "  (none)" }
Write-Host ""
Write-Host "Which toasts appeared? C / A / B"
