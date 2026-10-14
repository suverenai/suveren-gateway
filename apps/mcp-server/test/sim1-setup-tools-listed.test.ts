/**
 * SIM1 — the simulation setup tools (load_simulation/clear_simulation,
 * manifest `hideUnlessAuthorized` + `simulationOnly`) are ALSO listed
 * unconditionally while GATEWAY-WIDE simulation mode is ON
 * (`SUVEREN_SIMULATION=1`) — like every other connector tool since 0.25
 * ("tools always listed").
 *
 * The bug this fixes: without this, a setup mandate's approval mid-session
 * sent `tools/list_changed`, but AI clients (Claude Code, ChatGPT) often
 * refresh the tool list only on reconnect — so an AI just granted a setup
 * mandate could not see `load_simulation`/`clear_simulation`. Listing them
 * unconditionally in simulation mode means the tool list no longer changes
 * when a setup mandate is approved.
 *
 * Purely ADDITIVE, on purpose: outside gateway-wide simulation mode, nothing
 * changes — visibility and the refusal text stay exactly the pre-SIM1,
 * mandate-bound-check behaviour. That matters: the "three-week test"
 * onboarding flow loads test data into erp/crm/mail via an ordinary setup
 * mandate WITHOUT ever setting the gateway-wide switch (see hap-e2e's
 * simulation-setup/simulation-rerun/review-load-simulation suites, run
 * against the real stack) — a rule that hid or refused load_simulation
 * whenever that switch happened to be off would have broken that flow for
 * every real customer trial. This file proves the OFF case is bit-for-bit
 * the old behaviour (`toolIsAuthorizedForDisplay` carries no simulationOnly
 * logic at all).
 *
 * Mirrors tools-always-listed.test.ts (the general rule) and
 * hide-unless-authorized.test.ts (the setup_daily_max bound model) for this
 * specific, previously-exempted case.
 *
 * Covers, cheapest first:
 *  A. `toolAlwaysListed` / `toolIsAuthorizedForDisplay` — the pure predicates.
 *  B. End to end through `createMcpServer`/`refreshTools` (real MCP SDK
 *     `enabled` flag): simulation mode lists it before AND after a setup
 *     mandate (identical list); simulation OFF is unaffected either way.
 *  C. The call-time refusal: no setup mandate at all, or only the agent's
 *     ordinary work mandate (setup_daily_max: 0) — in simulation mode, both
 *     refused with the "no mandate covers ... (setup)" wording, nothing
 *     runs; outside simulation mode the pre-SIM1 wording is unchanged.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { createMcpServer } from '../src/index';
import { createGatedToolHandler, toolAlwaysListed, toolIsAuthorizedForDisplay } from '../src/lib/tool-proxy';
import type { DiscoveredTool, IntegrationManager } from '../src/lib/integration-manager';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const CUSTOMERS = JSON.parse(readFileSync(join(profilesDir, 'customers/0.9.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(CUSTOMERS.id, CUSTOMERS);
  // profile-loader.ts also registers every profile under its short name
  // ("customers") — real manifests (crm.json) gate by that short name, and
  // `getProfile` (used by `countBoundsFor`/`toolIsAuthorizedForDisplay`) is
  // a plain dictionary lookup with no short-name resolution of its own.
  registerProfile('customers', CUSTOMERS);
});

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

function loadSimTool(): DiscoveredTool {
  return {
    originalName: 'load_simulation',
    namespacedName: 'crm__load_simulation',
    integrationId: 'crm',
    description: 'Load test data',
    inputSchema: {},
    gating: {
      profile: 'customers',
      executionMapping: {},
      staticExecution: { action_type: 'setup' },
      hideUnlessAuthorized: true,
      simulationOnly: true,
    } as DiscoveredTool['gating'],
  };
}

const ordinaryTool: DiscoveredTool = {
  originalName: 'update_contact',
  namespacedName: 'crm__update_contact',
  integrationId: 'crm',
  description: 'Update a contact',
  inputSchema: {},
  gating: { profile: 'customers', executionMapping: {}, staticExecution: { action_type: 'write' } },
};

const ALL = [loadSimTool(), ordinaryTool];

function setupMandate(setupDailyMax = 1): EnrichedAuthorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000000s1',
    profileId: CUSTOMERS.id,
    path: 'customers-setup',
    frame: { profile: CUSTOMERS.id, setup_daily_max: setupDailyMax },
    bounds: { setup_daily_max: setupDailyMax },
    attestations: [{ domain: 'owner', blob: 'blob', expiresAt: now + 3600 }],
    requiredDomains: ['owner'],
    attestedDomains: ['owner'],
    complete: true,
    gateContent: null,
  } as unknown as EnrichedAuthorization;
}

function mockIntegrationManager(tools: DiscoveredTool[]): IntegrationManager {
  return {
    getAllTools: () => tools,
    isBuiltin: (id: string) => id === 'setup',
    isSimulationSafe: () => true,
  } as unknown as IntegrationManager;
}

function mockState(auths: EnrichedAuthorization[]): SharedState {
  return {
    getEnrichedAuthorizations: () => auths,
    executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
    spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
    // Only reached once a call gets past "no mandate" (a real setup
    // mandate) — a refusal here is enough to prove the call got that far
    // without a real Gatekeeper/AS round-trip.
    gatekeeper: { verifyExecution: async () => ({ result: { approved: false, errors: [{ message: 'stub refusal (not under test here)' }] } }) },
  } as unknown as SharedState;
}

/** The real MCP SDK's own `enabled` flag — what `tools/list` actually filters on. */
function registered(auths: EnrichedAuthorization[]) {
  const { server, refreshTools } = createMcpServer(mockState(auths), mockIntegrationManager(ALL));
  refreshTools();
  return (server as unknown as { _registeredTools: Record<string, { enabled: boolean; description?: string }> })._registeredTools;
}

