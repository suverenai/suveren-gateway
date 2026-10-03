/**
 * Offline mode (`SUVEREN_OFFLINE=1`) — Windows installer (W2, doc/
 * suveren-as/docs/work-plan.md "Added 2026-10-02 — Windows installer").
 *
 * A company laptop typically cannot reach the public npm registry at all
 * (blocked by policy, or no route out). The installer ships
 * SUVEREN_INTEGRATIONS_DIR pre-populated with every manifest's pinned
 * connector, built with the SAME Node binary that runs it. With
 * SUVEREN_OFFLINE=1, `ensureInstalled` must NEVER shell out to npm — not
 * "try npm, then fall back" — because a half-reachable registry (corporate
 * proxy captive portal, slow DNS) fails in confusing, slow ways; refusing
 * instantly with a clear reason is the safer and faster failure mode.
 *
 * Reuses the same real, non-mocked `npm` fixture (fake-npm.mjs) as
 * ensure-installed-pin.test.ts so "npm was never called" is asserted against
 * the exact log that a real npm invocation would have written to — not a
 * mock's own bookkeeping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const FAKE_NPM_DIR = join(import.meta.dirname, 'fixtures', 'fake-npm');
const SERVER_FIXTURE = join(import.meta.dirname, 'fixtures', 'delayable-mcp-server.mjs');

let workDir: string;
let integrationsDir: string;
let manifestsDir: string;
let npmLog: string;

let originalPath: string | undefined;
let originalIntegrationsDir: string | undefined;
let originalOffline: string | undefined;

// Dynamic import AFTER env vars are set — see ensure-installed-pin.test.ts's
// module docstring for why a static top-level import can't do this (the
// module reads SUVEREN_INTEGRATIONS_DIR / SUVEREN_OFFLINE into module-level
// consts at import time).
let IntegrationManager: typeof import('../src/lib/integration-manager').IntegrationManager;
let loadManifests: typeof import('../src/lib/manifest-loader').loadManifests;

type MinimalManifest = Record<string, unknown>;

function manifest(id: string, npmPackage: string, npmVersion: string): MinimalManifest {
  return {
    id,
    name: id,
    version: '1',
    description: 'test fixture',
    icon: 'wrench',
    profile: 'test-profile',
    mcp: { command: process.execPath, args: [SERVER_FIXTURE] },
    credentials: { fields: [], envMapping: {} },
    oauth: null,
    npmPackage,
    npmVersion,
    toolGating: { default: { executionMapping: {} }, overrides: {} },
  };
}

function writeManifests(entries: Record<string, MinimalManifest>) {
  const index: Record<string, string> = {};
  for (const [id, m] of Object.entries(entries)) {
    index[id] = `${id}.json`;
    writeFileSync(join(manifestsDir, `${id}.json`), JSON.stringify(m));
  }
  writeFileSync(join(manifestsDir, 'index.json'), JSON.stringify({ integrations: index }));
}

/** Directly fabricate a real, usable on-disk install — no fake-npm call. */
function preInstall(pkg: string, version: string): void {
  const pkgDir = join(integrationsDir, 'node_modules', ...pkg.split('/'));
  const binDir = join(integrationsDir, 'node_modules', '.bin');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const binName = pkg.split('/').pop()!;
  writeFileSync(join(pkgDir, 'index.js'), '// pre-existing fixture install\n');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkg, version, bin: { [binName]: 'index.js' }, main: 'index.js' }),
  );
  writeFileSync(join(binDir, binName), '#!/usr/bin/env node\n');
}

function npmCalls(): string[] {
  if (!existsSync(npmLog)) return [];
  return readFileSync(npmLog, 'utf8').split('\n').filter(Boolean);
}

