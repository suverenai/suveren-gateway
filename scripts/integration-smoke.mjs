#!/usr/bin/env node
/**
 * Integration smoke test — covers the path the bundle smoke test never touched:
 * installing and starting a downstream MCP integration.
 *
 * Run against an ALREADY-STARTED gateway (see .github/workflows/bundle-smoke.yml).
 * Talks to the MCP server's /internal API directly, so it needs no Authority
 * Server account — the workflow pre-sets SUVEREN_INTERNAL_SECRET, which
 * server.js passes through to both children.
 *
 * Env:
 *   SUVEREN_MCP_PORT          MCP server port (default 3430)
 *   SUVEREN_INTERNAL_SECRET   shared CP<->MCP secret (required)
 *   SUVEREN_DATA_DIR          gateway data dir (default ~/.suveren)
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */

import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_PORT = process.env.SUVEREN_MCP_PORT ?? '3430';
const SECRET = process.env.SUVEREN_INTERNAL_SECRET ?? '';
const DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const INTEGRATIONS_DIR = process.env.SUVEREN_INTEGRATIONS_DIR ?? join(DATA_DIR, 'integrations');
const BASE = `http://127.0.0.1:${MCP_PORT}`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The integration we drive. `records` needs no credentials (its only field is
// optional), so it starts without any vault setup.
const TARGET = 'records';
const TARGET_PKG = '@humanagencyp/records-mcp';
const TARGET_BIN = 'records-mcp';

/** Hard budget for a single /health round-trip. Anything slower means the
 *  MCP server's event loop is blocked — it cannot serve the control plane
 *  either, which is what users see as "Couldn't load integrations". */
const HEALTH_BUDGET_MS = 2000;

const failures = [];
const isCI = !!process.env.GITHUB_ACTIONS;

function fail(check, message) {
  failures.push({ check, message });
  if (isCI) console.log(`::error::[${check}] ${message}`);
  console.log(`  FAIL  ${check}: ${message}`);
}

function pass(check, message) {
  console.log(`  ok    ${check}: ${message}`);
}

function warn(check, message) {
  if (isCI) console.log(`::warning::[${check}] ${message}`);
  console.log(`  warn  ${check}: ${message}`);
}

function group(title) {
  console.log(isCI ? `::group::${title}` : `\n=== ${title} ===`);
}

function endGroup() {
  if (isCI) console.log('::endgroup::');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function internalFetch(path, init = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': SECRET,
      ...(init.headers ?? {}),
    },
  });
}

/**
 * One /health probe. Distinguishes three outcomes:
 *   refused → not listening yet (fine, still booting)
 *   timeout → listening but NOT answering = blocked event loop (the bug)
 *   ok      → answered, with latency
 */
async function probeHealth() {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(HEALTH_BUDGET_MS) });
    await res.text();
    return { kind: 'ok', ms: Math.round(performance.now() - started) };
  } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? '';
    if (code === 'ECONNREFUSED') return { kind: 'refused' };
    if (err?.name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT') {
      return { kind: 'timeout', ms: Math.round(performance.now() - started) };
    }
    return { kind: 'error', message: err?.message ?? String(err) };
  }
}

// ─── Check 1: the MCP server stays responsive while it installs ────────────
//
// crm + records are personalDefault, so a fresh data dir makes the MCP server
// npm-install both inside its app.listen callback. ensureInstalled() uses
// execSync, which blocks the event loop for the whole install — the port is
// bound (connections accepted) but nothing is answered.

