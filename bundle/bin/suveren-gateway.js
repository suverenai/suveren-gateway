#!/usr/bin/env node
/**
 * suveren-gateway CLI — wraps `node server.js` with start/stop/status/logs.
 *
 * Foreground by default (Ctrl+C stops). Pass --detach for a daemonized
 * run that writes a PID file and a log file under ~/.suveren/.
 *
 * Cross-platform: macOS, Linux, Windows. Uses os.homedir() everywhere
 * (no $HOME dependency). Process-existence checks via process.kill(pid, 0)
 * which Node implements consistently across platforms.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLaunchAgentPlist, buildMacLauncher, buildSystemdUnit, buildWindowsTaskXml } from '../lib/autostart-templates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SERVER_ENTRY = join(PKG_ROOT, 'server.js');

const DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const PID_FILE = join(DATA_DIR, 'gateway.pid');
const LOG_FILE = join(DATA_DIR, 'gateway.log');

const SUVEREN_PORT = process.env.SUVEREN_CP_PORT ?? '3400';

/** Version of THIS CLI (the binary on disk). Compared against the
 *  running gateway's version inside `status` so users see a mismatch
 *  after an upgrade and know to restart. */
let CLI_VERSION = '';
try {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  CLI_VERSION = pkg.version ?? '';
} catch {
  /* package.json missing → leave empty, just skip the mismatch check */
}

// ─── Subcommands ────────────────────────────────────────────────────────

/**
 * Dispatch runs at the BOTTOM of this file, not here.
 *
 * Top-level `const` declarations are not hoisted, so dispatching from this
 * point ran every subcommand before the constants below it were initialised.
 * `service` referenced one and threw "Cannot access 'LAUNCH_AGENT_LABEL'
 * before initialization" on every invocation — the feature had never worked on
 * any platform, and nothing tested it. See main() at the end of the file.
 */

// ─── Implementations ────────────────────────────────────────────────────

async function start(args) {
  const detach = args.includes('--detach') || args.includes('-d');

  if (await isAlreadyRunning()) {
    console.error(`suveren-gateway is already running (pid ${readPid()}). Use \`suveren-gateway stop\` first or \`suveren-gateway restart\`.`);
    process.exit(1);
  }

  ensureDataDir();

  if (detach) {
    const out = openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    writeFileSync(PID_FILE, String(child.pid), 'utf8');
    child.unref();
    console.log(`suveren-gateway started (pid ${child.pid})`);
    console.log(``);
    console.log(`  → Open in your browser:  http://localhost:${SUVEREN_PORT}`);
    console.log(``);
    console.log(`  Logs:  ${LOG_FILE}`);
    console.log(`  Stop:  suveren-gateway stop`);
  } else {
    // Foreground — replace this CLI process with server.js's stdio.
    console.log(`Starting suveren-gateway… open http://localhost:${SUVEREN_PORT} once "up" appears below. Ctrl+C to stop.`);
    console.log(``);
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0));
    });
    // Forward signals so Ctrl+C cleanly terminates the gateway.
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child.kill(sig));
    }
  }
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    console.error('suveren-gateway is not running (no PID file).');
    process.exit(1);
  }
  if (!isPidAlive(pid)) {
    console.error(`Stale PID file (process ${pid} not running) — cleaning up.`);
    safeUnlink(PID_FILE);
    process.exit(0);
  }
  try {
    if (platform() === 'win32') {
      // Windows has no POSIX signals: process.kill(pid, 'SIGTERM') is mapped to
      // TerminateProcess, so (a) server.js's shutdown handler never runs and
      // (b) only the parent dies — the CP + MCP children, and every downstream
      // MCP integration they spawned, are orphaned and keep holding the ports
      // and the data dir. `taskkill /T` walks the whole tree; /F is required
      // because a detached process has no console to receive a close event.
      // Graceful shutdown is not reachable here, which is exactly why the tree
      // kill is: nothing else will reap the children.
      const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // taskkill exits 128 when the process is already gone — that is a
      // successful stop, not a failure.
      if (res.status !== 0 && isPidAlive(pid)) {
        throw new Error(`taskkill exited ${res.status ?? res.error?.message}`);
      }
    } else {
      process.kill(pid, 'SIGTERM');
      // Give it up to 5s to exit cleanly. server.js's SIGTERM handler
      // propagates to the CP + MCP children, which shut their integrations
      // down — so on POSIX the tree unwinds itself.
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        if (!isPidAlive(pid)) break;
      }
      if (isPidAlive(pid)) {
        console.error(`Process ${pid} did not exit after SIGTERM — sending SIGKILL.`);
        process.kill(pid, 'SIGKILL');
      }
    }
    safeUnlink(PID_FILE);
    console.log(`suveren-gateway stopped (pid ${pid}).`);
  } catch (err) {
    console.error(`Failed to stop pid ${pid}:`, err.message);
    process.exit(1);
  }
}

