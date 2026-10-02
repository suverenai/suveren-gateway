#!/usr/bin/env node
/**
 * Production entry — supervises the control-plane (Express + UI static)
 * and the MCP server as two child processes. Both Docker (`CMD node
 * server.js`) and the npm CLI use this same entry point.
 *
 * Lives next to the bundled `dist/` produced by bundle/build.ts.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir, constants as osConstants } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolveCaFile, resolveSimulation } from './lib/config.mjs';
import { readPolicy } from './lib/policy.mjs';
import { unsupportedNodeReason } from './lib/node-version.mjs';

// Docker and the login service start this file directly, not through the CLI,
// so it checks the Node version too (see lib/node-version.mjs).
const nodeReason = unsupportedNodeReason(process.versions.node);
if (nodeReason) {
  console.error(`[suveren-gateway] ${nodeReason}`);
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/** Exit this process the way a shell reports a signal-terminated child: 128
 *  plus the signal number, so a caller (or a test) can tell "exited cleanly
 *  with code N" from "was killed by signal N" instead of both collapsing to
 *  a bare exit(1). */
function exitLikeChild(code, signal) {
  if (signal) {
    const num = osConstants.signals?.[signal];
    process.exit(128 + (typeof num === 'number' ? num : 0));
  }
  process.exit(code ?? 0);
}

