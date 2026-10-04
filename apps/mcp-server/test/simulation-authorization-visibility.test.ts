/**
 * Simulation mode must not leak the existence of a mandate for a profile
 * whose only connector is paused (Andreas, 2026-10-02): the agent must not
 * be able to tell simulation from live.
 *
 * Scenario exercised throughout: two authorizations —
 *  - `deploy@0.10` — its only connector (deploy-github) has NO manifest
 *    `simulation` marker, so integration-manager.ts refuses to start it
 *    while simulation mode is on. No tool for its profile is ever
 *    registered, so `getAllTools()` has nothing for it.
 *  - `charge@0.3` — backed by a RUNNING simulated connector, whose tool IS
 *    registered (gating.profile: 'charge').
 *
 * `agentVisibleAuthorizations` (agent-visibility.ts) is the one helper that
 * must hide the first and keep the second, reused by every agent-facing
 * enumeration: list-authorizations (compact overview, domain detail, the
 * "Active domains:" hint) and the mandate brief (MCP session instructions).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { agentVisibleAuthorizations } from '../src/lib/agent-visibility';
import { listAuthorizationsHandler } from '../src/tools/authorizations';
import { buildMandateBrief } from '../src/lib/mandate-brief';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

function pausedAuth(): CachedAuthorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000000de',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/deploy@0.10',
    path: 'deploy-routine',
    frame: { profile: 'github.com/humanagencyprotocol/hap-profiles/deploy@0.10', path: 'deploy-routine', deploy_daily_max: 5 },
    attestations: [{ domain: 'eng', blob: 'blob', expiresAt: now + 3600 }],
    requiredDomains: ['eng'],
    attestedDomains: ['eng'],
    complete: true,
  };
}

function runningAuth(): CachedAuthorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3',
    path: 'charge-routine',
    frame: { profile: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3', path: 'charge-routine', amount_max: 100, currency: 'EUR', action_type: 'charge' },
    attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
    requiredDomains: ['finance'],
    attestedDomains: ['finance'],
    complete: true,
  };
}

/** A tool belonging to a RUNNING simulated connector gated on profile 'charge'
 *  — mirrors what `IntegrationManager.getAllTools()` returns: only tools of
 *  integrations that are actually running. Nothing is ever added here for
 *  'deploy' — standing in for deploy-github being paused. */
function runningChargeTool(): DiscoveredTool {
  return {
    originalName: 'load_simulation',
    namespacedName: 'charge-sim-conn__load_simulation',
    integrationId: 'charge-sim-conn',
    description: 'Load test data',
    inputSchema: {},
    gating: {
      profile: 'charge',
      executionMapping: {},
      staticExecution: { action_type: 'setup' },
    },
  };
}

function mockIntegrationManager(tools: DiscoveredTool[]): IntegrationManager {
  return { getAllTools: () => tools } as unknown as IntegrationManager;
}

function enrich(a: CachedAuthorization): EnrichedAuthorization {
  return { ...a, gateContent: null };
}

function mockState(authorizations: CachedAuthorization[]): SharedState {
  const enriched = authorizations.map(enrich);
  return {
    getEnrichedAuthorizations: () => enriched,
    spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
    executionLog: { record: () => {}, sumByWindow: () => 0 },
    cache: { getAllAuthorizations: () => authorizations },
  } as unknown as SharedState;
}

// ─── agentVisibleAuthorizations — the shared helper ───────────────────────

describe('agentVisibleAuthorizations', () => {
  it('OFF: returns every authorization unchanged, even with no integration manager', () => {
    delete process.env.SUVEREN_SIMULATION;
    const all = [pausedAuth(), runningAuth()].map(enrich);
    expect(agentVisibleAuthorizations(all, undefined)).toEqual(all);
  });

  it('ON: hides an authorization whose profile has no running integration', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const all = [pausedAuth(), runningAuth()].map(enrich);
    const im = mockIntegrationManager([runningChargeTool()]);
    const visible = agentVisibleAuthorizations(all, im);
    expect(visible.map(a => a.path)).toEqual(['charge-routine']);
  });

  it('ON: fails closed (hides everything) when no integration manager is available', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const all = [pausedAuth(), runningAuth()].map(enrich);
    expect(agentVisibleAuthorizations(all, undefined)).toEqual([]);
  });
});