async function checkResponsiveDuringInstall() {
  group('Check 1 — MCP server responsive during boot-time install');
  const deadline = Date.now() + 240_000;
  let sawAccepted = false;
  let firstOkAt = null;
  const startedAt = Date.now();
  const timeouts = [];
  let okCount = 0;
  let maxOkMs = 0;

  while (Date.now() < deadline) {
    const r = await probeHealth();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (r.kind === 'ok') {
      sawAccepted = true;
      okCount++;
      maxOkMs = Math.max(maxOkMs, r.ms);
      if (firstOkAt === null) {
        firstOkAt = Date.now();
        console.log(`  [${elapsed}s] first response (${r.ms}ms)`);
      }
      // Once the integrations are up, we've covered the install window.
      const status = await integrationStatus();
      if (status?.some(s => s.id === TARGET)) break;
    } else if (r.kind === 'timeout') {
      sawAccepted = true;
      timeouts.push({ elapsed, ms: r.ms });
      console.log(`  [${elapsed}s] TIMEOUT after ${r.ms}ms — event loop blocked`);
    } else if (r.kind === 'refused') {
      console.log(`  [${elapsed}s] connection refused (not listening yet)`);
    } else {
      console.log(`  [${elapsed}s] error: ${r.message}`);
    }
    await sleep(250);
  }

  if (!sawAccepted) {
    fail('responsive-during-install', `MCP server never accepted a connection on ${BASE} within 240s`);
  } else if (timeouts.length > 0) {
    const worst = timeouts[timeouts.length - 1];
    fail(
      'responsive-during-install',
      `${timeouts.length} /health probe(s) exceeded ${HEALTH_BUDGET_MS}ms while the MCP server was installing ` +
      `(last at +${worst.elapsed}s). The event loop is blocked by execSync('npm install') in ` +
      `ensureInstalled() — during this window the control plane cannot fetch /internal/manifests, ` +
      `which surfaces in the UI as "Couldn't load integrations".`,
    );
  } else {
    pass('responsive-during-install', `${okCount} probes, worst ${maxOkMs}ms, no timeouts`);
  }

  if (firstOkAt) {
    const unusable = ((firstOkAt - startedAt) / 1000).toFixed(1);
    console.log(`  MCP server was unresponsive for ~${unusable}s after the probe began`);
  }
  endGroup();
}

async function integrationStatus() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(HEALTH_BUDGET_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    return body.integrations ?? null;
  } catch {
    return null;
  }
}

// ─── Check 2: the target integration actually started ──────────────────────

async function checkTargetRunning() {
  group(`Check 2 — ${TARGET} integration is running`);
  const status = await integrationStatus();
  if (!status) {
    fail('target-running', 'could not read /health');
    endGroup();
    return false;
  }
  const entry = status.find(s => s.id === TARGET);
  if (!entry) {
    fail('target-running', `${TARGET} is not in the registry — auto-registration did not happen`);
    endGroup();
    return false;
  }
  if (!entry.running) {
    fail('target-running', `${TARGET} is registered but NOT running${entry.error ? ` — ${entry.error}` : ''}`);
    endGroup();
    return false;
  }
  pass('target-running', `${TARGET} running with ${entry.toolCount} tools`);
  endGroup();
  return true;
}

// ─── Check 3: a broken install is detected and repaired, not skipped ───────
//
// ensureInstalled()'s guard is existsSync() on the package DIRECTORY only. An
// install that was interrupted (timeout, Ctrl+C, AV lock) leaves that directory
// behind without a working bin shim — the guard then reports "installed", the
// spawn fails instantly, and no amount of clicking Start can ever repair it.
// We simulate that by deleting the bin shim and leaving the package dir.

