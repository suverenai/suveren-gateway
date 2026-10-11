/**
 * Tools always listed. Many AI clients (ChatGPT among them) ignore
 * `tools/list_changed`: a tool that appears only once a mandate exists stays
 * invisible for the rest of the chat when the mandate is granted mid-session.
 * So every gated tool of a running connector is listed whether or not a
 * mandate covers it; the gate refuses an uncovered call.
 *
 * Covers, through the real MCP server wiring (src/index.ts refreshTools):
 *   - connector tools listed without a mandate; built-in, hideUnlessAuthorized,
 *     always-refused and internal tools are not;
 *   - the description is the same before and after a mandate is granted;
 *   - the refusal without a mandate says what to do;
 *   - list-authorizations separates "usable now" from "listed but not usable
 *     yet", and never names internal tools.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { createMcpServer } from '../src/index';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { listAuthorizationsHandler } from '../src/tools/authorizations';
import type { DiscoveredTool, IntegrationManager } from '../src/lib/integration-manager';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const CUSTOMERS = JSON.parse(readFileSync(join(profilesDir, 'customers/0.9.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(CUSTOMERS.id, CUSTOMERS);
});

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

const connectorTool: DiscoveredTool = {
  originalName: 'update_contact',
  namespacedName: 'crm__update_contact',
  integrationId: 'crm',
  description: 'Update a contact',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  gating: { profile: 'customers', executionMapping: { contact_type: 'contact_type' }, staticExecution: { action_type: 'write' } },
};
const connectorReadTool: DiscoveredTool = {
  originalName: 'get_contact',
  namespacedName: 'crm__get_contact',
  integrationId: 'crm',
  description: 'Get a contact',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  gating: { profile: 'customers', category: 'read', boundField: 'read_access', requiredValue: 'unlimited' } as DiscoveredTool['gating'],
};
const setupDataTool: DiscoveredTool = {
  originalName: 'load_simulation',
  namespacedName: 'crm__load_simulation',
  integrationId: 'crm',
  description: 'Load test data',
  inputSchema: {},
  gating: { profile: 'customers', executionMapping: {}, staticExecution: { action_type: 'setup' }, hideUnlessAuthorized: true } as DiscoveredTool['gating'],
};
const refusedTool: DiscoveredTool = {
  originalName: 'mystery',
  namespacedName: 'crm__mystery',
  integrationId: 'crm',
  description: 'Not described by the manifest',
  inputSchema: {},
  gating: { profile: 'customers', category: 'disabled' } as DiscoveredTool['gating'],
};
const builtinTool: DiscoveredTool = {
  originalName: 'create_mandate',
  namespacedName: 'setup__create_mandate',
  integrationId: 'setup',
  description: 'Propose a mandate',
  inputSchema: {},
  gating: { profile: 'delegation', executionMapping: {}, staticExecution: { action_type: 'mandate' } },
};
const internalTool: DiscoveredTool = {
  originalName: 'describe_mandate_proposal',
  namespacedName: 'setup__describe_mandate_proposal',
  integrationId: 'setup',
  description: 'internal',
  inputSchema: {},
  internal: true,
  gating: { profile: 'customers', category: 'disabled' } as DiscoveredTool['gating'],
};
const ALL = [connectorTool, connectorReadTool, setupDataTool, refusedTool, builtinTool, internalTool];

function customersMandate(): EnrichedAuthorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000000c1',
    profileId: CUSTOMERS.id,
    path: 'customers-routine',
    frame: { profile: CUSTOMERS.id, path: 'customers-routine', read_access: 'unlimited', write_daily_max: 5 },
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
  } as unknown as IntegrationManager;
}

function mockState(auths: EnrichedAuthorization[]): SharedState {
  return {
    getEnrichedAuthorizations: () => auths,
    executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
    spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
  } as unknown as SharedState;
}

/** The real MCP SDK's registered tools — `enabled` is what `tools/list` filters on. */
function registered(auths: EnrichedAuthorization[]) {
  const { server, refreshTools } = createMcpServer(mockState(auths), mockIntegrationManager(ALL));
  refreshTools();
  return { refreshTools, tools: (server as unknown as { _registeredTools: Record<string, { enabled: boolean; description?: string }> })._registeredTools };
}

