/**
 * `hideUnlessAuthorized` — a manifest tool override that hides a tool from
 * `tools/list` unless at least one COMPLETE mandate on the connector's
 * profile grants every cumulative_count bound applying to the tool's
 * action_type a value > 0.
 *
 * Motivating case: erp/crm/mail's `load_simulation` setup tool. Its own
 * mandate template grants `setup_daily_max: 1`; the AGENT's day-to-day
 * mandate grants `setup_daily_max: 0`. Without this flag, an agent holding
 * only the day-to-day mandate still SEES `load_simulation` in its tool list
 * (any complete mandate on the profile is enough) even though every call
 * would be refused — advertising a hidden setup capability the mandate model
 * is supposed to keep implicit.
 *
 * Three layers tested, cheapest first:
 *  A. `toolIsAuthorizedForDisplay` — the pure predicate itself.
 *  B. `resolveToolGating` — the flag survives manifest → runtime gating
 *     config (a silent drop here would make every case in A pass while the
 *     real system still showed the tool).
 *  C. End to end: a REAL IntegrationManager + a REAL spawned downstream MCP
 *     server + the REAL `createMcpServer`/`refreshTools` wiring, asserting
 *     the MCP SDK's own `enabled` flag on the registered tool — the thing
 *     `tools/list` actually filters on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { registerProfile, clearProfiles } from '@hap/core';
import { toolIsAuthorizedForDisplay } from '../src/lib/tool-proxy';
import { IntegrationManager } from '../src/lib/integration-manager';
import { createMcpServer } from '../src/index';
import type { IntegrationConfig, ToolGatingConfig } from '../src/lib/integration-registry';
import type { DiscoveredTool } from '../src/lib/integration-manager';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { ProfileToolGating } from '@hap/core';

const PROFILE = 'hide-test-profile';

beforeAll(() => {
  // Mirrors the shape of sales@0.2 / email@0.7 / customers@0.8's
  // `setup_daily_max` field exactly (cumulative_count, appliesTo: ["setup"]).
  registerProfile(PROFILE, {
    id: PROFILE,
    name: 'Hide Test',
    version: '0',
    boundsSchema: {
      keyOrder: ['setup_daily_max'],
      fields: {
        setup_daily_max: {
          type: 'number',
          required: true,
          boundType: { kind: 'cumulative_count', window: 'daily' },
          appliesTo: ['setup'],
        },
      },
    },
    contextSchema: { keyOrder: [], fields: {} },
  } as unknown as Parameters<typeof registerProfile>[1]);
});
afterAll(() => clearProfiles());

function hiddenTool(): DiscoveredTool {
  return {
    originalName: 'load_simulation',
    namespacedName: 'sim-conn__load_simulation',
    integrationId: 'sim-conn',
    description: 'Load test data',
    inputSchema: {},
    gating: {
      profile: PROFILE,
      executionMapping: {},
      staticExecution: { action_type: 'setup' },
      hideUnlessAuthorized: true,
    },
  };
}

function auth(setupDailyMax: number): EnrichedAuthorization {
  return {
    authorizationId: 'authz_hide_test',
    profileId: PROFILE,
    path: 'hide-test',
    frame: {},
    bounds: { setup_daily_max: setupDailyMax },
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    complete: true,
    gateContent: null,
  } as unknown as EnrichedAuthorization;
}

// ─── A. toolIsAuthorizedForDisplay — the pure predicate ─────────────────────

describe('toolIsAuthorizedForDisplay', () => {
  it('hidden with no mandate at all', () => {
    expect(toolIsAuthorizedForDisplay(hiddenTool(), [])).toBe(false);
  });

  it('hidden when the only matching mandate sets the bound to 0', () => {
    expect(toolIsAuthorizedForDisplay(hiddenTool(), [auth(0)])).toBe(false);
  });

  it('shown once a matching mandate sets the bound above 0', () => {
    expect(toolIsAuthorizedForDisplay(hiddenTool(), [auth(1)])).toBe(true);
  });

  it('a tool WITHOUT the flag is never hidden by this mechanism, regardless of the bound value', () => {
    // Note: "is there a matching mandate at all" is the CALLER's job
    // (`matchingAuths.length > 0 && toolIsAuthorizedForDisplay(...)` in
    // refreshTools) — this predicate only answers the hideUnlessAuthorized
    // question, so it is deliberately `true` here even for an empty list.
    const tool = hiddenTool();
    tool.gating = { ...tool.gating!, hideUnlessAuthorized: false } as ToolGatingConfig;
    expect(toolIsAuthorizedForDisplay(tool, [auth(0)])).toBe(true);
    expect(toolIsAuthorizedForDisplay(tool, [])).toBe(true);
  });

  it('a tool with no cumulative_count bound applying to its action type is vacuously visible', () => {
    const tool = hiddenTool();
    tool.gating = { ...tool.gating!, staticExecution: { action_type: 'no_such_action_type' } };
    expect(toolIsAuthorizedForDisplay(tool, [auth(0)])).toBe(true);
  });
});

// ─── B. resolveToolGating — the flag survives manifest → runtime config ────

describe('resolveToolGating threads hideUnlessAuthorized from the manifest', () => {
  function resolve(gating: ProfileToolGating, toolName: string): ToolGatingConfig | null {
    const manager = new IntegrationManager(new Map()) as unknown as {
      resolveToolGating(
        profileId: string | null,
        profileGating: ProfileToolGating | null,
        toolName: string,
      ): ToolGatingConfig | null;
    };
    return manager.resolveToolGating(PROFILE, gating, toolName);
  }

  it('carries hideUnlessAuthorized: true through for a write tool', () => {
    const gating: ProfileToolGating = {
      default: { executionMapping: {} },
      overrides: {
        load_simulation: {
          executionMapping: {},
          staticExecution: { action_type: 'setup' },
          hideUnlessAuthorized: true,
        } as never,
      },
    };
    expect(resolve(gating, 'load_simulation')?.hideUnlessAuthorized).toBe(true);
  });

  it('a tool with no hideUnlessAuthorized in its manifest entry resolves it as undefined (never hidden)', () => {
    const gating: ProfileToolGating = {
      default: { executionMapping: {} },
      overrides: {
        send_message: { executionMapping: {}, staticExecution: { action_type: 'send' } } as never,
      },
    };
    expect(resolve(gating, 'send_message')?.hideUnlessAuthorized).toBeUndefined();
  });
});

// ─── C. End to end: real IntegrationManager + real spawned MCP server ──────

describe('hideUnlessAuthorized — end to end through refreshTools (tools/list visibility)', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures', 'test-mcp-server.ts');
  let im: IntegrationManager;

  beforeAll(async () => {
    im = new IntegrationManager(new Map());
    const config: IntegrationConfig = {
      id: 'hide-e2e',
      name: 'Hide E2E Connector',
      command: 'npx',
      args: ['tsx', FIXTURE],
      envKeys: {},
      profile: PROFILE,
      enabled: true,
      toolGating: {
        default: { executionMapping: {} },
        overrides: {
          // The fixture's real downstream tool is "echo" — gated here exactly
          // as erp/crm/mail gate their real "load_simulation" tool.
          echo: {
            executionMapping: {},
            staticExecution: { action_type: 'setup' },
            hideUnlessAuthorized: true,
          } as never,
          // Control: "add" is gated the same way but WITHOUT the flag — must
          // never be hidden by this mechanism, however the bound is set.
          add: {
            executionMapping: {},
            staticExecution: { action_type: 'setup' },
          } as never,
        },
      } as IntegrationConfig['toolGating'],
    };
    await im.startIntegration(config);
  }, 30_000);

  afterAll(async () => {
    await im.shutdown();
  });

  function mockExecutionLog() {
    return { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 };
  }

  function mockState(auths: EnrichedAuthorization[]): SharedState {
    return {
      getEnrichedAuthorizations: () => auths,
      executionLog: mockExecutionLog(),
      spClient: { isUnlocked: () => true },
    } as unknown as SharedState;
  }

  /** The real MCP SDK's own `enabled` flag — what tools/list actually filters on. */
  function registeredTools(auths: EnrichedAuthorization[]): Record<string, { enabled: boolean }> {
    const { server, refreshTools } = createMcpServer(mockState(auths), im);
    refreshTools();
    return (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
  }

  it('hidden with no mandate', () => {
    const tools = registeredTools([]);
    expect(tools['hide-e2e__echo'].enabled).toBe(false);
  });

  it('hidden with a mandate whose setup_daily_max is 0', () => {
    const tools = registeredTools([auth(0)]);
    expect(tools['hide-e2e__echo'].enabled).toBe(false);
  });

  it('shown with a mandate whose setup_daily_max is 1', () => {
    const tools = registeredTools([auth(1)]);
    expect(tools['hide-e2e__echo'].enabled).toBe(true);
  });

  it('a manifest tool without the flag ("add") is never hidden by this mechanism', () => {
    // Same mandate state (setup_daily_max: 0) that hides "echo" above —
    // "add" has no hideUnlessAuthorized, so it is shown exactly because any
    // complete matching mandate exists (the ordinary, pre-existing rule).
    const tools = registeredTools([auth(0)]);
    expect(tools['hide-e2e__add'].enabled).toBe(true);
    expect(tools['hide-e2e__echo'].enabled).toBe(false);
  });

  it('calling a hidden tool is still refused normally if attempted', async () => {
    // Visibility and enforcement are independent: hiding is presentation
    // only. With no matching mandate at all, the call must still be refused
    // by the ordinary "no active authorization" check — the important thing
    // is nothing here silently succeeds just because the tool is "hidden".
    const { server, refreshTools } = createMcpServer(mockState([]), im);
    refreshTools();
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }>;
    })._registeredTools;
    const result = await tools['hide-e2e__echo'].handler({ message: 'hi' });
    expect(result.isError).toBe(true);
  });
});