// ─── Internal CA bundle (--ca-file / `config set ca-file`) ─────────────────
//
// `NODE_EXTRA_CA_CERTS` is read by Node ONLY at process start, before any of
// our own code runs — setting `process.env.NODE_EXTRA_CA_CERTS` here would be
// too late to affect THIS process's own TLS. It still needs to reach the
// control-plane and MCP-server children below (those are fresh processes, so
// setting it in the `env` object we spawn them with DOES work), but this
// process itself also makes its own outbound calls in a few paths.
//
// This is the ONE place that has to handle it for every way the gateway can
// start: `suveren-gateway start` (the CLI just spawns this same file),
// autostart (launchd/systemd/Task Scheduler spawn this file DIRECTLY,
// bypassing the CLI's own flag handling), and Docker (`CMD node server.js`).
// Re-exec once, here, before anything network-related happens, rather than
// have three separate top-level entry points each remember to do it.
//
// Guarded by SUVEREN_CA_REEXEC_DONE, not by comparing NODE_EXTRA_CA_CERTS to
// the saved path: when the caller's shell already has its OWN
// NODE_EXTRA_CA_CERTS set (a corporate proxy CA, say), overwriting it would
// silently break trust for everything else this process does (npm registry
// fetches for on-demand integrations, other HTTPS calls) — so the two are
// MERGED into one combined PEM file instead. Comparing against that combined
// path would never match the saved path alone, so the guard has to be a
// dedicated marker, not a value comparison (which would also re-exec forever).
const DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const savedCaFile = resolveCaFile(DATA_DIR);
if (savedCaFile && !process.env.SUVEREN_CA_REEXEC_DONE) {
  let effectiveCaFile = savedCaFile;
  /** Set only when a combined-CA temp dir was actually created, so it can be
   *  cleaned up on exit rather than left behind on every restart. */
  let combinedDirToClean = null;
  const existingCaFile = process.env.NODE_EXTRA_CA_CERTS;
  if (existingCaFile && existingCaFile !== savedCaFile && existsSync(existingCaFile)) {
    try {
      const combined =
        readFileSync(existingCaFile, 'utf8').trimEnd() + '\n' + readFileSync(savedCaFile, 'utf8').trimEnd() + '\n';
      const combinedDir = mkdtempSync(join(tmpdir(), 'suveren-ca-'));
      const combinedPath = join(combinedDir, 'combined-ca-certs.pem');
      writeFileSync(combinedPath, combined, 'utf8');
      effectiveCaFile = combinedPath;
      combinedDirToClean = combinedDir;
      console.error(
        `[suveren-gateway] Merged --ca-file with the existing NODE_EXTRA_CA_CERTS (${existingCaFile}) ` +
          `so neither trust source is lost.`,
      );
    } catch (err) {
      console.error(
        `[suveren-gateway] Could not merge NODE_EXTRA_CA_CERTS with the saved --ca-file (${err.message}); ` +
          `using the saved --ca-file alone, which may break other HTTPS calls that relied on the existing one.`,
      );
    }
  }

  const child = spawn(
    process.execPath,
    [THIS_FILE, ...process.argv.slice(2)],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: effectiveCaFile, SUVEREN_CA_REEXEC_DONE: '1' }, stdio: 'inherit' },
  );
  child.on('exit', (code, signal) => {
    if (combinedDirToClean) {
      try { rmSync(combinedDirToClean, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    exitLikeChild(code, signal);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
  // Stop here — the re-executed child (which now has NODE_EXTRA_CA_CERTS set
  // from its own start) is the one that spawns control-plane + mcp-server;
  // this parent's only job from here is to relay its exit code and signals,
  // both wired above. Top-level await pauses the rest of THIS module's
  // evaluation (the spawns below) until that promise settles, which only
  // happens via the exit handler calling process.exit().
  await new Promise(() => {});
}

// Reached only in the re-executed child (or when no --ca-file is set at
// all). SUVEREN_CA_REEXEC_DONE is bookkeeping for the block above — internal
// to this file, and meaningless (worse, confusing) to anything downstream —
// so it must not ride along in the env every child process below inherits
// via `...process.env`, all the way down to individual integrations.
delete process.env.SUVEREN_CA_REEXEC_DONE;

const CP_PORT = process.env.SUVEREN_CP_PORT ?? '3400';
const MCP_PORT = process.env.SUVEREN_MCP_PORT ?? '3430';
const UI_DIST = process.env.HAP_UI_DIST ?? join(__dirname, 'dist', 'ui');
// Integration manifests + profile catalog ship inside the bundle so a
// fresh `npm install -g` install has working integrations and profiles
// without the user needing to clone anything. Env-var overrides still
// win for advanced users / Docker.
const MANIFESTS_DIR = process.env.SUVEREN_MANIFESTS_DIR ?? join(__dirname, 'content', 'integrations');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(__dirname, 'profiles');

const env = {
  ...process.env,
  NODE_ENV: 'production',
  SUVEREN_CP_PORT: CP_PORT,
  SUVEREN_MCP_PORT: MCP_PORT,
  // The control plane talks to the MCP server over this URL. It defaults to
  // 127.0.0.1:3430 in mcp-bridge.ts, so if the user overrode SUVEREN_MCP_PORT
  // without also setting this, every CP→MCP internal call hit the wrong port
  // and failed — surfacing as "Couldn't load integrations". Derive it here so
  // the two can never drift. An explicit override still wins (e.g. Docker).
  SUVEREN_MCP_INTERNAL_URL: process.env.SUVEREN_MCP_INTERNAL_URL ?? `http://127.0.0.1:${MCP_PORT}`,
  HAP_UI_DIST: UI_DIST,
  SUVEREN_MANIFESTS_DIR: MANIFESTS_DIR,
  SUVEREN_PROFILES_DIR: PROFILES_DIR,
  // Single shared internal secret so CP↔MCP authenticate the bridge.
  SUVEREN_INTERNAL_SECRET: process.env.SUVEREN_INTERNAL_SECRET ?? randomHex(32),
  // Simulation mode — IT policy (see lib/policy.mjs) wins UNCONDITIONALLY,
  // ahead of even an explicit env var: that is what "locked" means. Below
  // that: an explicit env var (set directly, or by `start --simulation`
  // setting process.env for THIS run — see bundle/bin/suveren-gateway.js)
  // wins; otherwise the saved config.json value, which is what
  // `suveren-gateway simulation on|off` changes for every future
  // start/restart, including autostart (which spawns this file directly,
  // bypassing the CLI's own flag handling).
  SUVEREN_SIMULATION:
    readPolicy().policy.simulation !== undefined
      ? (readPolicy().policy.simulation ? '1' : '0')
      : (process.env.SUVEREN_SIMULATION ?? (resolveSimulation(DATA_DIR) ? '1' : '0')),
  // Passed by the login service (see bundle/lib/autostart-templates.mjs) so the
  // control-plane knows a human is NOT sitting in front of a terminal watching
  // it start — that is when a locked gateway needs to announce itself.
  ...(process.argv.includes('--autostart') ? { SUVEREN_AUTOSTART: '1' } : {}),
};

const cp = spawn(
  process.execPath,
  [join(__dirname, 'dist', 'control-plane', 'index.mjs')],
  { env, stdio: 'inherit' },
);

const mcp = spawn(
  process.execPath,
  [join(__dirname, 'dist', 'mcp-server', 'http.mjs')],
  { env, stdio: 'inherit' },
);

const children = [
  { name: 'control-plane', proc: cp },
  { name: 'mcp-server', proc: mcp },
];

// If either child dies, take down the other one and exit. Docker / launchd
// will then decide whether to restart us.
for (const { name, proc } of children) {
  proc.on('exit', (code, signal) => {
    console.error(`[suveren-gateway] ${name} exited (code=${code} signal=${signal}); shutting down`);
    for (const other of children) {
      if (other.proc !== proc && other.proc.exitCode === null) {
        other.proc.kill('SIGTERM');
      }
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Forward graceful-shutdown signals to children so they get a chance to
// flush state. Windows doesn't deliver SIGTERM the same way; SIGINT works.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const { proc } of children) proc.kill(sig);
  });
}

console.error(`[suveren-gateway] up — UI+API: http://localhost:${CP_PORT}  ·  MCP: http://localhost:${MCP_PORT}`);

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
