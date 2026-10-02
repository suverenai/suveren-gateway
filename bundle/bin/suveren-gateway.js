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
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLaunchAgentPlist, buildMacLauncher, buildSystemdUnit, buildWindowsTaskXml } from '../lib/autostart-templates.mjs';
import { DEFAULT_AS_URL, readConfig, writeConfig, validateAsUrl, validateCaFile, validateProxyUrl, validatePinTls, resolveAsUrl, resolvePinTls, resolvePinTlsExpectedFingerprint, resolveSimulation } from '../lib/config.mjs';
import { createInterface } from 'node:readline/promises';
import { readPairing as readAsPairing, recordTlsPin, formatFingerprint, normalizeFingerprint } from '../lib/as-pairing.mjs';
import { unsupportedNodeReason } from '../lib/node-version.mjs';

// Before any command: on an unsupported Node the connectors cannot run (see
// lib/node-version.mjs), so refuse with the reason instead of starting.
const nodeReason = unsupportedNodeReason(process.versions.node);
if (nodeReason) {
  console.error(nodeReason);
  process.exit(1);
}

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

/** Value following a `--flag` in an argv array, or undefined if absent. */
function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

/**
 * The TLS SPKI fingerprint currently on file for `asUrl`, if any — either a
 * real, verified pin (as-pairing.json, captured at a past sign-in) or a
 * staged-but-not-yet-verified one (config.json's `pinTlsExpectedFingerprint`
 * — set by a PRIOR `--expect-fingerprint` run before any pairing existed).
 * The pairing value always wins when both are present.
 */
function currentTlsFingerprintHex(dataDir, asUrl) {
  const pairing = readAsPairing(dataDir);
  if (pairing && pairing.asUrl === asUrl && pairing.tlsSpkiPinHex) return pairing.tlsSpkiPinHex;
  return resolvePinTlsExpectedFingerprint(dataDir);
}

function printFingerprintHowTo(asUrl) {
  let host = asUrl;
  try { host = new URL(asUrl).host; } catch { /* keep the raw string */ }
  console.error(`Obtain the Authority Server's OWN fingerprint independently — e.g. ask the operator over`);
  console.error(`the phone, or run this yourself on a network you already trust:`);
  console.error(``);
  console.error(`  openssl s_client -connect ${host} </dev/null 2>/dev/null \\`);
  console.error(`    | openssl x509 -pubkey -noout \\`);
  console.error(`    | openssl pkey -pubin -outform der \\`);
  console.error(`    | openssl dgst -sha256`);
  console.error(``);
  console.error(`Compare it against the value shown above (if any) BEFORE re-running this with --expect-fingerprint.`);
}

/**
 * Mandatory out-of-band check for enabling pin-tls (opt-in TLS certificate
 * pinning) — shared by `start --pin-tls` and `config set pin-tls on`.
 * Without this, turning pin-tls on would either silently trust whatever
 * certificate the Authority Server happens to present at the next sign-in
 * (defeating the whole point of pinning) or require a SEPARATE manual
 * verification step a script could skip. `--expect-fingerprint` makes the
 * operator state, on the command line, the value they already checked
 * out-of-band — refusing outright when it's missing or doesn't match
 * whatever is already on file.
 *
 * Returns the normalized (lowercase, no separators) hex fingerprint to
 * commit, or exits the process (code 1) having already printed why.
 */
function requireConfirmedFingerprint(args, asUrl) {
  const flag = flagValue(args, '--expect-fingerprint');
  const existingHex = currentTlsFingerprintHex(DATA_DIR, asUrl);

  if (!flag) {
    console.error(`--expect-fingerprint is required to enable pin-tls — this is the Authority Server's TLS`);
    console.error(`certificate public-key fingerprint (SHA-256 of the leaf SPKI), checked over a second`);
    console.error(`channel BEFORE trusting it, not just whatever this gateway happens to see on the wire.`);
    console.error(``);
    if (existingHex) {
      console.error(`Currently on file for ${asUrl}:`);
      console.error(`  ${formatFingerprint(existingHex)}`);
      console.error(``);
    }
    printFingerprintHowTo(asUrl);
    process.exit(1);
  }

  const norm = normalizeFingerprint(flag);
  if (!norm.ok) {
    console.error(`Invalid --expect-fingerprint: ${norm.error}`);
    process.exit(1);
  }

  if (existingHex && existingHex !== norm.hex) {
    console.error(`--expect-fingerprint does not match the fingerprint already on file for ${asUrl}:`);
    console.error(`  on file:  ${formatFingerprint(existingHex)}`);
    console.error(`  provided: ${formatFingerprint(norm.hex)}`);
    console.error(``);
    console.error(`If the Authority Server's certificate changed INTENTIONALLY (a new key, not just a`);
    console.error(`renewal), clear the pairing (${join(DATA_DIR, 'as-pairing.json')}) and sign in again to`);
    console.error(`re-pin it, then re-run this command with the new fingerprint.`);
    process.exit(1);
  }

  return norm.hex;
}

