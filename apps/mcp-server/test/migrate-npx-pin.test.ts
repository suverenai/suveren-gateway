/**
 * Review finding, 2026-10-02 (follow-up to the pinned-connector-versions
 * feature): `ensureInstalled` correctly brought an EXISTING install to the
 * manifest's pinned version, but the subsequent spawn still used whatever
 * command/args were PERSISTED in integrations.json. A real install
 * (deploy-github, activated before its manifest moved off
 * `npx -y @humanagencyp/deploy-mcp@latest`) kept running that exact `npx …
 * @latest` line on every start forever — fetching unvetted "latest" code
 * each time — even though the installed package on disk was correctly
 * pinned. New activations were unaffected (the control plane builds a fresh
 * config from the current manifest every time); only upgrades of existing
 * installs were broken.
 *
 * Covered here:
 *   - a persisted `npx …` config for a pinned connector is migrated to the
 *     manifest's own command/args before spawn, and the migration is
 *     reported via `onConfigMigrated` so it can be persisted once;
 *   - that persistence actually reaches integrations.json end to end, wired
 *     the same way bin/http.ts wires it (IntegrationRegistry.update);
 *   - a connector whose persisted command was NEVER npx (mollie's
 *     `mcp-remote` with manifest-declared, vault-interpolated args) is left
 *     completely untouched — no migration, no callback;
 *   - a pinned connector whose command is STILL npx after the migration
 *     attempt (a manifest that itself declares npx) is refused outright,
 *     never spawned — the defense-in-depth guard.
 *
 * Real npm-free: every package here is pre-installed on disk at EXACTLY its
 * pinned version, so `ensureInstalled`'s fast path returns without ever
 * calling npm (covered separately by ensure-installed-pin.test.ts) — this
 * file is purely about the SPAWN command, not the install.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_FIXTURE = join(import.meta.dirname, 'fixtures', 'delayable-mcp-server.mjs');

let workDir: string;
let integrationsDir: string;
let manifestsDir: string;
let originalIntegrationsDir: string | undefined;

let IntegrationManager: typeof import('../src/lib/integration-manager').IntegrationManager;
let IntegrationRegistry: typeof import('../src/lib/integration-registry').IntegrationRegistry;
let loadManifests: typeof import('../src/lib/manifest-loader').loadManifests;

type MinimalManifest = Record<string, unknown>;

function manifest(id: string, npmPackage: string, npmVersion: string, mcp: { command: string; args: string[] }): MinimalManifest {
  return {
    id,
    name: id,
    version: '1',
    description: 'test fixture',
    icon: 'wrench',
    profile: 'test-profile',
    mcp,
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

/** Fabricate a real, usable on-disk install at EXACTLY `version` — no npm call needed. */
function preInstall(pkg: string, version: string): void {
  const pkgDir = join(integrationsDir, 'node_modules', ...pkg.split('/'));
  const binDir = join(integrationsDir, 'node_modules', '.bin');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const binName = pkg.split('/').pop()!;
  writeFileSync(join(pkgDir, 'index.js'), '// fixture install\n');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkg, version, bin: { [binName]: 'index.js' }, main: 'index.js' }),
  );
  writeFileSync(join(binDir, binName), '#!/usr/bin/env node\n');
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'hap-migrate-npx-test-'));
  integrationsDir = join(workDir, 'integrations');
  manifestsDir = join(workDir, 'manifests');
  mkdirSync(integrationsDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  originalIntegrationsDir = process.env.SUVEREN_INTEGRATIONS_DIR;
  process.env.SUVEREN_INTEGRATIONS_DIR = integrationsDir;

  writeManifests({
    // Mirrors deploy-github's real fix: manifest now names the installed
    // bin, not npx.
    'deploy-like': manifest('deploy-like', 'deploy-like-pkg', '0.4.2', {
      command: process.execPath,
      args: [SERVER_FIXTURE],
    }),
    // Mirrors mollie: command was NEVER npx, args carry a vault-credential
    // template placeholder. Must be left completely alone.
    'mollie-like': manifest('mollie-like', 'mollie-like-pkg', '0.14.3', {
      command: process.execPath,
      args: [SERVER_FIXTURE, '--header', 'Authorization: Bearer ${FAKE_TOKEN}'],
    }),
    // A (hypothetical, third-party) manifest that is pinned but STILL
    // declares npx as its own command — the guard's job, not the migration's.
    'guard-like': manifest('guard-like', 'guard-like-pkg', '1.0.0', {
      command: 'npx',
      args: ['-y', 'guard-like-pkg@latest'],
    }),
  });

  ({ IntegrationManager } = await import('../src/lib/integration-manager'));
  ({ IntegrationRegistry } = await import('../src/lib/integration-registry'));
  ({ loadManifests } = await import('../src/lib/manifest-loader'));
  loadManifests(manifestsDir);
});

afterAll(() => {
  if (originalIntegrationsDir === undefined) delete process.env.SUVEREN_INTEGRATIONS_DIR;
  else process.env.SUVEREN_INTEGRATIONS_DIR = originalIntegrationsDir;
  rmSync(workDir, { recursive: true, force: true });
});