// ─── A. The pure predicates ─────────────────────────────────────────────

describe('toolAlwaysListed — simulationOnly', () => {
  it('gateway-wide simulation mode ON: always listed, no mandate needed', () => {
    process.env.SUVEREN_SIMULATION = '1';
    expect(toolAlwaysListed(loadSimTool(), () => false)).toBe(true);
  });

  it('gateway-wide simulation mode OFF: not always-listed (falls through to the UNCHANGED mandate-gated branch)', () => {
    delete process.env.SUVEREN_SIMULATION;
    expect(toolAlwaysListed(loadSimTool(), () => false)).toBe(false);
  });

  it('a hideUnlessAuthorized tool WITHOUT simulationOnly is unaffected (unchanged rule)', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const tool = loadSimTool();
    tool.gating = { ...tool.gating!, simulationOnly: false } as DiscoveredTool['gating'];
    expect(toolAlwaysListed(tool, () => false)).toBe(false);
  });
});

describe('toolIsAuthorizedForDisplay — unchanged by simulationOnly (purely additive elsewhere)', () => {
  it('carries no simulationOnly logic at all — identical result regardless of SUVEREN_SIMULATION', () => {
    for (const sim of ['1', undefined]) {
      if (sim) process.env.SUVEREN_SIMULATION = sim; else delete process.env.SUVEREN_SIMULATION;
      expect(toolIsAuthorizedForDisplay(loadSimTool(), [])).toBe(false);
      expect(toolIsAuthorizedForDisplay(loadSimTool(), [setupMandate(0)])).toBe(false);
      expect(toolIsAuthorizedForDisplay(loadSimTool(), [setupMandate(1)])).toBe(true);
    }
  });
});

// ─── B. End to end through refreshTools (tools/list visibility) ────────