/**
 * Commit a confirmed fingerprint: into the existing pairing record
 * (as-pairing.json) when one exists for this URL, so it is enforced from
 * the very next connection on — or, when no pairing exists yet (nothing to
 * attach a TLS pin to), staged in config.json's `pinTlsExpectedFingerprint`
 * for the control plane to enforce at the NEXT sign-in's challenge (see
 * checkAsKeyBeforeLogin in apps/control-plane/src/routes/auth.ts), which
 * moves it into as-pairing.json and clears the staging field once it
 * verifies.
 */
function commitConfirmedFingerprint(dataDir, asUrl, hex) {
  if (recordTlsPin(dataDir, asUrl, hex)) return 'pinned';
  writeConfig(dataDir, { pinTlsExpectedFingerprint: hex });
  return 'staged';
}

async function start(args) {
  const detach = args.includes('--detach') || args.includes('-d');

  // --as-url / --ca-file: VALIDATE now (fail fast on bad input regardless of
  // whether a start would even be possible), but do not SAVE yet — see below,
  // after the already-running / port-in-use checks. Saving here unconditionally
  // meant `start --as-url X` against an already-running gateway silently
  // overwrote the saved config for an instance that never actually started
  // with it, which is confusing to unwind (the saved value looks right, but
  // nothing running reflects it).
  const asUrlFlag = flagValue(args, '--as-url');
  let asUrlToSave = null;
  if (asUrlFlag) {
    const v = validateAsUrl(asUrlFlag);
    if (!v.ok) {
      console.error(`Invalid --as-url: ${v.error}`);
      process.exit(1);
    }
    asUrlToSave = v.url;
  }

  const caFileFlag = flagValue(args, '--ca-file');
  let caFileToSave = null;
  if (caFileFlag) {
    const v = validateCaFile(caFileFlag);
    if (!v.ok) {
      console.error(`Invalid --ca-file: ${v.error}`);
      process.exit(1);
    }
    caFileToSave = v.path;
  }

  const proxyFlag = flagValue(args, '--proxy');
  let proxyToSave = null;
  if (proxyFlag) {
    const v = validateProxyUrl(proxyFlag);
    if (!v.ok) {
      console.error(`Invalid --proxy: ${v.error}`);
      process.exit(1);
    }
    proxyToSave = v.url;
  }

  // --pin-tls: a boolean flag (turns TLS certificate pinning ON — there is
  // no `start --pin-tls off`; use `config set pin-tls off` for that).
  // Validated against the EFFECTIVE as-url for this very start (the flag
  // above, if given, wins over whatever is saved) — enabling it for an
  // http:// Authority Server has nothing to pin. Also requires
  // --expect-fingerprint (the mandatory out-of-band check — see
  // requireConfirmedFingerprint) before it can be turned on at all.
  const pinTlsFlag = args.includes('--pin-tls');
  let pinTlsToSave = null;
  let confirmedFingerprintHex = null;
  if (pinTlsFlag) {
    const effectiveAsUrl = asUrlToSave ?? resolveAsUrl(DATA_DIR);
    const v = validatePinTls(effectiveAsUrl);
    if (!v.ok) {
      console.error(`Invalid --pin-tls: ${v.error}`);
      process.exit(1);
    }
    confirmedFingerprintHex = requireConfirmedFingerprint(args, effectiveAsUrl);
    pinTlsToSave = true;
  }

  // --simulation: the safe direction (turning OFF real systems), so — unlike
  // `simulation off` — this needs no confirmation. Only ever turns it ON;
  // there is no `start --no-simulation` (use `simulation off` for that, which
  // DOES require confirmation, since that direction makes real systems
  // reachable again).
  const simulationFlag = args.includes('--simulation');

  if (await isAlreadyRunning()) {
    console.error(`suveren-gateway is already running (pid ${readPid()}). Use \`suveren-gateway stop\` first or \`suveren-gateway restart\`.`);
    process.exit(1);
  }

  // The PID file only knows about instances THIS CLI started. A gateway
  // started by the login service — or from another shell — leaves none, so the
  // check above passes, we spawn, the child dies instantly with EADDRINUSE,
  // and its error goes only to the log. The user gets "started (pid N)" for a
  // process that is already dead. Ask the port, not just the file.
  if (await isPortListening(SUVEREN_PORT)) {
    console.error(`Port ${SUVEREN_PORT} is already in use.`);
    console.error(``);
    if (serviceRunning()) {
      // Do not suggest uninstalling autostart: that removes a feature the user
      // asked for in order to solve a problem that needs a restart. After an
      // upgrade the files on disk are new and the running process is not.
      console.error(`The login service is already running the gateway, so there is nothing to start.`);
      console.error(``);
      console.error(`  Pick up an update:     suveren-gateway restart`);
      console.error(`  Check what is running: suveren-gateway status`);
      console.error(`  Remove autostart:      suveren-gateway service uninstall`);
    } else {
      console.error(`Something is already serving there — most likely a gateway started from`);
      console.error(`another terminal, which leaves no PID file for this CLI to find.`);
      console.error(``);
      console.error(`  Check what it is:      suveren-gateway status`);
      console.error(`  Or use another port:   SUVEREN_CP_PORT=3410 suveren-gateway start`);
    }
    process.exit(1);
  }

  ensureDataDir();

  // NOW save — a start we know is actually going to happen. Also override
  // process.env for the child we're about to spawn: that's what makes
  // "flag > env" actually true (without it, a pre-existing SUVEREN_AS_URL in
  // the caller's shell would still win inside the child, since the resolver
  // there reads env before saved config).
  if (asUrlToSave) {
    writeConfig(DATA_DIR, { asUrl: asUrlToSave });
    process.env.SUVEREN_AS_URL = asUrlToSave;
    console.log(`Authority Server: ${asUrlToSave} (saved — future \`start\` calls keep this without the flag)`);
  }
  if (caFileToSave) {
    writeConfig(DATA_DIR, { caFile: caFileToSave });
    console.log(`CA file: ${caFileToSave} (saved — applied to every process this gateway starts)`);
  }
  if (proxyToSave) {
    writeConfig(DATA_DIR, { proxyUrl: proxyToSave });
    process.env.HTTP_PROXY ??= proxyToSave;
    process.env.HTTPS_PROXY ??= proxyToSave;
    console.log(`Proxy: ${proxyToSave} (saved — applied to every process this gateway starts, unless HTTP_PROXY/HTTPS_PROXY is already set)`);
  }
  if (pinTlsToSave) {
    const effectiveAsUrl = asUrlToSave ?? resolveAsUrl(DATA_DIR);
    const committed = commitConfirmedFingerprint(DATA_DIR, effectiveAsUrl, confirmedFingerprintHex);
    writeConfig(DATA_DIR, { pinTls: true });
    console.log(`TLS pinning: ON (fingerprint ${formatFingerprint(confirmedFingerprintHex)} confirmed)`);
    console.log(
      committed === 'pinned'
        ? `  Enforced from your next connection on.`
        : `  Staged — the first sign-in's challenge must match it (refused otherwise); it then becomes the permanent pin.`,
    );
  }
  if (simulationFlag) {
    writeConfig(DATA_DIR, { simulation: true });
    console.log(`Simulation mode: ON (saved) — every connector without a manifest "simulation" marker will be blocked.`);
  }

  if (detach) {
    const out = openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    writeFileSync(PID_FILE, String(child.pid), 'utf8');
    child.unref();

    // "started" must mean SERVING. A detached child that dies on startup takes
    // its error to the log, so reporting success on spawn alone hands the user
    // a pid that no longer exists and a browser tab that will not connect.
    const serving = await waitForListening(SUVEREN_PORT, 20_000);
    if (!serving) {
      safeUnlink(PID_FILE);
      console.error(`suveren-gateway failed to start — nothing is listening on ${SUVEREN_PORT}.`);
      console.error(``);
      console.error(`  Log:  ${LOG_FILE}`);
      console.error(`  Last lines:`);
      try {
        const tail = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-8);
        for (const line of tail) console.error(`    ${line}`);
      } catch { /* no log yet */ }
      process.exit(1);
    }

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
  // A service-managed gateway writes no PID file. Reporting "not running" while
  // it serves requests is the most misleading thing this CLI can say, and it is
  // what sent an upgrade into a port conflict it could not explain.
  if (!pid && serviceRunning()) {
    console.error('suveren-gateway is running under the login service, which this command does not manage.');
    console.error('');
    console.error('  To pick up an update:   suveren-gateway restart');
    console.error('  To stop it for good:    suveren-gateway service uninstall');
    process.exit(1);
  }
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
        // The WHOLE GROUP (negative pid), not just this one process: `pid`
        // here is always a `--detach`-spawned process, which Node makes the
        // leader of a new process group (`detached: true`). SIGKILL cannot be
        // caught or relayed — sending it to just the top pid (which, with a
        // saved --ca-file, is the re-exec parent from server.js) killed it
        // instantly with no chance to forward the signal, orphaning the
        // re-exec'd child and everything IT spawned (control-plane, MCP
        // server, every integration). `-pid` reaches all of them in one shot.
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ESRCH (group already gone) or an environment where group-kill
          // isn't permitted — fall back to the single pid so this can't throw
          // its way out of stop() entirely.
          process.kill(pid, 'SIGKILL');
        }
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
        console.log(`  Simulation:   ${body.simulation ? 'on — real systems are blocked' : 'off'}`);
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
    console.log(`  Simulation:   ${body.simulation ? 'on — real systems are blocked' : 'off'}`);
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
  // The service manager owns the process when autostart is installed, and it
  // leaves no PID file — so this must be asked FIRST or the checks below all
  // conclude, wrongly, that nothing is running.
  if (serviceRestart()) {
    console.log('suveren-gateway: restarted via the login service.');
    console.log(`  The vault is locked after a restart — unlock at http://localhost:${SUVEREN_PORT}`);
    return;
  }
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