function config(id: string, npmPackage: string): import('../src/lib/integration-registry').IntegrationConfig {
  return {
    id,
    name: id,
    command: process.execPath,
    args: [SERVER_FIXTURE],
    envKeys: {},
    profile: null,
    npmPackage,
    enabled: true,
  };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'hap-offline-test-'));
  integrationsDir = join(workDir, 'integrations');
  manifestsDir = join(workDir, 'manifests');
  npmLog = join(workDir, 'npm-calls.log');
  mkdirSync(integrationsDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  originalPath = process.env.PATH;
  originalIntegrationsDir = process.env.SUVEREN_INTEGRATIONS_DIR;
  originalOffline = process.env.SUVEREN_OFFLINE;
  // fake-npm is still on PATH — if offline mode has a bug and calls it
  // anyway, these tests would catch that via npmCalls(), not silently pass.
  process.env.PATH = `${FAKE_NPM_DIR}${delimiter}${originalPath ?? ''}`;
  process.env.SUVEREN_INTEGRATIONS_DIR = integrationsDir;
  process.env.SUVEREN_OFFLINE = '1';
  process.env.FAKE_NPM_LOG = npmLog;

  writeManifests({
    'shipped': manifest('shipped', 'shipped-pkg', '2.0.0'),
    'missing': manifest('missing', 'missing-pkg', '2.0.0'),
    'wrong-version': manifest('wrong-version', 'wrongver-pkg', '2.0.0'),
    'unpinned': manifest('unpinned', 'nopin-pkg-unused', '2.0.0'), // npmPackage below won't match this manifest's pin
  });

  ({ IntegrationManager } = await import('../src/lib/integration-manager'));
  ({ loadManifests } = await import('../src/lib/manifest-loader'));
  loadManifests(manifestsDir);
});

afterAll(() => {
  process.env.PATH = originalPath;
  if (originalIntegrationsDir === undefined) delete process.env.SUVEREN_INTEGRATIONS_DIR;
  else process.env.SUVEREN_INTEGRATIONS_DIR = originalIntegrationsDir;
  if (originalOffline === undefined) delete process.env.SUVEREN_OFFLINE;
  else process.env.SUVEREN_OFFLINE = originalOffline;
  delete process.env.FAKE_NPM_LOG;
  rmSync(workDir, { recursive: true, force: true });
});

describe('SUVEREN_OFFLINE=1 — ensureInstalled never calls npm', () => {
  let im: InstanceType<typeof IntegrationManager>;

  beforeEach(() => {
    im = new IntegrationManager(new Map());
    writeFileSync(npmLog, '');
  });
  afterEach(async () => {
    await im.shutdown();
  });

  it('shipped at exactly the pinned version → starts, npm never invoked', async () => {
    preInstall('shipped-pkg', '2.0.0');

    await im.startIntegration(config('shipped', 'shipped-pkg'));

    expect(im.isRunning('shipped')).toBe(true);
    expect(npmCalls()).toEqual([]);
  });

  it('not installed at all → refuses to start with a clear, named reason — npm never invoked', async () => {
    await expect(im.startIntegration(config('missing', 'missing-pkg'))).rejects.toThrow(
      /missing: connector missing-pkg version 2\.0\.0 is not part of this installation/,
    );

    expect(im.isRunning('missing')).toBe(false);
    expect(npmCalls()).toEqual([]);
  });

  it('installed at the WRONG version → refuses to start (never silently runs an unpinned version) — npm never invoked', async () => {
    preInstall('wrongver-pkg', '1.0.0');

    await expect(im.startIntegration(config('wrong-version', 'wrongver-pkg'))).rejects.toThrow(
      /wrong-version: connector wrongver-pkg version 2\.0\.0 is not part of this installation \(found 1\.0\.0/,
    );

    expect(im.isRunning('wrong-version')).toBe(false);
    expect(npmCalls()).toEqual([]);
    // The on-disk 1.0.0 install must survive untouched — offline mode must
    // never clean up or otherwise mutate what's on disk, only refuse to run it.
    expect(existsSync(join(integrationsDir, 'node_modules', 'wrongver-pkg', 'package.json'))).toBe(true);
  });

  it('no manifest pin for this npmPackage → falls back to "is anything usable installed at all" — npm never invoked', async () => {
    // 'unpinned' config below points at a package name with no manifest pin
    // (pinnedVersionFor requires manifest.npmPackage === config.npmPackage).
    await expect(
      im.startIntegration(config('unpinned', 'truly-unpinned-pkg')),
    ).rejects.toThrow(/unpinned: connector truly-unpinned-pkg is not part of this installation/);

    expect(im.isRunning('unpinned')).toBe(false);
    expect(npmCalls()).toEqual([]);
  });
});