describe('SIM1 end to end — gateway-wide simulation mode ON (real MCP server wiring)', () => {
  it('listed without any mandate', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const tools = registered([]);
    expect(tools.crm__load_simulation.enabled).toBe(true);
  });

  it('the tool list is IDENTICAL before and after a setup mandate is granted', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const auths: EnrichedAuthorization[] = [];
    const { server, refreshTools } = createMcpServer(mockState(auths), mockIntegrationManager(ALL));
    refreshTools();
    const reg = (server as unknown as { _registeredTools: Record<string, { enabled: boolean; description?: string }> })._registeredTools;
    const before = { enabled: reg.crm__load_simulation.enabled, description: reg.crm__load_simulation.description };

    // Approve a setup mandate WITHOUT reconnecting (refreshTools only, no new server).
    auths.push(setupMandate(1));
    refreshTools();

    expect(reg.crm__load_simulation.enabled).toBe(before.enabled);
    expect(reg.crm__load_simulation.description).toBe(before.description);
    expect(reg.crm__load_simulation.enabled).toBe(true);
  });
});

describe('SIM1 — gateway-wide simulation mode OFF: bit-for-bit the pre-SIM1 behaviour', () => {
  it('hidden with no mandate, shown once a mandate grants the bound — same rule as any other hideUnlessAuthorized tool', () => {
    delete process.env.SUVEREN_SIMULATION;
    expect(registered([]).crm__load_simulation.enabled).toBe(false);
    expect(registered([setupMandate(0)]).crm__load_simulation.enabled).toBe(false);
    expect(registered([setupMandate(1)]).crm__load_simulation.enabled).toBe(true);
  });
});

// ─── C. Calling without a setup mandate — refused, nothing runs ────────

describe('SIM1 — calling load_simulation without a setup mandate (gateway-wide simulation mode ON)', () => {
  it('no matching mandate at all: refused with "no mandate covers ... (setup)"', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = mockState([]);
    const im = mockIntegrationManager(ALL);
    const handler = createGatedToolHandler(loadSimTool(), im, state);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'Refused: no mandate covers crm__load_simulation (setup). Nothing was done. ' +
        'Ask the person to grant a setup mandate in the gateway, then try again. No ticket was requested.',
    );
  });

  it('only the ordinary work mandate (setup_daily_max: 0): refused the same way', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = mockState([setupMandate(0)]);
    const im = mockIntegrationManager(ALL);
    const handler = createGatedToolHandler(loadSimTool(), im, state);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no mandate covers crm__load_simulation (setup)');
    expect(result.content[0].text).not.toContain('setup_daily_max'); // the clear reason, not the raw bound-exceeded message
  });

  it('a setup mandate DOES allow the call to proceed to the ordinary gate (not refused as "no mandate")', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = mockState([setupMandate(1)]);
    const im = mockIntegrationManager(ALL);
    const handler = createGatedToolHandler(loadSimTool(), im, state);
    const result = await handler({});
    // Falls through past the SIM1 refusal — a real stack would issue a
    // ticket next; this file only asserts SIM1's own refusal does not fire.
    expect(result.content[0].text).not.toContain('no mandate covers');
  });
});

describe('SIM1 — gateway-wide simulation mode OFF: the write-path refusal text is UNCHANGED', () => {
  it('only the ordinary work mandate (setup_daily_max: 0): the OLD bound-exceeded wording, not the new "(setup)" text', async () => {
    delete process.env.SUVEREN_SIMULATION;
    // approved: true so zeroCappedBound runs against the REAL held bounds
    // (setup_daily_max: 0) and produces the genuine, pre-SIM1 message —
    // exactly what hap-e2e's simulation-setup.test.ts asserts against
    // (`/setup_daily_max|limit|exceed/i`) without the gateway-wide switch.
    const state = {
      ...mockState([setupMandate(0)]),
      gatekeeper: { verifyExecution: async () => ({ result: { approved: true, errors: [] } }) },
    } as unknown as SharedState;
    const im = mockIntegrationManager(ALL);
    const handler = createGatedToolHandler(loadSimTool(), im, state);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('no mandate covers');
    expect(result.content[0].text).toContain('setup_daily_max');
  });
});