// ─── config: read/save saved settings (as-url, ca-file) ─────────────────

function printConfigHelp() {
  console.log(`suveren-gateway config — read or save gateway settings

Usage:
  suveren-gateway config get [as-url|ca-file|pin-tls|proxy]  Print the resolved value(s)
  suveren-gateway config set as-url <url>              Save the Authority Server URL
  suveren-gateway config set ca-file <path>            Save a CA bundle for internal TLS
  suveren-gateway config set pin-tls on --expect-fingerprint <sha256-hex>
                                                        Pin the Authority Server's TLS certificate
  suveren-gateway config set pin-tls off               Stop enforcing the TLS certificate pin
  suveren-gateway config set proxy <url>               Save an HTTP(S) proxy (http(s)://host:port)

Saved in ${join(DATA_DIR, 'config.json')}.
Precedence at start: --as-url flag > env SUVEREN_AS_URL > saved as-url >
default (${DEFAULT_AS_URL}).

proxy is a convenience for operators without shell access to set
HTTP_PROXY/HTTPS_PROXY themselves — those environment variables remain the
actual requirement (every process this gateway runs honours them directly)
and always win if already set; a saved proxy only fills in whichever of the
two is still unset. NO_PROXY is honoured too, read directly from the
environment (there is no saved equivalent). A loopback target (the control
plane and the MCP server talking to each other, or a local AI assistant) is
never proxied, independent of any of this.

pin-tls (default off, self-hosted Authority Servers with a stable signing
key) requires https:// and pins the Authority Server's TLS certificate
public key; every connection after it's established must present that same
key, or the gateway refuses it and locks (reason: as-tls-mismatch) until an
operator resolves it. It protects against a party on the network between
this gateway and the Authority Server presenting its OWN certificate — but
ONLY from the moment the fingerprint has actually been checked over a
second channel (phone, a separate trusted connection), which is why
--expect-fingerprint is mandatory: it is not optional confirmation, it IS
the check. Recommended: enable it once, right after pairing, from a network
you already trust.

--expect-fingerprint <sha256-hex>  The Authority Server's own TLS leaf
  certificate public-key fingerprint (SHA-256 of the SPKI — colons/spacing
  accepted, case-insensitive), confirmed over a second channel BEFORE
  running this command. Without it, this command refuses and prints how to
  obtain the fingerprint yourself.
  - If a pin is already on file and it DIFFERS, this refuses outright —
    clear the pairing first if the certificate changed intentionally (a
    NEW key; a renewal with the SAME key never needs this).
  - If none is on file yet, the value is trusted immediately if a
    signing-key pairing already exists, or staged for the very next
    sign-in's challenge to match (refused otherwise) if it doesn't.

Renewing the certificate under the SAME key (e.g. \`certbot renew
--reuse-key\`) keeps the pin working with no action needed; a renewal under
a NEW key locks the gateway until an operator re-pairs (clears
<dataDir>/as-pairing.json and signs in again).

Changes take effect on the next \`suveren-gateway start\` / \`restart\` — a
running gateway keeps using what it already resolved at its own startup.
`);
}

