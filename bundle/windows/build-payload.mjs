#!/usr/bin/env node
/**
 * Assemble the OFFLINE Windows installer payload (W2 —
 * suveren-as/docs/work-plan.md "Added 2026-10-02 — Windows installer").
 *
 * A company laptop typically cannot reach the public npm registry at all, so
 * everything the gateway needs at runtime has to be ON DISK before it ever
 * starts: the Node runtime itself, the gateway bundle, and every connector
 * pinned by content/integrations/*.json, installed with the SAME Node build
 * that will run them (native modules like better-sqlite3 ship a prebuilt
 * binary keyed to the exact platform + Node ABI — install with the wrong one
 * and the connector crashes on its first database call).
 *
 * Writes:
 *   bundle/windows/payload/
 *     ├── node/            official Node.js win-x64 build (verified SHA-256)
 *     ├── gateway/          bundle/dist (the npm-publishable bundle)
 *     └── integrations/     every manifest's pinned connector, pre-installed
 *
 * Usage:
 *   node bundle/windows/build-payload.mjs
 *
 * Requires bundle/dist to already exist (run `node bundle/build.mjs
 * --build-apps` plus `npm install --omit=dev` in bundle/dist first — see
 * publish-npm.yml / bundle-smoke.yml for the existing recipe).
 *
 * The npm-install-connectors step only runs on win32: it execs the
 * downloaded node.exe directly, which is a no-op (wrong platform binary) on
 * any other OS. Everywhere else, that step is skipped with a warning so the
 * download/extract/assemble logic can still be iterated on locally.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

const GATEWAY_BUNDLE_DIR = process.env.GATEWAY_BUNDLE_DIR ?? join(REPO_ROOT, 'bundle/dist');
const MANIFESTS_DIR = process.env.SUVEREN_MANIFESTS_DIR ?? join(REPO_ROOT, 'content/integrations');
const PAYLOAD_DIR = process.env.PAYLOAD_DIR ?? join(__dirname, 'payload');
// Allow pinning a specific Node build for reproducibility; otherwise pick the
// newest 22.x LTS automatically from nodejs.org's own index.
const NODE_VERSION_OVERRIDE = process.env.WINDOWS_PAYLOAD_NODE_VERSION; // e.g. "22.14.0"

console.log('[build-payload] assembling Windows offline payload …');

if (!existsSync(GATEWAY_BUNDLE_DIR) || !existsSync(join(GATEWAY_BUNDLE_DIR, 'server.js'))) {
  console.error(
    `[build-payload] ${GATEWAY_BUNDLE_DIR} does not look like a built bundle (no server.js). ` +
    `Run \`node bundle/build.mjs --build-apps\` and \`npm install --omit=dev\` in it first.`,
  );
  process.exit(1);
}
if (!existsSync(join(MANIFESTS_DIR, 'index.json'))) {
  console.error(`[build-payload] No manifests at ${MANIFESTS_DIR} (expected index.json).`);
  process.exit(1);
}

rmSync(PAYLOAD_DIR, { recursive: true, force: true });
mkdirSync(PAYLOAD_DIR, { recursive: true });

// ─── 1. Official Node.js win-x64, verified against the project's own
//        SHASUMS256.txt (not re-derived — this checks the download arrived
//        intact and matches what Node's release process published, which is
//        the literal ask; full GPG verification of the release key is a
//        separate, heavier step we don't need for integrity-of-transfer). ──

async function resolveNodeVersion() {
  if (NODE_VERSION_OVERRIDE) return NODE_VERSION_OVERRIDE;
  console.log('[build-payload] looking up the newest Node 22 LTS release …');
  const res = await fetch('https://nodejs.org/dist/index.json');
  if (!res.ok) throw new Error(`nodejs.org/dist/index.json: HTTP ${res.status}`);
  /** @type {Array<{ version: string, lts: string | false }>} */
  const index = await res.json();
  const candidate = index.find((e) => e.lts && e.version.startsWith('v22.'));
  if (!candidate) throw new Error('No Node 22 LTS release found in nodejs.org/dist/index.json');
  return candidate.version.replace(/^v/, '');
}

async function downloadNode(version) {
  const base = `https://nodejs.org/dist/v${version}`;
  const archiveName = `node-v${version}-win-x64.zip`;
  const tmp = mkdtempSync(join(tmpdir(), 'suveren-node-dl-'));
  const archivePath = join(tmp, archiveName);

  console.log(`[build-payload] downloading ${archiveName} …`);
  const archiveRes = await fetch(`${base}/${archiveName}`);
  if (!archiveRes.ok) throw new Error(`${archiveName}: HTTP ${archiveRes.status}`);
  writeFileSync(archivePath, Buffer.from(await archiveRes.arrayBuffer()));

  console.log(`[build-payload] verifying SHA-256 against ${base}/SHASUMS256.txt …`);
  const sumsRes = await fetch(`${base}/SHASUMS256.txt`);
  if (!sumsRes.ok) throw new Error(`SHASUMS256.txt: HTTP ${sumsRes.status}`);
  const sums = await sumsRes.text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(archiveName));
  if (!line) throw new Error(`${archiveName} not listed in SHASUMS256.txt`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();

  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
  }
  console.log(`[build-payload] SHA-256 OK: ${actual}`);

  console.log(`[build-payload] extracting …`);
  // bsdtar (the `tar` shipped with modern Windows and macOS) extracts .zip
  // too, via libarchive — so this one call works on every CI runner OS
  // without an extra unzip dependency.
  execFileSync('tar', ['-xf', archivePath, '-C', tmp], { stdio: 'inherit' });
  const extractedDir = join(tmp, `node-v${version}-win-x64`);
  if (!existsSync(extractedDir)) {
    throw new Error(`Expected extracted dir ${extractedDir} not found after tar -xf`);
  }

  const nodeOut = join(PAYLOAD_DIR, 'node');
  cpSync(extractedDir, nodeOut, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  return nodeOut;
}

