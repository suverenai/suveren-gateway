# Suveren Windows toast check - run in Windows PowerShell (not pwsh):
#   powershell -ExecutionPolicy Bypass -File .\check.ps1
#
# The toast command below is GENERATED from apps/control-plane/src/lib/
# desktop-notify.ts (buildNotifyCommand): the exact string the gateway spawns,
# not a re-implementation. Regenerate after changing the builder.
#
# ASCII only, on purpose. See the encoding note above.

Write-Host "[1/3] Fetching the Suveren icon..."
try { Invoke-WebRequest -Uri "https://www.suveren.ai/logo.png" -OutFile "C:\Users\Public\suveren-icon.png" -UseBasicParsing } catch { Write-Host "      (icon fetch failed; toast will show without it)" }

Write-Host "[2/3] Posting the toast (exact gateway command)..."
$aumid='Suveren.Gateway'; $reg="HKCU:\Software\Classes\AppUserModelId\$aumid"; if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }; New-ItemProperty -Path $reg -Name DisplayName -Value 'Suveren' -PropertyType String -Force | Out-Null; New-ItemProperty -Path $reg -Name IconUri -Value 'C:\Users\Public\suveren-icon.png' -PropertyType String -Force | Out-Null; [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null; $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml('<toast activationType="protocol" launch="https://www.suveren.ai"><visual><binding template="ToastGeneric"><text>Suveren</text><text>Something is waiting for your review.</text><image placement="appLogoOverride" src="C:\Users\Public\suveren-icon.png"/></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>'); $toast = New-Object Windows.UI.Notifications.ToastNotification $doc; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)

Write-Host "[3/3] Verifying the AUMID registration..."
if (Test-Path "HKCU:\Software\Classes\AppUserModelId\Suveren.Gateway") {
  Write-Host "      OK - Suveren.Gateway registered."
  Write-Host "      Now check: banner? icon? sound? click opens browser? Action Center?"
} else {
  Write-Host "      FAILED - registry key missing; the toast command did not run."
}
