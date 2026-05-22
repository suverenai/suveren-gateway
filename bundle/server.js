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

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  HAP_UI_DIST: UI_DIST,
  SUVEREN_MANIFESTS_DIR: MANIFESTS_DIR,
  SUVEREN_PROFILES_DIR: PROFILES_DIR,
  // Single shared internal secret so CP↔MCP authenticate the bridge.
  SUVEREN_INTERNAL_SECRET: process.env.SUVEREN_INTERNAL_SECRET ?? randomHex(32),
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
