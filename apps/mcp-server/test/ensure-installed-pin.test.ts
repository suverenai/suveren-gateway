/**
 * Pinned connector versions (decision Andreas, 2026-10-02, "option A").
 *
 * Before this, `ensureInstalled` installed `npmPackage` once and never
 * checked its version again — a connector installed on day one silently
 * never updated no matter how many releases shipped later (observed on a
 * real machine: erp-mcp stuck at 0.3.0 while 0.3.3 was released). This file
 * pins the fix: the manifest's `npmVersion` is read fresh from the CURRENT
 * manifest at every start, and the installed package is brought to EXACTLY
 * that version — older or newer — before the connector is allowed to run.
 *
 * Real npm-free: a fixture `npm` executable (fake-npm.mjs, prepended onto
 * PATH) stands in for the registry, so these tests never touch the network
 * and never run the real, slow `npm install`. It is invoked exactly the way
 * production code invokes real npm (`npm install --no-fund --no-audit
 * <spec>`, cwd = the integrations dir) and writes a real package.json + bin
 * shim to disk — so `isUsableInstall`/`readInstalledVersion`, the actual
 * production code under test, run unmodified against real files. Nothing
 * about the update decision is mocked; only the registry is replaced.
 *
 * `SUVEREN_INTEGRATIONS_DIR` is read into a module-level const at import
 * time, so it is set (to a temp dir — never ~/.suveren) BEFORE
 * `integration-manager` is dynamically imported, and restored afterward.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync,
} from 'node:fs';
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

// Populated in beforeAll, after env vars are set, via dynamic import — see
// module docstring for why this can't be a static top-level import.
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

function installedVersion(pkg: string): string | null {
  const pkgJson = join(integrationsDir, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(pkgJson)) return null;
  return (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version ?? null;
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
  workDir = mkdtempSync(join(tmpdir(), 'hap-pin-test-'));
  integrationsDir = join(workDir, 'integrations');
  manifestsDir = join(workDir, 'manifests');
  npmLog = join(workDir, 'npm-calls.log');
  mkdirSync(integrationsDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  originalPath = process.env.PATH;
  originalIntegrationsDir = process.env.SUVEREN_INTEGRATIONS_DIR;
  process.env.PATH = `${FAKE_NPM_DIR}${delimiter}${originalPath ?? ''}`;
  process.env.SUVEREN_INTEGRATIONS_DIR = integrationsDir;
  process.env.FAKE_NPM_LOG = npmLog;

  writeManifests({
    'older': manifest('older', 'older-pkg', '2.0.0'),
    'newer': manifest('newer', 'newer-pkg', '2.0.0'),
    'equal': manifest('equal', 'equal-pkg', '2.0.0'),
    'failing': manifest('failing', 'failing-pkg', '2.0.0'),
  });

  ({ IntegrationManager } = await import('../src/lib/integration-manager'));
  ({ loadManifests } = await import('../src/lib/manifest-loader'));
  loadManifests(manifestsDir);
});

afterAll(() => {
  process.env.PATH = originalPath;
  if (originalIntegrationsDir === undefined) delete process.env.SUVEREN_INTEGRATIONS_DIR;
  else process.env.SUVEREN_INTEGRATIONS_DIR = originalIntegrationsDir;
  delete process.env.FAKE_NPM_LOG;
  delete process.env.FAKE_NPM_FAIL;
  rmSync(workDir, { recursive: true, force: true });
});

describe('ensureInstalled — pin comes from the CURRENT manifest', () => {
  let im: InstanceType<typeof IntegrationManager>;

  beforeEach(() => {
    im = new IntegrationManager(new Map());
    // Each test asserts on ITS OWN npm calls — start every test with a clean log.
    writeFileSync(npmLog, '');
  });
  afterEach(async () => {
    await im.shutdown();
  });

  it('installed OLDER than the pin → fake npm is called with the exact pinned version', async () => {
    preInstall('older-pkg', '1.0.0');
    await im.startIntegration(config('older', 'older-pkg'));

    expect(im.isRunning('older')).toBe(true);
    expect(npmCalls()).toEqual(['older-pkg@2.0.0']);
    expect(installedVersion('older-pkg')).toBe('2.0.0');
  });

  it('installed NEWER than the pin → corrected DOWN to the pin, not left alone', async () => {
    preInstall('newer-pkg', '3.0.0');
    await im.startIntegration(config('newer', 'newer-pkg'));

    expect(im.isRunning('newer')).toBe(true);
    expect(npmCalls()).toEqual(['newer-pkg@2.0.0']);
    expect(installedVersion('newer-pkg')).toBe('2.0.0');
  });

  it('installed EQUAL to the pin → fake npm is never called', async () => {
    preInstall('equal-pkg', '2.0.0');
    await im.startIntegration(config('equal', 'equal-pkg'));

    expect(im.isRunning('equal')).toBe(true);
    expect(npmCalls()).toEqual([]);
    expect(installedVersion('equal-pkg')).toBe('2.0.0');
  });

  it('NO manifest pin (manually added integration) → today\'s behaviour: installed version is left alone', async () => {
    // No manifest is loaded for this id at all, so getManifest() returns
    // undefined and there is nothing to pin against.
    preInstall('nopin-pkg', '9.9.9');
    await im.startIntegration(config('nopin', 'nopin-pkg'));

    expect(im.isRunning('nopin')).toBe(true);
    expect(npmCalls()).toEqual([]);
    expect(installedVersion('nopin-pkg')).toBe('9.9.9');
  });

  it('update failure → the integration does NOT start (fail closed, not "keep the old version silently")', async () => {
    preInstall('failing-pkg', '1.0.0');
    process.env.FAKE_NPM_FAIL = '1';
    try {
      await expect(im.startIntegration(config('failing', 'failing-pkg'))).rejects.toThrow();
    } finally {
      delete process.env.FAKE_NPM_FAIL;
    }

    expect(im.isRunning('failing')).toBe(false);
    // The failed update must not have silently left 1.0.0 "running" under a
    // different guise, nor have mutated the on-disk version it couldn't reach.
    expect(installedVersion('failing-pkg')).toBe('1.0.0');
  });
});