const nodeVersion = await resolveNodeVersion();
console.log(`[build-payload] using Node ${nodeVersion} (win-x64)`);
const nodeDir = await downloadNode(nodeVersion);

// ─── 2. Gateway bundle ──────────────────────────────────────────────────

console.log(`[build-payload] copying gateway bundle from ${GATEWAY_BUNDLE_DIR} …`);
const gatewayOut = join(PAYLOAD_DIR, 'gateway');
cpSync(GATEWAY_BUNDLE_DIR, gatewayOut, { recursive: true });

// ─── 3. Pinned connectors, installed with the BUNDLED node/npm ──────────
//
// Must exactly mirror ensureInstalled()'s shape (apps/mcp-server/src/lib/
// integration-manager.ts): one shared `integrations/` directory, each
// package installed via `npm install --no-fund --no-audit <pkg>@<version>`,
// so SUVEREN_OFFLINE=1's version check (readInstalledVersion/isUsableInstall)
// finds exactly what it expects at runtime.

function readManifestPins() {
  const index = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'index.json'), 'utf8'));
  /** @type {Array<{ id: string, npmPackage: string, npmVersion: string }>} */
  const pins = [];
  for (const [id, relPath] of Object.entries(index.integrations ?? {})) {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, relPath), 'utf8'));
    if (manifest.npmPackage && manifest.npmVersion) {
      pins.push({ id, npmPackage: manifest.npmPackage, npmVersion: manifest.npmVersion });
    }
  }
  return pins;
}

const pins = readManifestPins();
console.log(`[build-payload] ${pins.length} pinned connector(s) to install offline:`);
for (const p of pins) console.log(`  - ${p.id}: ${p.npmPackage}@${p.npmVersion}`);

const integrationsOut = join(PAYLOAD_DIR, 'integrations');
mkdirSync(integrationsOut, { recursive: true });
writeFileSync(
  join(integrationsOut, 'package.json'),
  JSON.stringify({ name: 'suveren-integrations', version: '1.0.0', private: true }, null, 2) + '\n',
);

if (process.platform !== 'win32') {
  console.warn(
    `[build-payload] WARNING: skipping connector installs — this step execs the downloaded Windows ` +
    `node.exe/npm.cmd, which cannot run on ${process.platform}. Run this script on windows-latest (CI does) ` +
    `to produce a complete payload. The download/extract/assemble steps above still ran and can be checked.`,
  );
} else {
  const npmCmd = join(nodeDir, 'npm.cmd');
  if (!existsSync(npmCmd)) throw new Error(`Bundled npm not found at ${npmCmd}`);
  for (const p of pins) {
    const spec = `${p.npmPackage}@${p.npmVersion}`;
    console.log(`[build-payload] npm install ${spec} (via bundled Node) …`);
    execFileSync(npmCmd, ['install', '--no-fund', '--no-audit', spec], {
      cwd: integrationsOut,
      stdio: 'inherit',
      shell: true, // npm.cmd on Windows
    });
  }
  // Prove every pin landed at exactly the pinned version before shipping —
  // the same invariant ensureInstalled() enforces at runtime, checked once
  // here instead of discovered on a user's machine.
  console.log('[build-payload] verifying installed versions match the pins …');
  for (const p of pins) {
    const pkgJsonPath = join(integrationsOut, 'node_modules', ...p.npmPackage.split('/'), 'package.json');
    if (!existsSync(pkgJsonPath)) {
      throw new Error(`${p.npmPackage}: not installed after \`npm install ${p.npmPackage}@${p.npmVersion}\``);
    }
    const installed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
    if (installed !== p.npmVersion) {
      throw new Error(`${p.npmPackage}: installed ${installed}, expected pinned ${p.npmVersion}`);
    }
  }
  console.log('[build-payload] all pinned connectors verified.');
}

const installedCount = existsSync(join(integrationsOut, 'node_modules'))
  ? readdirSync(join(integrationsOut, 'node_modules')).length
  : 0;
console.log(`[build-payload] done.`);
console.log(`  node:         ${nodeDir}`);
console.log(`  gateway:      ${gatewayOut}`);
console.log(`  integrations: ${integrationsOut} (${pins.length} pinned, ${installedCount} installed on disk)`);