describe('tools/list without any mandate (real MCP server wiring)', () => {
  it('lists every gated connector tool — write and read', () => {
    const { tools } = registered([]);
    expect(tools.crm__update_contact.enabled).toBe(true);
    expect(tools.crm__get_contact.enabled).toBe(true);
  });

  it('keeps hidden: built-in tools, hideUnlessAuthorized tools, always-refused tools', () => {
    const { tools } = registered([]);
    expect(tools.setup__create_mandate.enabled).toBe(false);
    expect(tools.crm__load_simulation.enabled).toBe(false);
    expect(tools.crm__mystery.enabled).toBe(false);
  });

  it('never registers internal tools at all', () => {
    const { tools } = registered([]);
    expect(tools.setup__describe_mandate_proposal).toBeUndefined();
  });

  it('a built-in tool is still listed once its own mandate exists (unchanged rule)', () => {
    const now = Math.floor(Date.now() / 1000);
    const delegation = { ...customersMandate(), profileId: 'delegation', attestations: [{ domain: 'owner', blob: 'b', expiresAt: now + 3600 }] } as EnrichedAuthorization;
    const { tools } = registered([delegation]);
    expect(tools.setup__create_mandate.enabled).toBe(true);
  });
});

describe('the description is fixed', () => {
  it('is identical before and after a mandate is granted, and says a mandate is needed', () => {
    const auths: EnrichedAuthorization[] = [];
    const { server, refreshTools } = createMcpServer(mockState(auths), mockIntegrationManager(ALL));
    refreshTools();
    const reg = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    const before = reg.crm__update_contact.description;
    auths.push(customersMandate());
    refreshTools();
    expect(reg.crm__update_contact.description).toBe(before);
    expect(before).toContain('works only under a customers mandate, check list-authorizations');
  });
});

describe('the refusal without a mandate', () => {
  it('names the tool and the profile and says what to do — nothing was done', async () => {
    const recorded: unknown[] = [];
    const state = { ...mockState([]), blocked: { record: (r: unknown) => recorded.push(r) } } as unknown as SharedState;
    const im = { ...mockIntegrationManager(ALL), mandateRefusal: () => null } as unknown as IntegrationManager;
    const r = await createGatedToolHandler(connectorTool, im, state)({ id: 'c-1' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      'Refused: no mandate covers crm__update_contact (customers). Nothing was done. ' +
        'Ask the person to grant a customers mandate in the gateway, then try again. No ticket was requested.',
    );
  });
});

describe('list-authorizations', () => {
  it('no mandate at all: says nothing is usable and lists the connector tools as "not usable yet"', async () => {
    const text = (await listAuthorizationsHandler(mockState([]), mockIntegrationManager(ALL))()).content[0].text;
    expect(text).toContain('no tool is usable yet');
    expect(text).toContain('Listed but not usable yet');
    expect(text).toContain('customers: crm__update_contact, crm__get_contact');
    for (const hidden of ['setup__create_mandate', 'crm__load_simulation', 'crm__mystery', 'describe_mandate_proposal']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('with a customers mandate: the customers tools are usable now, not under "not usable yet"', async () => {
    const text = (await listAuthorizationsHandler(mockState([customersMandate()]), mockIntegrationManager(ALL))()).content[0].text;
    expect(text).toContain('Active authorizations (usable now):');
    expect(text).not.toContain('Listed but not usable yet');
  });

  it('the capability map never names internal tools — not even as refused', async () => {
    const text = (await listAuthorizationsHandler(mockState([customersMandate()]), mockIntegrationManager(ALL))({ domain: 'customers' })).content[0].text;
    expect(text).toContain('Capability Map');
    expect(text).toContain('mystery'); // a real but undescribed tool is still named as refused
    expect(text).not.toContain('describe_mandate_proposal');
  });
});
