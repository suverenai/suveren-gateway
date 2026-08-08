/**
 * Reproduces the gateway's own spawn on Windows and compares it with the
 * -File form, to find why a toast posted by the gateway never appears while
 * the identical script run from PowerShell does.
 *
 * Run in the VM:  node win-toast-node.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$ErrorActionPreference='SilentlyContinue'; $aumid='Suveren.Gateway'; $reg=\"HKCU:\\Software\\Classes\\AppUserModelId\\$aumid\"; if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }; New-ItemProperty -Path $reg -Name DisplayName -Value 'Suveren' -PropertyType String -Force | Out-Null; New-ItemProperty -Path $reg -Name IconUri -Value 'C:\\Users\\Public\\suveren-icon.png' -PropertyType String -Force | Out-Null; [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null; $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml('<toast activationType=\"protocol\" launch=\"https://www.suveren.ai\"><visual><binding template=\"ToastGeneric\"><text>Suveren</text><text>MARKER</text><image placement=\"appLogoOverride\" src=\"C:\\Users\\Public\\suveren-icon.png\"/></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>'); $toast = New-Object Windows.UI.Notifications.ToastNotification $doc; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)"
];

// ---- Probe 1: EXACTLY what the gateway does today ------------------------
// spawn('powershell', ['-NoProfile','-NonInteractive','-Command', <script>])
// Node builds a Windows command line from this array and escapes embedded
// double quotes. The toast XML is full of them.
const p1 = ARGS.map(a => a.replace('MARKER', 'NODE 1 - gateway -Command form'));
console.log('Probe 1: spawning exactly as the gateway does...');
const c1 = spawn('powershell', p1, { detached: true, stdio: 'ignore' });
c1.on('error', e => console.log('  spawn error:', e.message));
c1.unref();

setTimeout(() => {
  // ---- Probe 2: same script, but handed over as a FILE -------------------
  // No command-line quoting of the payload at all.
  const script = ARGS[3].replace('MARKER', 'NODE 2 - via -File');
  const path = 'node-probe.ps1';
  writeFileSync(path, '\ufeff' + script + '\r\n', 'utf8');
  console.log('Probe 2: spawning the same script via -File...');
  const c2 = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path], {
    detached: true, stdio: 'ignore',
  });
  c2.on('error', e => console.log('  spawn error:', e.message));
  c2.unref();

  setTimeout(() => {
    console.log('');
    console.log('Which toasts appeared?');
    console.log('  "NODE 1" only  -> the -Command form is fine; look elsewhere');
    console.log('  "NODE 2" only  -> Node mangles the quotes in -Command (the bug)');
    console.log('  both           -> spawning is fine; the gateway differs some other way');
    console.log('  neither        -> the payload itself fails when Node spawns it');
  }, 7000);
}, 7000);
