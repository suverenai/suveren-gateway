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

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

switch (cmd) {
  case 'start':   await start(argv.slice(1)); break;
  case 'stop':    await stop(); break;
  case 'status':  await status(); break;
  case 'restart': await restart(); break;
  case 'logs':    await logs(argv.slice(1)); break;
  case 'help':
  case '--help':
  case '-h':
    printHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(2);
}

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
    process.kill(pid, 'SIGTERM');
    // Give it up to 5s to exit cleanly.
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (!isPidAlive(pid)) break;
    }
    if (isPidAlive(pid)) {
      console.error(`Process ${pid} did not exit after SIGTERM — sending SIGKILL.`);
      process.kill(pid, 'SIGKILL');
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
  suveren-gateway help               Print this help

Environment:
  SUVEREN_CP_PORT     UI + API port  (default 3400)
  SUVEREN_MCP_PORT    MCP server port (default 3430)
  SUVEREN_DATA_DIR    Data directory (default ~/.suveren)
`);
}