async function config(args) {
  const sub = args[0];

  if (sub === 'get') {
    const key = args[1];
    const saved = readConfig(DATA_DIR);
    if (!key) {
      console.log(`as-url:  ${resolveAsUrl(DATA_DIR)}`);
      console.log(`ca-file: ${saved.caFile ?? '(not set)'}`);
      console.log(`pin-tls: ${resolvePinTls(DATA_DIR) ? 'on' : 'off'}`);
      console.log(`proxy:   ${saved.proxyUrl ?? '(not set)'}`);
      return;
    }
    if (key === 'as-url') { console.log(resolveAsUrl(DATA_DIR)); return; }
    if (key === 'ca-file') { console.log(saved.caFile ?? ''); return; }
    if (key === 'pin-tls') { console.log(resolvePinTls(DATA_DIR) ? 'on' : 'off'); return; }
    if (key === 'proxy') { console.log(saved.proxyUrl ?? ''); return; }
    console.error(`Unknown config key: ${key}\n`);
    printConfigHelp();
    process.exit(2);
  }

  if (sub === 'set') {
    const key = args[1];
    const value = args[2];
    if (key === 'as-url') {
      if (!value) {
        console.error('Usage: suveren-gateway config set as-url <url>');
        process.exit(2);
      }
      const v = validateAsUrl(value);
      if (!v.ok) {
        console.error(`Invalid as-url: ${v.error}`);
        process.exit(1);
      }
      writeConfig(DATA_DIR, { asUrl: v.url });
      console.log(`Saved as-url: ${v.url}`);
      console.log('Restart to pick it up: suveren-gateway restart');
      return;
    }
    if (key === 'ca-file') {
      if (!value) {
        console.error('Usage: suveren-gateway config set ca-file <path>');
        process.exit(2);
      }
      const v = validateCaFile(value);
      if (!v.ok) {
        console.error(`Invalid ca-file: ${v.error}`);
        process.exit(1);
      }
      writeConfig(DATA_DIR, { caFile: v.path });
      console.log(`Saved ca-file: ${v.path}`);
      console.log('Restart to pick it up: suveren-gateway restart');
      return;
    }
    if (key === 'proxy') {
      if (!value) {
        console.error('Usage: suveren-gateway config set proxy <url>');
        process.exit(2);
      }
      const v = validateProxyUrl(value);
      if (!v.ok) {
        console.error(`Invalid proxy: ${v.error}`);
        process.exit(1);
      }
      writeConfig(DATA_DIR, { proxyUrl: v.url });
      console.log(`Saved proxy: ${v.url}`);
      console.log('Sets HTTP_PROXY/HTTPS_PROXY for every process this gateway starts, unless already set in the environment.');
      console.log('Restart to pick it up: suveren-gateway restart');
      return;
    }
    if (key === 'pin-tls') {
      if (value !== 'on' && value !== 'off') {
        console.error('Usage: suveren-gateway config set pin-tls on|off [--expect-fingerprint <sha256-hex>]');
        process.exit(2);
      }
      if (value === 'off') {
        writeConfig(DATA_DIR, { pinTls: false });
        console.log('Saved pin-tls: off');
        console.log('Restart to pick it up: suveren-gateway restart');
        return;
      }
      // value === 'on': requires the out-of-band fingerprint check (see
      // requireConfirmedFingerprint) — never trusts whatever the AS
      // happens to present at the next sign-in without one.
      const effectiveAsUrl = resolveAsUrl(DATA_DIR);
      const v = validatePinTls(effectiveAsUrl);
      if (!v.ok) {
        console.error(`Invalid pin-tls: ${v.error}`);
        process.exit(1);
      }
      const hex = requireConfirmedFingerprint(args, effectiveAsUrl);
      const committed = commitConfirmedFingerprint(DATA_DIR, effectiveAsUrl, hex);
      writeConfig(DATA_DIR, { pinTls: true });
      console.log(`Saved pin-tls: on (fingerprint ${formatFingerprint(hex)} confirmed)`);
      console.log(
        committed === 'pinned'
          ? 'Restart to pick it up: suveren-gateway restart'
          : 'Restart and sign in again — the first challenge must match this fingerprint: suveren-gateway restart',
      );
      return;
    }
    console.error(`Unknown config key: ${key}\n`);
    printConfigHelp();
    process.exit(2);
  }

  printConfigHelp();
  if (sub !== undefined && sub !== 'help' && sub !== '--help' && sub !== '-h') process.exit(2);
}