async function checkPartialInstallRecovery() {
  group('Check 3 — partial install is repaired on restart');

  const binDir = join(INTEGRATIONS_DIR, 'node_modules', '.bin');
  const pkgDir = join(INTEGRATIONS_DIR, 'node_modules', ...TARGET_PKG.split('/'));

  if (!existsSync(pkgDir)) {
    warn('partial-install-recovery', `${pkgDir} missing — skipping (nothing was installed)`);
    endGroup();
    return;
  }

  const removeRes = await internalFetch(`/internal/remove-integration/${TARGET}`, { method: 'DELETE' });
  console.log(`  removed ${TARGET} from registry (HTTP ${removeRes.status})`);

  let removed = 0;
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) {
      if (f === TARGET_BIN || f.startsWith(`${TARGET_BIN}.`)) {
        rmSync(join(binDir, f), { force: true });
        removed++;
        console.log(`  deleted bin shim: ${f}`);
      }
    }
  }
  if (removed === 0) warn('partial-install-recovery', `no bin shim found for ${TARGET_BIN} — the spawn may rely on PATH resolution alone`);
  console.log(`  package dir left in place: ${pkgDir} (this is what the existsSync guard sees)`);

  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'content', 'integrations', `${TARGET}.json`), 'utf8'));
  const res = await internalFetch('/internal/add-integration', {
    method: 'POST',
    body: JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      command: manifest.mcp.command,
      args: manifest.mcp.args,
      env: manifest.mcp.env,
      envKeys: {},
      optionalEnvKeys: { DATABASE_URL: `${TARGET}.databaseUrl` },
      profile: manifest.profile,
      toolGating: manifest.toolGating,
      npmPackage: manifest.npmPackage,
      enabled: true,
    }),
  });

  const body = await res.json().catch(() => ({}));
  console.log(`  add-integration -> HTTP ${res.status} ${JSON.stringify(body)}`);

  // NOTE: this endpoint answers 200 even when the start failed — the failure is
  // reported as a `warning` field, which the UI renders as a GREEN banner.
  if (body.warning) {
    fail(
      'partial-install-recovery',
      `restart after a broken install returned "${body.warning}" instead of reinstalling. ` +
      `ensureInstalled() short-circuits on existsSync(packageDir), so a half-installed package ` +
      `can never self-repair — every subsequent Start fails instantly.`,
    );
  } else if (!Array.isArray(body.tools) || body.tools.length === 0) {
    fail('partial-install-recovery', `start reported success but discovered 0 tools: ${JSON.stringify(body)}`);
  } else {
    pass('partial-install-recovery', `recovered and discovered ${body.tools.length} tools`);
  }
  endGroup();
}

// ─── Check 4: every manifest spawns a cross-platform command ───────────────

function checkManifestPortability() {
  group('Check 4 — manifests are spawnable on Windows');
  const dir = join(REPO_ROOT, 'content', 'integrations');
  const shells = new Set(['sh', 'bash', 'zsh', '/bin/sh', '/bin/bash', 'cmd', 'cmd.exe', 'powershell']);
  let checked = 0;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const command = manifest?.mcp?.command;
    if (!command) continue;
    checked++;

    if (shells.has(command)) {
      fail(
        'manifest-portability',
        `${file}: spawns "${command}", which does not exist on Windows. ` +
        `Spawn the binary directly and pass arguments as an array instead.`,
      );
    }
    const args = manifest?.mcp?.args ?? [];
    const interpolated = args.filter(a => typeof a === 'string' && /\$\{?[A-Z_][A-Z0-9_]*\}?/.test(a));
    if (interpolated.length > 0) {
      fail(
        'manifest-portability',
        `${file}: args use shell variable syntax (${interpolated.join(', ')}), which is not expanded by ` +
        `cmd.exe. Build the value in code from the resolved env instead.`,
      );
    }
  }
  if (failures.every(f => f.check !== 'manifest-portability')) {
    pass('manifest-portability', `${checked} manifests use directly-spawnable commands`);
  }
  endGroup();
}

// ─── Main ──────────────────────────────────────────────────────────────────

if (!SECRET) {
  console.error('SUVEREN_INTERNAL_SECRET is not set — the /internal endpoints will reject every call.');
  process.exit(1);
}

console.log(`Integration smoke test`);
console.log(`  platform:         ${process.platform} (${process.arch})`);
console.log(`  MCP server:       ${BASE}`);
console.log(`  integrations dir: ${INTEGRATIONS_DIR}`);

checkManifestPortability();
await checkResponsiveDuringInstall();
const running = await checkTargetRunning();
if (running) await checkPartialInstallRecovery();

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f.check}: ${f.message}`);
  process.exit(1);
}
console.log('All integration checks passed.');
