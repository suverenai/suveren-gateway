/**
 * Simulation mode — IntegrationManager enforcement.
 *
 * WHY this mode exists at all: a mandate is bound to a PROFILE, not a
 * connector (tool-proxy.ts's `profileMatches`). Put a real connector (e.g.
 * gmail) and a simulated one (e.g. "mail") on the same profile, and a mandate
 * meant only for testing also authorizes the real one. Simulation mode closes
 * that generically, gateway-wide: a connector whose manifest carries no
 * `simulation` marker is refused to even START while it's on, and a connector
 * that DOES declare one has its mode env var FORCED to "simulation" —
 * overriding whatever credential value is on file — so a forgotten
 * mode=live setting can't quietly take effect while the operator believes
 * real systems are off.
 *
 * Uses REAL manifests (loaded via loadManifests, same as production) and REAL
 * spawned stdio fixtures — not mocks — per doc/engineering.md rule 3 ("tests
 * import the real thing") and the "never mock an integration" rule.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import { loadManifests } from '../src/lib/manifest-loader';
import type { IntegrationConfig } from '../src/lib/integration-registry';

const REAL_FIXTURE = join(import.meta.dirname, 'fixtures', 'delayable-mcp-server.mjs');
const SIM_FIXTURE = join(import.meta.dirname, 'fixtures', 'env-report-mcp-server.mjs');

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hap-sim-manifests-'));
  mkdirSync(join(dir, 'real'));
  mkdirSync(join(dir, 'sim'));
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({ integrations: { 'real-conn': 'real/manifest.json', 'sim-conn': 'sim/manifest.json' } }),
  );
  // A manifest with NO `simulation` marker — a stand-in for gmail/a live ERP.
  writeFileSync(
    join(dir, 'real/manifest.json'),
    JSON.stringify({
      id: 'real-conn',
      name: 'Real Connector',
      version: '1',
      description: 'test',
      icon: 'mail',
      profile: 'sim-test-profile',
      mcp: { command: process.execPath, args: [REAL_FIXTURE] },
      credentials: { fields: [], envMapping: {} },
      oauth: null,
      toolGating: { default: { executionMapping: {} }, overrides: {} },
    }),
  );
  // A manifest that DOES declare a simulated mode — mirrors content/integrations
  // erp.json/crm.json/mail.json's `simulation: { field, default }` shape.
  writeFileSync(
    join(dir, 'sim/manifest.json'),
    JSON.stringify({
      id: 'sim-conn',
      name: 'Sim Connector',
      version: '1',
      description: 'test',
      icon: 'mail',
      profile: 'sim-test-profile',
      mcp: { command: process.execPath, args: [SIM_FIXTURE] },
      credentials: {
        fields: [{ key: 'mode', label: 'Mode', type: 'text', optional: true }],
        envMapping: { MODE_ENV: 'mode' },
      },
      oauth: null,
      simulation: { field: 'mode', default: 'simulation' },
      toolGating: { default: { executionMapping: {} }, overrides: {} },
    }),
  );
  loadManifests(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function realConfig(): IntegrationConfig {
  return {
    id: 'real-conn',
    name: 'Real Connector',
    command: process.execPath,
    args: [REAL_FIXTURE],
    envKeys: {},
    profile: 'sim-test-profile',
    enabled: true,
  };
}

function simConfig(): IntegrationConfig {
  return {
    id: 'sim-conn',
    name: 'Sim Connector',
    command: process.execPath,
    args: [SIM_FIXTURE],
    // Vault says "live" — simulation mode must override this, not merely
    // supplement it, or a forgotten mode=live setting takes effect silently.
    envKeys: { MODE_ENV: 'sim-conn.mode' },
    profile: 'sim-test-profile',
    enabled: true,
  };
}

describe('simulation mode — IntegrationManager', () => {
  let im: IntegrationManager | undefined;

  afterEach(async () => {
    delete process.env.SUVEREN_SIMULATION;
    if (im) await im.shutdown();
    im = undefined;
  });

  it('OFF: behaviour is unchanged — a real (gmail-like) manifest starts normally', async () => {
    delete process.env.SUVEREN_SIMULATION;
    im = new IntegrationManager(new Map());

    const tools = await im.startIntegration(realConfig());

    expect(im.isRunning('real-conn')).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('ON: a real connector with no manifest "simulation" marker is refused to start, named', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    im = new IntegrationManager(new Map());

    await expect(im.startIntegration(realConfig())).rejects.toThrow(/simulation mode/i);
    expect(im.isRunning('real-conn')).toBe(false);
  });

  it('ON: an integration with NO loaded manifest at all is refused too (e.g. /internal/add-integration with no backing manifest)', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    im = new IntegrationManager(new Map());

    const config: IntegrationConfig = {
      id: 'no-manifest-at-all',
      name: 'Mystery connector',
      command: process.execPath,
      args: [REAL_FIXTURE],
      envKeys: {},
      profile: 'sim-test-profile',
      enabled: true,
    };

    await expect(im.startIntegration(config)).rejects.toThrow(/simulation mode/i);
    expect(im.isRunning('no-manifest-at-all')).toBe(false);
  });

  it('ON: a simulated connector starts, with its mode env var FORCED to "simulation" even though the vault says "live"', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    im = new IntegrationManager(new Map([['sim-conn', { mode: 'live' }]]));

    await im.startIntegration(simConfig());
    expect(im.isRunning('sim-conn')).toBe(true);

    const result = await im.callTool('sim-conn', 'get_env', { name: 'MODE_ENV' });
    expect(result.content[0].text).toBe('simulation');
  });

  it('OFF: a simulated connector keeps whatever mode the credential says (no forcing)', async () => {
    delete process.env.SUVEREN_SIMULATION;
    im = new IntegrationManager(new Map([['sim-conn', { mode: 'live' }]]));

    await im.startIntegration(simConfig());
    const result = await im.callTool('sim-conn', 'get_env', { name: 'MODE_ENV' });
    expect(result.content[0].text).toBe('live');
  });
});