// ─── simulation: gateway-wide switch that blocks every real system ──────
//
// A mandate is bound to a PROFILE, not a connector — see suveren-gateway's
// tool-proxy.ts (`profileMatches`). Put a real connector and a simulated one
// on the same profile, and one mandate authorizes both. Simulation mode
// closes that generically: ON blocks every connector whose manifest carries
// no `simulation` marker, and forces every connector that DOES have one into
// its simulated mode, regardless of what credential value is on file.
// Mandates and profiles are unaffected; the Authority Server never learns
// about this — it is a purely local, gateway-side switch. See
// apps/mcp-server/src/lib/simulation-mode.ts for enforcement.

function printSimulationHelp() {
  console.log(`suveren-gateway simulation — gateway-wide switch that blocks every real system

Usage:
  suveren-gateway simulation on               Block every real connector (no confirmation — the safe direction)
  suveren-gateway simulation off              Make real systems reachable again (requires confirmation)
    [--confirm live]                          Non-interactive confirmation
  suveren-gateway simulation status           Show the saved setting and (if running) the live one

Changes take effect on the next \`suveren-gateway start\` / \`restart\`.
`);
}

async function printSimulationStatus() {
  const saved = resolveSimulation(DATA_DIR);
  console.log(`Saved:   ${saved ? 'on' : 'off'}`);
  try {
    const res = await fetch(`http://localhost:${SUVEREN_PORT}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = await res.json();
      const running = body.simulation === true;
      console.log(`Running: ${running ? 'on' : 'off'}${running !== saved ? '  (restart to apply the saved value)' : ''}`);
    }
  } catch {
    // Not reachable — the saved value is all there is to report.
  }
}

/** Read one line from stdin, or undefined if there is no TTY to prompt on
 *  (so a non-interactive caller gets a clean abort instead of a hang). */
async function promptLine(question) {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function simulation(args) {
  const sub = args[0] ?? 'status';

  if (sub === 'help' || sub === '--help' || sub === '-h') { printSimulationHelp(); return; }

  if (sub === 'status') {
    await printSimulationStatus();
    return;
  }

  if (sub === 'on') {
    // The safe direction — blocking real systems needs no confirmation.
    writeConfig(DATA_DIR, { simulation: true });
    console.log('Simulation mode: ON (saved) — every connector without a manifest "simulation" marker will be blocked.');
    console.log('Restart to pick it up: suveren-gateway restart');
    return;
  }

  if (sub === 'off') {
    console.error('Turning simulation mode OFF makes every real system reachable again: any connector');
    console.error('without a manifest "simulation" marker (e.g. a live Gmail or ERP account) will spawn');
    console.error('and execute for real the next time this gateway starts.');
    console.error('');
    let typed = flagValue(args, '--confirm');
    if (typed === undefined) {
      typed = await promptLine('Type "live" to confirm, or anything else to abort: ');
    }
    if (typed !== 'live') {
      console.error(typed === undefined
        ? 'No TTY to confirm on and no --confirm given — aborted. Simulation mode unchanged.'
        : 'Aborted — simulation mode unchanged.');
      process.exit(1);
    }
    writeConfig(DATA_DIR, { simulation: false });
    console.log('Simulation mode: OFF (saved) — real systems become reachable on next restart.');
    console.log('Restart to pick it up: suveren-gateway restart');
    return;
  }

  console.error(`Unknown: simulation ${sub}\n`);
  printSimulationHelp();
  process.exit(2);
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

/**
 * Is the login service currently running the gateway?
 *
 * `stop`, `start` and `restart` were all written before autostart existed and
 * all reason from the PID file — which a service-managed gateway never writes.
 * The result was that installing autostart silently broke the update path:
 * `stop` reported "not running", and `start` then hit a port held by a process
 * it could not see. Every command has to know about the service the same CLI
 * installs.
 */
function serviceRunning() {
  const os = platform();
  if (os === 'darwin') {
    const p = runQuiet('launchctl', ['print', `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`]);
    return p.status === 0 && /state = running/.test(p.stdout || '');
  }
  if (os === 'win32') {
    // NOT schtasks /Query: its LIST output is localized — a German Windows
    // prints "Wird ausgeführt", so matching the English word "Running" reports
    // every non-English machine as stopped, and restart silently falls back to
    // the manual path. Get-ScheduledTask's State is a .NET enum; its name is
    // English on every locale.
    const p = runQuiet('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-ScheduledTask -TaskName '${WIN_TASK_NAME}' -ErrorAction Stop).State`]);
    return p.status === 0 && /^Running/m.test((p.stdout || '').trim());
  }
  const p = runQuiet('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
  return (p.stdout || '').trim() === 'active';
}