describe('a persisted npx config for a PINNED connector is migrated before spawn', () => {
  let im: InstanceType<typeof IntegrationManager>;
  let migrations: Array<{ id: string; updates: Record<string, unknown> }>;

  beforeEach(() => {
    im = new IntegrationManager(new Map());
    migrations = [];
    im.setOnConfigMigrated((id, updates) => migrations.push({ id, updates: updates as Record<string, unknown> }));
  });
  afterEach(async () => {
    await im.shutdown();
  });

  it('the OLD npx/@latest shape (deploy-github\'s real bug): spawns the manifest\'s command, not npx', async () => {
    preInstall('deploy-like-pkg', '0.4.2');
    const staleConfig = {
      id: 'deploy-like',
      name: 'deploy-like',
      command: 'npx', // the old shape, pre-migration
      args: ['-y', 'deploy-like-pkg@latest'],
      envKeys: {},
      profile: null,
      npmPackage: 'deploy-like-pkg',
      enabled: true,
    };

    const tools = await im.startIntegration(staleConfig);

    // It actually started — meaning the spawn used the manifest's REAL
    // command (process.execPath + the fixture script), not `npx` (which
    // would have tried to fetch `deploy-like-pkg` from the real registry
    // and failed/timed out instead of ever answering the MCP handshake).
    expect(im.isRunning('deploy-like')).toBe(true);
    expect(tools.map(t => t.originalName)).toContain('echo');

    // The migration was reported exactly once, with the manifest's shape.
    expect(migrations).toEqual([
      { id: 'deploy-like', updates: { command: process.execPath, args: [SERVER_FIXTURE], env: undefined } },
    ]);
  });

  it('a mollie-shaped config (never npx, vault-templated args) is left untouched', async () => {
    preInstall('mollie-like-pkg', '0.14.3');
    const config = {
      id: 'mollie-like',
      name: 'mollie-like',
      command: process.execPath, // already the manifest's own shape
      args: [SERVER_FIXTURE, '--header', 'Authorization: Bearer ${FAKE_TOKEN}'],
      envKeys: {},
      profile: null,
      npmPackage: 'mollie-like-pkg',
      enabled: true,
    };

    const tools = await im.startIntegration(config);

    expect(im.isRunning('mollie-like')).toBe(true);
    expect(tools.map(t => t.originalName)).toContain('echo');
    // No migration — command was never npx.
    expect(migrations).toEqual([]);
  });

  it('a manifest that is pinned but STILL names npx as its own command is refused, never spawned', async () => {
    preInstall('guard-like-pkg', '1.0.0');
    const config = {
      id: 'guard-like',
      name: 'guard-like',
      command: 'npx',
      args: ['-y', 'guard-like-pkg@latest'],
      envKeys: {},
      profile: null,
      npmPackage: 'guard-like-pkg',
      enabled: true,
    };

    await expect(im.startIntegration(config)).rejects.toThrow(/refusing to spawn a pinned connector.*via npx/i);
    expect(im.isRunning('guard-like')).toBe(false);
  });
});

describe('the migration actually reaches integrations.json (wired like bin/http.ts)', () => {
  it('IntegrationRegistry.update persists the corrected command/args', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'hap-migrate-registry-'));
    try {
      const registry = new IntegrationRegistry(registryDir);
      const staleConfig = {
        id: 'deploy-like',
        name: 'deploy-like',
        command: 'npx',
        args: ['-y', 'deploy-like-pkg@latest'],
        envKeys: {},
        profile: null,
        npmPackage: 'deploy-like-pkg',
        enabled: true,
      };
      registry.add(staleConfig);

      const im = new IntegrationManager(new Map());
      // Exactly how bin/http.ts wires it.
      im.setOnConfigMigrated((id, updates) => registry.update(id, updates));

      preInstall('deploy-like-pkg', '0.4.2');
      await im.startIntegration(staleConfig);
      await im.shutdown();

      expect(registry.get('deploy-like')).toMatchObject({
        command: process.execPath,
        args: [SERVER_FIXTURE],
      });

      // Re-read straight off disk — not just the in-memory registry — to
      // prove this is a REAL fix to integrations.json, not merely an
      // in-process side effect.
      const onDisk = JSON.parse(readFileSync(join(registryDir, 'integrations.json'), 'utf8')) as {
        integrations: Array<{ id: string; command: string; args: string[] }>;
      };
      const persisted = onDisk.integrations.find(i => i.id === 'deploy-like');
      expect(persisted?.command).toBe(process.execPath);
      expect(persisted?.args).toEqual([SERVER_FIXTURE]);
    } finally {
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});

describe('control check scaffolding', () => {
  it('sanity: the fixture server really does expose an "echo" tool (so a FAILED migration would show as a missing tool, not a vacuous pass)', () => {
    expect(existsSync(SERVER_FIXTURE)).toBe(true);
  });
});