async function status() {
  const pid = readPid();
  if (!pid) {
    // No PID file does NOT mean not running: when the login service owns the
    // gateway, launchd/systemd/Task Scheduler spawn server.js directly and
    // nothing writes one. Ask the port before declaring it dead — otherwise
    // status contradicts a gateway that is plainly serving requests.
    try {
      const res = await fetch(`http://localhost:${SUVEREN_PORT}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = await res.json();
        console.log('suveren-gateway: running (managed by the login service)');
        console.log(`  UI:           http://localhost:${SUVEREN_PORT}`);
        console.log(`  Vault:        ${body.vaultUnlocked ? 'unlocked' : 'locked'}`);
        console.log(`  Version:      ${body.version ?? 'unknown'} (running)`);
        console.log(`  Service:      suveren-gateway service status`);
        return;
      }
    } catch {
      /* nothing listening — genuinely not running */
    }
    console.log('suveren-gateway: not running (no PID file).');
    process.exit(3);
  }
  if (!isPidAlive(pid)) {
    console.log(`suveren-gateway: stale PID file (process ${pid} not running).`);
    process.exit(3);
  }
  // Probe the health endpoint to confirm it's actually serving.
  try {
    const res = await fetch(`http://localhost:${SUVEREN_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    console.log(`suveren-gateway: running (pid ${pid})`);
    console.log(`  UI:           http://localhost:${SUVEREN_PORT}`);
    console.log(`  Vault:        ${body.vaultUnlocked ? 'unlocked' : 'locked'}`);
    console.log(`  Version:      ${body.version ?? 'unknown'} (running)`);
    if (CLI_VERSION) console.log(`                ${CLI_VERSION} (installed CLI)`);
    if (CLI_VERSION && body.version && body.version !== CLI_VERSION && body.version !== 'dev') {
      console.log('');
      console.log(`  ⚠  Running version differs from the installed CLI.`);
      console.log(`     Restart to pick up the new code: suveren-gateway restart`);
    }
    if (body.updateAvailable) {
      console.log('');
      console.log(`  Update available — see banner in the UI for the upgrade command.`);
    }
  } catch (err) {
    console.log(`suveren-gateway: pid ${pid} alive but /health unreachable (${err.message})`);
    process.exit(2);
  }
}

async function restart() {
  if (readPid() && isPidAlive(readPid())) {
    await stop();
  }
  await start(['--detach']);
}

async function logs(args) {
  if (!existsSync(LOG_FILE)) {
    console.error(`No log file at ${LOG_FILE}.`);
    console.error(`Logs are only written when running with --detach. In foreground mode the gateway prints to the terminal.`);
    process.exit(1);
  }
  if (args.includes('--tail') || args.includes('-f')) {
    // Stream new lines as they arrive.
    const proc = spawn(platform() === 'win32' ? 'powershell' : 'tail',
      platform() === 'win32'
        ? ['-Command', `Get-Content -Path '${LOG_FILE}' -Wait`]
        : ['-f', LOG_FILE],
      { stdio: 'inherit' });
    process.on('SIGINT', () => proc.kill());
  } else {
    // Print entire log.
    process.stdout.write(readFileSync(LOG_FILE, 'utf8'));
  }
}

// ─── service: install autostart-on-login (survives reboot) ──────────────
//
// Keeps the gateway PROCESS always running (starts on login, restarts on
// crash). It boots LOCKED — you still enter your Suveren API key once per
// reboot; nothing is persisted. See doc/gateway-always-on.md.
// Implemented on all three: macOS LaunchAgent, Windows Task Scheduler (ONLOGON),
// Linux systemd user unit. All USER-level — no admin, no root, no stored
// password.

const LAUNCH_AGENT_LABEL = 'ai.suveren.gateway';

async function service(args) {
  const sub = args[0] ?? 'help';
  const os = platform();

  if (sub === 'help' || sub === '--help' || sub === '-h') { printServiceHelp(); return; }

  const impl = serviceImplFor(os);
  if (!impl) {
    console.error(`\`suveren-gateway service\` is not available on ${os}.`);
    console.error(`Supported: macOS, Windows, Linux. Run in the background with:`);
    console.error(`  suveren-gateway start --detach`);
    console.error(`(Note: --detach does NOT survive a reboot — the service command will.)`);
    process.exit(2);
  }

  switch (sub) {
    case 'install':   await impl.install(); break;
    case 'uninstall': await impl.uninstall(); break;
    case 'status':    await impl.status(); break;
    default:
      console.error(`Unknown: service ${sub}\n`);
      printServiceHelp();
      process.exit(2);
  }
}

function launchAgentPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

/** Where the named launcher lives. Its FILENAME is the Login Items entry. */
function macLauncherPath() {
  return join(DATA_DIR, 'Suveren');
}

async function serviceInstallMac() {
  ensureDataDir();
  const plistPath = launchAgentPath();
  mkdirSync(dirname(plistPath), { recursive: true });

  // Deliberately does NOT stop the running gateway.
  //
  // Autostart is about FUTURE logins. Seizing the current instance forced a
  // restart, the restart re-locked the vault, and the user was thrown back to
  // the login screen with no idea whether it had worked. Register it and leave
  // the running gateway alone; launchd picks the agent up at the next login,
  // which is exactly when it is wanted.

  // A launcher named `Suveren` so System Settings → Login Items shows that,
  // rather than "node".
  const launcherPath = macLauncherPath();
  writeFileSync(launcherPath, buildMacLauncher({
    nodePath: process.execPath,
    serverEntry: SERVER_ENTRY,
  }), { encoding: 'utf8', mode: 0o755 });

  const plist = buildLaunchAgentPlist({
    launcherPath,
    label: LAUNCH_AGENT_LABEL,
    logFile: LOG_FILE,
    dataDir: process.env.SUVEREN_DATA_DIR ?? '',
    // Captured now, while we are running from the user's shell. launchd would
    // otherwise hand the gateway /usr/bin:/bin:/usr/sbin:/sbin, which has no
    // npx and none of the integration shims — the gateway starts and then
    // every integration silently fails to launch.
    path: process.env.PATH ?? '',
  });
  writeFileSync(plistPath, plist, { encoding: 'utf8', mode: 0o644 });

  const uid = process.getuid();
  // Clear any prior "disabled" mark from a previous uninstall, so the agent is
  // eligible again — but do NOT bootstrap it now: that would start a second
  // gateway alongside the running one and fight over the port.
  runQuiet('launchctl', ['enable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);

  console.log(`✓ Suveren gateway installed as a login service.`);
  console.log(``);
  console.log(`  It starts automatically from your NEXT login, and restarts if it crashes.`);
  console.log(`  Your current gateway keeps running — nothing was interrupted.`);
  console.log(`  After a reboot it comes up LOCKED — open http://localhost:${SUVEREN_PORT} and`);
  console.log(`  enter your Suveren API key once to unlock it (your key is never stored).`);
  console.log(``);
  console.log(`  Plist:      ${plistPath}`);
  console.log(`  Status:     suveren-gateway service status`);
  console.log(`  Remove:     suveren-gateway service uninstall`);
}

async function serviceUninstallMac() {
  const plistPath = launchAgentPath();
  const uid = process.getuid();

  // Deliberately NOT `launchctl bootout`: that unloads AND kills the job, so
  // turning autostart off would destroy the running gateway — and from the UI
  // that is catastrophic, because the page doing the asking dies with it and
  // there is nothing left to start it again. Removing the plist is enough to
  // stop it coming back at login; `disable` stops launchd resurrecting it via
  // KeepAlive in the meantime. The instance you have keeps serving.
  runQuiet('launchctl', ['disable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  if (existsSync(plistPath)) safeUnlink(plistPath);
  if (existsSync(macLauncherPath())) safeUnlink(macLauncherPath());
  console.log(`✓ Login service removed. The gateway will no longer start on login.`);
  console.log('  The running gateway keeps serving — only autostart is off, so it');
  console.log('  will not come back by itself after a restart.');
}

async function serviceStatusMac() {
  const plistPath = launchAgentPath();
  const installed = existsSync(plistPath);
  console.log(`Login service: ${installed ? 'installed' : 'not installed'}`);
  if (installed) console.log(`  Plist:  ${plistPath}`);
  const uid = process.getuid();
  const p = runQuiet('launchctl', ['print', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  if (p.status === 0) {
    const state = /state = (\w+)/.exec(p.stdout || '');
    console.log(`  launchd: loaded${state ? ` (${state[1]})` : ''}`);
  } else if (installed) {
    console.log(`  launchd: not loaded (run \`suveren-gateway service install\` to (re)load)`);
  }
  console.log('');
  await status(); // process/health/vault line
}

// ─── Windows: Task Scheduler (ONLOGON) ──────────────────────────────────

const WIN_TASK_NAME = 'Suveren';

async function serviceInstallWindows() {
  ensureDataDir();

  // Deliberately does NOT stop the running gateway — see the macOS note.
  // Registering is enough; Task Scheduler starts it at the next logon.

  // schtasks reads the XML from a file and requires UTF-16 LE with a BOM —
  // it rejects UTF-8 with an unhelpful "The task XML is malformed".
  const xml = buildWindowsTaskXml({
    nodePath: process.execPath,
    serverEntry: SERVER_ENTRY,
    author: 'Suveren',
    dataDir: process.env.SUVEREN_DATA_DIR ?? '',
  });
  const xmlPath = join(DATA_DIR, 'suveren-task.xml');
  writeFileSync(xmlPath, '\ufeff' + xml, { encoding: 'utf16le' });

  // /F overwrites an existing task, so install is idempotent.
  const r = runQuiet('schtasks', ['/Create', '/TN', WIN_TASK_NAME, '/XML', xmlPath, '/F']);
  safeUnlink(xmlPath);

  if (r.status !== 0) {
    console.error('Could not register the scheduled task.');
    console.error(r.stderr || r.stdout || '');
    process.exit(1);
  }

  console.log('✓ Suveren gateway installed as a login task.');
  console.log('');
  console.log('  It starts automatically from your NEXT logon, and restarts if it crashes.');
  console.log('  Your current gateway keeps running — nothing was interrupted.');
  console.log(`  After a reboot it comes up LOCKED — open http://localhost:${SUVEREN_PORT} and`);
  console.log('  enter your Suveren API key once to unlock it (your key is never stored).');
  console.log('');
  console.log(`  Task:       ${WIN_TASK_NAME} (Task Scheduler, current user)`);
  console.log('  Status:     suveren-gateway service status');
  console.log('  Remove:     suveren-gateway service uninstall');
}

async function serviceUninstallWindows() {
  const r = runQuiet('schtasks', ['/Delete', '/TN', WIN_TASK_NAME, '/F']);
  if (r.status !== 0 && !/cannot find/i.test(r.stderr + r.stdout)) {
    console.error('Could not remove the scheduled task.');
    console.error(r.stderr || r.stdout || '');
    process.exit(1);
  }
  console.log('✓ Login task removed. The gateway will no longer start on login.');
  console.log('  (A currently-running instance keeps running until you `suveren-gateway stop`.)');
}

async function serviceStatusWindows() {
  const r = runQuiet('schtasks', ['/Query', '/TN', WIN_TASK_NAME, '/FO', 'LIST']);
  const installed = r.status === 0;
  console.log(`Login service: ${installed ? 'installed' : 'not installed'}`);
  if (installed) {
    console.log(`  Task:   ${WIN_TASK_NAME}`);
    const state = /Status:\s*(\S+)/.exec(r.stdout || '');
    if (state) console.log(`  State:  ${state[1]}`);
  }
}

// ─── Linux: systemd user unit ───────────────────────────────────────────

const SYSTEMD_UNIT = 'suveren-gateway.service';

function systemdUnitPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'systemd', 'user', SYSTEMD_UNIT);
}

function hasSystemd() {
  return runQuiet('systemctl', ['--user', '--version']).status === 0;
}

async function serviceInstallLinux() {
  ensureDataDir();

  if (!hasSystemd()) {
    console.error('systemd --user is not available on this system.');
    console.error('Run it in the background instead:  suveren-gateway start --detach');
    process.exit(1);
  }

  // Deliberately does NOT stop the running gateway — see the macOS note.
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, buildSystemdUnit({
    nodePath: process.execPath,
    serverEntry: SERVER_ENTRY,
    logFile: LOG_FILE,
    dataDir: process.env.SUVEREN_DATA_DIR ?? '',
    // See the macOS note: a systemd user unit inherits no usable PATH either.
    path: process.env.PATH ?? '',
  }), { encoding: 'utf8', mode: 0o644 });

  runQuiet('systemctl', ['--user', 'daemon-reload']);
  // `enable` WITHOUT --now: registered for the next login, running instance
  // untouched. --now would start a second gateway and fight over the port.
  const en = runQuiet('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
  if (en.status !== 0) {
    console.error('Wrote the unit file but systemd could not enable it.');
    console.error(en.stderr || en.stdout || '');
    console.error(`Unit: ${unitPath}`);
    process.exit(1);
  }

  console.log('✓ Suveren gateway installed as a user service.');
  console.log('');
  console.log('  It starts automatically from your NEXT login, and restarts if it crashes.');
  console.log('  Your current gateway keeps running — nothing was interrupted.');
  console.log(`  After a reboot it comes up LOCKED — open http://localhost:${SUVEREN_PORT} and`);
  console.log('  enter your Suveren API key once to unlock it (your key is never stored).');
  console.log('');
  console.log(`  Unit:       ${unitPath}`);
  console.log('  Status:     suveren-gateway service status');
  console.log('  Remove:     suveren-gateway service uninstall');
  console.log('');
  console.log('  A user service starts at LOGIN. To have it run from boot without');
  console.log('  logging in, enable lingering once:');
  console.log(`    loginctl enable-linger ${process.env.USER ?? '$USER'}`);
}

async function serviceUninstallLinux() {
  const unitPath = systemdUnitPath();
  // `disable` WITHOUT --now: stop it starting at login, but leave the running
  // instance alone. --now would stop it, and from the UI that kills the page
  // making the request with nothing left to restart it.
  runQuiet('systemctl', ['--user', 'disable', SYSTEMD_UNIT]);
  if (existsSync(unitPath)) safeUnlink(unitPath);
  runQuiet('systemctl', ['--user', 'daemon-reload']);
  console.log('✓ User service removed. The gateway will no longer start on login.');
  console.log('  The running gateway keeps serving — only autostart is off, so it');
  console.log('  will not come back by itself after a restart.');
}

async function serviceStatusLinux() {
  const unitPath = systemdUnitPath();
  const installed = existsSync(unitPath);
  console.log(`Login service: ${installed ? 'installed' : 'not installed'}`);
  if (installed) console.log(`  Unit:   ${unitPath}`);
  const active = runQuiet('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
  const enabled = runQuiet('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT]);
  if (installed) {
    console.log(`  systemd: ${(active.stdout || 'unknown').trim()} / ${(enabled.stdout || 'unknown').trim()}`);
  }
}

/**
 * Per-platform autostart; null ⇒ unsupported platform.
 *
 * A function, not a const object: the CLI dispatches at the top of this file,
 * which runs BEFORE a top-level const is initialised (temporal dead zone), so
 * an object here threw "Cannot access before initialization" on every
 * `service` invocation. Function declarations are hoisted.
 */
function serviceImplFor(os) {
  switch (os) {
    case 'darwin': return { install: serviceInstallMac,     uninstall: serviceUninstallMac,     status: serviceStatusMac };
    case 'win32':  return { install: serviceInstallWindows, uninstall: serviceUninstallWindows, status: serviceStatusWindows };
    case 'linux':  return { install: serviceInstallLinux,   uninstall: serviceUninstallLinux,   status: serviceStatusLinux };
    default:       return null;
  }
}

/** Run a command capturing output, never throwing. */
function runQuiet(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function printServiceHelp() {
  console.log(`suveren-gateway service — run the gateway as a login service (survives reboot)

Usage:
  suveren-gateway service install     Start on login + restart on crash
  suveren-gateway service uninstall   Remove the login service
  suveren-gateway service status      Show whether it's installed + running

Supported on macOS (LaunchAgent), Windows (Task Scheduler) and Linux (systemd
user unit). All are USER-level — no admin rights, no root, no stored password.

The gateway boots LOCKED after a reboot: you enter your Suveren API key once to
unlock it, and the key is never stored. Autostart keeps the PROCESS alive; it
cannot unlock your credentials for you.

Linux: a user service starts at LOGIN. To run it from boot without logging in,
enable lingering once:  loginctl enable-linger $USER
`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 doesn't kill, just probes existence + permissions.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it; ESRCH means gone.
    return err.code === 'EPERM';
  }
}

async function isAlreadyRunning() {
  const pid = readPid();
  if (!pid) return false;
  if (!isPidAlive(pid)) {
    // Clean up stale PID file silently.
    safeUnlink(PID_FILE);
    return false;
  }
  return true;
}

function safeUnlink(path) {
  try { unlinkSync(path); } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp() {
  console.log(`suveren-gateway — Suveren gateway (Human Agency Protocol)

Usage:
  suveren-gateway start [--detach]   Run the gateway (foreground by default)
  suveren-gateway stop               Stop a detached gateway
  suveren-gateway restart            Stop, then start --detach
  suveren-gateway status             Show running state + health
  suveren-gateway logs [--tail]      Print or tail ~/.suveren/gateway.log
  suveren-gateway service <cmd>      Run as a login service that survives reboot
                                     (install | uninstall | status; macOS today)
  suveren-gateway help               Print this help

Environment:
  SUVEREN_CP_PORT     UI + API port  (default 3400)
  SUVEREN_MCP_PORT    MCP server port (default 3430)
  SUVEREN_DATA_DIR    Data directory (default ~/.suveren)
`);
}

// ─── Entry point ────────────────────────────────────────────────────────
//
// Called last so every declaration above is initialised first.

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';

  switch (cmd) {
    case 'start':   await start(argv.slice(1)); break;
    case 'stop':    await stop(); break;
    case 'status':  await status(); break;
    case 'restart': await restart(); break;
    case 'logs':    await logs(argv.slice(1)); break;
    case 'service': await service(argv.slice(1)); break;
    case 'help':
    case '--help':
    case '-h':
      printHelp(); break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(2);
  }
}

await main();
