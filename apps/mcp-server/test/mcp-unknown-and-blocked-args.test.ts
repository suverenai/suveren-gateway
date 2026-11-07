/**
 * An argument the advertised schema leaves out must never be dropped silently.
 * 2026-11-07, Rehearsal A16 against the real Gmail test account: gmail__send_message with
 * `threadId` or `bcc` (both blocked in the manifest) became a proposal WITHOUT them — the MCP
 * SDK's Zod object stripped them before the gate ran, so the AI was never told.
 *
 * Exercises the real path: createMcpServer → the MCP SDK → a real MCP client's tools/call over
 * an in-memory transport. Only the gated handler is replaced, to see what reaches it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DiscoveredTool, IntegrationManager } from '../src/lib/integration-manager';
import type { SharedState } from '../src/lib/shared-state';

const received: Record<string, unknown>[] = [];
const denials: Record<string, unknown>[] = [];
vi.mock('../src/lib/tool-proxy', async (orig) => {
  const real = await orig<typeof import('../src/lib/tool-proxy')>();
  return {
    ...real,
    createGatedToolHandler: () => async (args: Record<string, unknown>) => {
      received.push(args);
      return { content: [{ type: 'text', text: 'reached the gate' }] };
    },
  };
});

const { createMcpServer } = await import('../src/index');

// The advertised schema, as integration-manager builds it: the blocked `threadId` is already
// removed; `_source` is the gateway's own argument.
const SEND: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'gmail__send_message',
  integrationId: 'gmail',
  description: 'send',
  inputSchema: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, body: { type: 'string' }, _source: { type: 'object' } } },
  gating: { profile: 'email', executionMapping: {}, staticExecution: { action_type: 'send' }, blockedArgs: ['threadId'] },
} as unknown as DiscoveredTool;

async function connect() {
  const state = {
    getEnrichedAuthorizations: () => [],
    executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
    spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
    denialLog: { record: (r: Record<string, unknown>) => denials.push(r) },
    outcomeOutbox: { take: () => [], drain: () => [], peek: () => [], getUndelivered: () => [], markDelivered: () => {} },
  } as unknown as SharedState;
  const im = { getAllTools: () => [SEND], isBuiltin: () => false } as unknown as IntegrationManager;
  const { server, refreshTools } = createMcpServer(state, im);
  refreshTools();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

describe('arguments the tool does not advertise', () => {
  it('a BLOCKED argument reaches the gate (which refuses it with its own reason) — it is not stripped', async () => {
    received.length = 0;
    const client = await connect();
    await client.callTool({ name: 'gmail__send_message', arguments: { to: ['a@x.example'], body: 'hi', threadId: 't1' } });
    await client.close();
    expect(received).toEqual([{ to: ['a@x.example'], body: 'hi', threadId: 't1' }]);
  });

  it('an UNKNOWN argument is refused by name; nothing reaches the gate', async () => {
    received.length = 0;
    const client = await connect();
    const r = await client.callTool({ name: 'gmail__send_message', arguments: { to: ['a@x.example'], body: 'hi', bcc: ['hidden@x.example'] } });
    await client.close();
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toContain('does not offer "bcc"');
    expect(text(r)).toContain('no ticket was requested');
    expect(received).toEqual([]);
    expect(denials.at(-1)).toEqual(expect.objectContaining({ kind: 'unsealed_arg', code: 'UNKNOWN_ARG', field: 'bcc' }));
  });

  it('only advertised arguments: passes through unchanged', async () => {
    received.length = 0;
    const client = await connect();
    await client.callTool({ name: 'gmail__send_message', arguments: { to: ['a@x.example'], body: 'hi', _source: { connector: 'gmail', kind: 'message', id: 'm1' } } });
    await client.close();
    expect(received).toEqual([{ to: ['a@x.example'], body: 'hi', _source: { connector: 'gmail', kind: 'message', id: 'm1' } }]);
  });
});