// ─── list-authorizations tool ──────────────────────────────────────────────

describe('list-authorizations — simulation mode hides paused-profile mandates', () => {
  it('ON: compact overview omits the paused-profile mandate, keeps the running one', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const im = mockIntegrationManager([runningChargeTool()]);
    const handler = listAuthorizationsHandler(mockState([pausedAuth(), runningAuth()]), im);
    const result = await handler();
    const text = result.content[0].text;
    expect(text).toContain('charge-routine');
    expect(text).not.toContain('deploy-routine');
    expect(text).not.toContain('deploy@0.10');
  });

  it('ON: domain detail for the hidden domain reads exactly like no mandate exists at all', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const im = mockIntegrationManager([runningChargeTool()]);
    const handler = listAuthorizationsHandler(mockState([pausedAuth(), runningAuth()]), im);

    const hidden = await handler({ domain: 'deploy' });
    const neverExisted = await handler({ domain: 'totally-unknown-domain' });

    // Same shape of refusal as a domain that never had a mandate at all —
    // echoing the queried name back is fine ("deploy" was typed by the
    // caller), but nothing about the actual hidden mandate (its path, bounds
    // or attested domain) may leak, and the "Active domains:" hint must not
    // list it either.
    expect(hidden.content[0].text).toContain('No authorizations found for domain "deploy"');
    expect(hidden.content[0].text).not.toContain('deploy-routine');
    expect(hidden.content[0].text).not.toContain('deploy@0.10');
    expect(hidden.content[0].text).toContain('Active domains: charge');
    expect(neverExisted.content[0].text).toContain('Active domains: charge');
  });

  it('ON: domain detail for the running-connector domain still shows full detail', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const im = mockIntegrationManager([runningChargeTool()]);
    const handler = listAuthorizationsHandler(mockState([pausedAuth(), runningAuth()]), im);
    const result = await handler({ domain: 'charge' });
    expect(result.content[0].text).toContain('[charge-routine]');
  });

  it('OFF: both mandates are shown — unchanged from pre-simulation-fix behaviour', async () => {
    delete process.env.SUVEREN_SIMULATION;
    const im = mockIntegrationManager([runningChargeTool()]);
    const handler = listAuthorizationsHandler(mockState([pausedAuth(), runningAuth()]), im);
    const result = await handler();
    const text = result.content[0].text;
    expect(text).toContain('charge-routine');
    expect(text).toContain('deploy-routine');
  });
});

// ─── Mandate brief (MCP session instructions) ──────────────────────────────

describe('buildMandateBrief — simulation mode hides paused-profile mandates', () => {
  it('ON: ACTIVE AUTHORITIES omits the paused-profile mandate, keeps the running one', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const im = mockIntegrationManager([runningChargeTool()]);
    const brief = buildMandateBrief({
      authorizations: [pausedAuth(), runningAuth()].map(enrich),
      integrationManager: im,
    });
    expect(brief).toContain('[charge@0.3]');
    expect(brief).not.toContain('deploy@0.10');
    expect(brief).not.toContain('deploy-routine');
  });

  it('OFF: both mandates appear in the brief — unchanged behaviour', () => {
    delete process.env.SUVEREN_SIMULATION;
    const im = mockIntegrationManager([runningChargeTool()]);
    const brief = buildMandateBrief({
      authorizations: [pausedAuth(), runningAuth()].map(enrich),
      integrationManager: im,
    });
    expect(brief).toContain('[charge@0.3]');
    expect(brief).toContain('[deploy@0.10]');
  });
});