/**
 * Restart through whichever service manager owns the process.
 *
 * Returns false when no service is running, so callers fall back to the manual
 * path. Restarting is what an upgrade needs: npm replaces the files on disk,
 * but the running process loaded them once at start and keeps serving the old
 * code until it is replaced.
 */
function serviceRestart() {
  if (!serviceRunning()) return false;
  const os = platform();
  if (os === 'darwin') {
    runQuiet('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`]);
  } else if (os === 'win32') {
    // NOT schtasks /End: it TerminateProcess()es only the task's ROOT process
    // (node server.js). No signal is delivered, so the shutdown handlers never
    // run and the control-plane / MCP children survive — still holding ports
    // 3400/3430, which makes the relaunched instance die on EADDRINUSE and
    // "restart" quietly become "stop". taskkill /T takes the whole tree.
    const like = SERVER_ENTRY.replace(/'/g, "''").replace(/([\[\]*?])/g, '`$1');
    runQuiet('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${like}*' } | ` +
      `ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F } | Out-Null`]);
    runQuiet('schtasks', ['/Run', '/TN', WIN_TASK_NAME]);
  } else {
    runQuiet('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  }
  return true;
}

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
  // eligible again.
  runQuiet('launchctl', ['enable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);

  // Bootstrap NOW only when nothing is already serving. With a gateway running,
  // loading the agent starts a second one that loses the port race and then
  // crash-loops under KeepAlive — so in that case the agent waits for the next
  // login, when the manual instance is gone. With nothing running there is no
  // conflict, and waiting would leave the user with a "service" that isn't
  // running and no obvious reason why.
  const running = await isAlreadyRunning();
  let loadedNow = false;
  if (!running) {
    const r = runQuiet('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    loadedNow = r.status === 0;
  }

  console.log(`✓ Suveren gateway installed as a login service.`);
  console.log(``);
  if (loadedNow) {
    console.log(`  It is running now, starts automatically at login, and restarts if it crashes.`);
  } else {
    console.log(`  It starts automatically from your NEXT login, and restarts if it crashes.`);
    if (running) console.log(`  Your current gateway keeps running — nothing was interrupted.`);
  }
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
    // Do NOT point at `service install` here: install deliberately does not
    // bootstrap while a gateway is already running (two would fight over the
    // port), so re-running it would change nothing and the advice would be a
    // dead end. Say plainly when it becomes active, and give the command that
    // actually loads it now.
    console.log(`  launchd: not loaded — starts at your next login`);
    console.log(`           to activate now: suveren-gateway stop && launchctl bootstrap gui/$(id -u) "${plistPath}"`);
  }
  console.log('');
  await status(); // process/health/vault line
}

// ─── Windows: Task Scheduler (ONLOGON) ──────────────────────────────────

const WIN_TASK_NAME = 'Suveren';

/**
 * Who the login task runs as, as `DOMAIN\user` when a domain is known.
 *
 * Without this the task is registered for ANY user's logon, which Windows only
 * lets an administrator do — a standard user just saw "Zugriff verweigert" and
 * had no way to install autostart at all. USERDOMAIN is the machine name on a
 * local account and the AD domain on a joined one; both are correct here.
 * Falling back to the bare username is fine — Task Scheduler resolves it
 * against the local machine.
 */
function windowsUserId() {
  const name = process.env.USERNAME || userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

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
    userId: windowsUserId(),
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
    // Locale-independent state (see serviceRunning): the schtasks LIST value
    // is localized; the PowerShell enum name is not.
    const st = runQuiet('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-ScheduledTask -TaskName '${WIN_TASK_NAME}' -ErrorAction Stop).State`]);
    const state = (st.stdout || '').trim();
    if (st.status === 0 && state) console.log(`  State:  ${state}`);
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

/** Is something accepting TCP connections on this port? */
function isPortListening(port, timeoutMs = 1_000) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Poll until the port accepts connections, or give up. */
async function waitForListening(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port, 500)) return true;
    await sleep(300);
  }
  return false;
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
  suveren-gateway start [--detach]           Run the gateway (foreground by default)
    [--as-url <url>]                         Authority Server URL (saved for next time)
    [--ca-file <path>]                       Internal CA bundle (saved for next time)
    [--proxy <url>]                          HTTP(S) proxy (saved for next time — see below)
    [--pin-tls --expect-fingerprint <hex>]   Pin the AS TLS certificate (saved; https:// only — see below)
    [--simulation]                           Block every real system (saved — see \`simulation help\`)
  suveren-gateway stop                       Stop a detached gateway
  suveren-gateway restart                    Stop, then start --detach
  suveren-gateway status                     Show running state + health (incl. simulation mode)
  suveren-gateway logs [--tail]               Print or tail ~/.suveren/gateway.log
  suveren-gateway service <cmd>               Run as a login service that survives reboot
                                              (install | uninstall | status)
  suveren-gateway config get [as-url|ca-file|pin-tls|proxy]  Print the resolved value(s)
  suveren-gateway config set as-url <url>     Save the Authority Server URL
  suveren-gateway config set ca-file <path>   Save a CA bundle for internal TLS
  suveren-gateway config set proxy <url>      Save an HTTP(S) proxy (see below)
  suveren-gateway config set pin-tls on --expect-fingerprint <hex>
                                              Pin the Authority Server's TLS certificate
                                              (see \`suveren-gateway config help\` for the fingerprint check)
  suveren-gateway config set pin-tls off      Stop enforcing the TLS certificate pin
  suveren-gateway simulation on|off|status    Block (or unblock) every real system
                                              (see \`suveren-gateway simulation help\`)
  suveren-gateway help                        Print this help

Environment:
  SUVEREN_CP_PORT     UI + API port  (default 3400)
  SUVEREN_MCP_PORT    MCP server port (default 3430)
  SUVEREN_DATA_DIR    Data directory (default ~/.suveren)
  SUVEREN_AS_URL      Authority Server URL — overrides the saved as-url
  SUVEREN_SIMULATION  1 to force simulation mode for this run — overrides the saved setting
  HTTP_PROXY / HTTPS_PROXY / NO_PROXY (upper or lower case)
                      Corporate proxy — honoured for every outbound call to the Authority
                      Server, the update checker, and a remote AI assistant endpoint. A
                      loopback target (127.0.0.1/localhost, incl. a local AI assistant) is
                      never proxied. These win over a saved \`config set proxy\`.

Authority Server resolution order: --as-url flag > SUVEREN_AS_URL env >
saved as-url (\`config set as-url\`) > default (${DEFAULT_AS_URL}).
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
    case 'config':  await config(argv.slice(1)); break;
    case 'simulation': await simulation(argv.slice(1)); break;
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
