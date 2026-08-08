/**
 * Why does a toast posted by the gateway never appear, when the identical
 * script works if PowerShell launches it?
 *
 * The previous probe used stdio:'ignore' - the gateway's own setting - so
 * PowerShell's complaint was thrown away and every failure looked identical.
 * This one CAPTURES stdout/stderr and prints exit codes.
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

function run(label, cmd, args, opts = {}) {
  return new Promise(resolve => {
    console.log('');
    console.log('=== ' + label + ' ===');
    let out = '', err = '';
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    c.stdout?.on('data', d => { out += d; });
    c.stderr?.on('data', d => { err += d; });
    c.on('error', e => { console.log('  SPAWN ERROR: ' + e.message); resolve(); });
    c.on('close', code => {
      console.log('  exit code: ' + code);
      if (out.trim()) console.log('  stdout: ' + out.trim().slice(0, 900));
      if (err.trim()) console.log('  STDERR: ' + err.trim().slice(0, 900));
      if (!out.trim() && !err.trim()) console.log('  (no output)');
      resolve();
    });
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// 1 - the gateway's form: script inline via -Command. Node escapes embedded
//     double quotes when it builds the Windows command line, and the toast XML
//     is full of them.
const a1 = ARGS.map(a => a.replace('MARKER', 'NODE 1 - Command form'));
await run('1: -Command (what the gateway does)', 'powershell', a1);
await wait(4000);

// 2 - same script handed over as a file: no command-line quoting at all.
const script = ARGS[3].replace('MARKER', 'NODE 2 - File form');
writeFileSync('node-probe.ps1', '\ufeff' + script + '\r\nWrite-Host \'file-form done\'\r\n', 'utf8');
await run('2: -File', 'powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'node-probe.ps1']);
await wait(4000);

// 3 - the file form again, but detached like the gateway, to see whether the
//     detached flag alone suppresses delivery.
const script3 = ARGS[3].replace('MARKER', 'NODE 3 - File + detached');
writeFileSync('node-probe3.ps1', '\ufeff' + script3 + '\r\n', 'utf8');
await run('3: -File + detached', 'powershell',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'node-probe3.ps1'],
  { detached: true });
await wait(4000);

console.log('');
console.log('Which toasts appeared? (NODE 1 / NODE 2 / NODE 3 / none)');
console.log('Paste the exit codes and any STDERR above.');
