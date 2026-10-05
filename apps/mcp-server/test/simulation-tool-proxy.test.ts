/**
 * Simulation mode — tool-proxy defence in depth.
 *
 * integration-manager.ts already refuses to START a connector whose manifest
 * carries no `simulation` marker while simulation mode is on (see
 * simulation-integration-manager.test.ts), so in the ordinary case a real
 * tool never exists to be called. This file exercises the SECOND, independent
 * check — at call time, in tool-proxy.ts — which exists so a bug in the
 * start-time gate, or some future path that registers tools without going
 * through IntegrationManager.startIntegration, can never let a real system
 * execute.
 *
 * Uses a REAL manifest (loaded via loadManifests) so `getManifest` resolves
 * exactly as it does in production, per doc/engineering.md's "test against
 * shipped manifests" rule.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { loadManifests, getManifest } from '../src/lib/manifest-loader';
import { manifestIsSimulated } from '../src/lib/simulation-mode';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hap-sim-proxy-manifests-'));
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({ integrations: { 'sim-conn': 'sim-conn.json' } }),
  );
  // No "real-conn.json" entry at all — getManifest('real-conn') resolves to
  // undefined, exactly like an integration added via /internal/add-integration
  // with no backing manifest.
  writeFileSync(
    join(dir, 'sim-conn.json'),
    JSON.stringify({
      id: 'sim-conn',
      name: 'Sim Connector',
      version: '1',
      description: 'test',
      icon: 'mail',
      profile: 'charge',
      mcp: { command: 'node', args: [] },
      credentials: { fields: [{ key: 'mode', label: 'Mode', type: 'text', optional: true }], envMapping: { MODE_ENV: 'mode' } },
      oauth: null,
      simulation: { field: 'mode', default: 'simulation' },
      toolGating: { default: { executionMapping: {} }, overrides: {} },
    }),
  );
  loadManifests(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

function mockIntegrationManager() {
  return {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    getReadAgeDays: () => null,
    // The real rule for connectors (no built-ins in this file): the manifest's marker.
    isSimulationSafe: (id: string) => manifestIsSimulated(getManifest(id)),
  } as unknown as IntegrationManager;
}

function mockState(): SharedState {
  return {
    getEnrichedAuthorizations: () => [],
    spClient: { isUnlocked: () => true, postReceipt: vi.fn() },
  } as unknown as SharedState;
}

function realTool(): DiscoveredTool {
  return {
    originalName: 'send_payment',
    namespacedName: 'real-conn__send_payment',
    integrationId: 'real-conn', // not in the loaded manifest set at all
    description: 'Send a real payment',
    inputSchema: {},
    gating: {
      profile: 'charge',
      executionMapping: {},
      staticExecution: { action_type: 'charge' },
    },
  };
}

function simulatedTool(): DiscoveredTool {
  return {
    originalName: 'load_simulation',
    namespacedName: 'sim-conn__load_simulation',
    integrationId: 'sim-conn', // IS in the loaded manifest set, with a `simulation` marker
    description: 'Load test data',
    inputSchema: {},
    gating: {
      profile: 'charge',
      executionMapping: {},
      staticExecution: { action_type: 'setup' },
    },
  };
}

describe('simulation mode — tool-proxy defence in depth', () => {
  it('OFF: a call to a tool of a non-simulated connector proceeds (unchanged behaviour)', async () => {
    delete process.env.SUVEREN_SIMULATION;
    const state = mockState();
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(realTool(), im, state);

    // No active authorization — expected to be refused for THAT reason, not
    // the simulation check, proving the simulation gate did not short-circuit
    // (it would say "No active authorization", not "simulation mode").
    const result = await handler({});
    expect(result.content[0].text).toContain('No active authorization');
  });

  it('ON: refuses a call to a tool of a non-simulated connector with a neutral text (agent cannot tell simulation) — no ticket requested', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = mockState();
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(realTool(), im, state);

    const result = await handler({ amount: 50 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is not available. No ticket was requested.');
    expect(result.content[0].text.toLowerCase()).not.toMatch(/simulat|real system/);
    // The refusal happens before any gating/bounds/receipt logic — no receipt
    // round-trip, no downstream call.
    expect(state.spClient.postReceipt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(im.callTool as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('ON: an integration with NO loaded manifest at all is refused too', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = mockState();
    const im = mockIntegrationManager();
    const tool = realTool();
    tool.integrationId = 'totally-unknown-integration';
    const handler = createGatedToolHandler(tool, im, state);

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is not available. No ticket was requested.');
    expect(result.content[0].text.toLowerCase()).not.toMatch(/simulat|real system/);
  });

  it('ON: a call to a tool of a SIMULATED connector is NOT refused by this check (falls through to normal gating)', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = mockState();
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(simulatedTool(), im, state);

    const result = await handler({});
    // Falls through past the simulation check to the normal "no mandate" path
    // — proving the simulated connector was NOT caught by the simulation gate.
    expect(result.content[0].text).toContain('No active authorization');
    expect(result.content[0].text).not.toContain('is not available');
  });
});
