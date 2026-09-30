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
import { homedir } from 'node:os';
import { resolveCaFile } from './lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

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
const DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const savedCaFile = resolveCaFile(DATA_DIR);
if (savedCaFile && process.env.NODE_EXTRA_CA_CERTS !== savedCaFile) {
  const child = spawn(
    process.execPath,
    [THIS_FILE, ...process.argv.slice(2)],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: savedCaFile }, stdio: 'inherit' },
  );
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
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
