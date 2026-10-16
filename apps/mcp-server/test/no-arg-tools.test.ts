/**
 * A connector tool that takes no arguments must reach the connector with no
 * arguments. Registered without an input schema, the MCP SDK calls the handler
 * as (extra) instead of (args, extra) — the gateway then forwarded the request's
 * own data (signal, sessionId, _meta, requestId, requestInfo with its headers)
 * to the connector as the tool's arguments. Found 2026-10-16: Mollie
 * GetOrganizationDetails refused "Unexpected keyword argument sessionId …".
 *
 * Exercises the real path: createMcpServer → the MCP SDK → a real MCP client's
 * tools/call over an in-memory transport. Only the gated handler is replaced,
 * to see the arguments it receives.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DiscoveredTool, IntegrationManager } from '../src/lib/integration-manager';
import type { SharedState } from '../src/lib/shared-state';

const received: Record<string, unknown[]> = {};
vi.mock('../src/lib/tool-proxy', async (orig) => {
  const real = await orig<typeof import('../src/lib/tool-proxy')>();
  return {
    ...real,
    createGatedToolHandler: (tool: DiscoveredTool) => async (args: unknown) => {
      (received[tool.namespacedName] ??= []).push(args);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
});

const { createMcpServer } = await import('../src/index');

function tool(name: string, inputSchema: Record<string, unknown>): DiscoveredTool {
  return {
    originalName: name,
    namespacedName: `mollie__${name}`,
    integrationId: 'mollie',
    description: name,
    inputSchema,
    gating: { profile: 'charge', executionMapping: {}, staticExecution: { action_type: 'charge' } },
  } as DiscoveredTool;
}

const TOOLS = [
  tool('GetOrganizationDetails', { type: 'object', properties: {} }),
  tool('GetPrimaryBalance', {}),
  tool('ListProfiles', { type: 'object', properties: { limit: { type: 'number' } } }),
];

async function connect() {
  const state = {
    getEnrichedAuthorizations: () => [],
    executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
    spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
    outcomeOutbox: { take: () => [], drain: () => [], peek: () => [] },
  } as unknown as SharedState;
  const im = { getAllTools: () => TOOLS, isBuiltin: () => false } as unknown as IntegrationManager;
  const { server, refreshTools } = createMcpServer(state, im);
  refreshTools();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  return client;
}

describe('connector tools without arguments', () => {
  it('reach the gated handler with empty arguments, never the request data', async () => {
    const client = await connect();
    await client.callTool({ name: 'mollie__GetOrganizationDetails', arguments: {} });
    await client.callTool({ name: 'mollie__GetPrimaryBalance' });
    await client.close();
    expect(received.mollie__GetOrganizationDetails).toEqual([{}]);
    expect(received.mollie__GetPrimaryBalance).toEqual([{}]);
  });

  it('a tool with arguments still gets exactly its arguments', async () => {
    const client = await connect();
    await client.callTool({ name: 'mollie__ListProfiles', arguments: { limit: 5 } });
    await client.close();
    expect(received.mollie__ListProfiles).toEqual([{ limit: 5 }]);
  });
});
