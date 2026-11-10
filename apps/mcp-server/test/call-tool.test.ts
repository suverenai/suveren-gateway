/**
 * call-tool — one tool, listed from the start, that runs any other tool by name (Andreas,
 * 2026-11-10): ChatGPT Desktop loads the tool list once and ignores `tools/list_changed`, so a
 * tool added later (a connector that started, Setup signed) was out of reach until the app
 * restarted.
 *
 * Through the real wiring: createMcpServer → the MCP SDK → a real MCP client over an in-memory
 * transport. Only the gated handler is replaced, to see exactly what reaches it — the gate itself
 * is proven on the real stack in suveren-e2e (test/call-tool-fixed-list.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DiscoveredTool, IntegrationManager } from '../src/lib/integration-manager';
import type { SharedState } from '../src/lib/shared-state';

const { dataDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const dir = mkdtempSync(j(tmpdir(), 'call-tool-'));
  process.env.SUVEREN_DATA_DIR = dir;
  return { dataDir: dir };
});
void dataDir;

const reached: Array<{ tool: string; args: Record<string, unknown> }> = [];
vi.mock('../src/lib/tool-proxy', async (orig) => {
  const real = await orig<typeof import('../src/lib/tool-proxy')>();
  return {
    ...real,
    createGatedToolHandler: (tool: DiscoveredTool) => async (args: Record<string, unknown>) => {
      reached.push({ tool: tool.namespacedName, args });
      return { content: [{ type: 'text', text: `gate of ${tool.namespacedName}` }] };
    },
  };
});

const { createMcpServer } = await import('../src/index');
const { newToolsNote, SessionChangeNotice } = await import('../src/lib/change-notice');
type Told = import('../src/lib/change-notice').Told;

const tool = (name: string, over: Partial<DiscoveredTool> = {}): DiscoveredTool => ({
  originalName: name.split('__')[1],
  namespacedName: name,
  integrationId: name.split('__')[0],
  description: name,
  inputSchema: { type: 'object', properties: { to: { type: 'string' }, count: { type: 'number' } }, required: ['to'] },
  gating: { profile: 'email', executionMapping: {}, staticExecution: { action_type: 'send' } },
  ...over,
} as unknown as DiscoveredTool);

const SEND = tool('mail__send_message');
const INTERNAL = tool('setup__describe_mandate_proposal', { internal: true } as Partial<DiscoveredTool>);
// A built-in that is not always listed (Setup): hidden — disabled — until a mandate covers it.
const SETUP = tool('setup__create_mandate', { gating: { profile: 'delegation', executionMapping: {}, staticExecution: { action_type: 'mandate' } } } as Partial<DiscoveredTool>);

function stack(initial: DiscoveredTool[]) {
  let tools = initial;
  let auths: Array<Record<string, unknown>> = [];
  const state = {
    getEnrichedAuthorizations: () => auths,
    executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
    spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
    denialLog: { record: () => {} },
    outcomeOutbox: { take: () => [], drain: () => [], peek: () => [], getUndelivered: () => [], markDelivered: () => {} },
  } as unknown as SharedState;
  const im = {
    getAllTools: () => tools,
    isBuiltin: (id: string) => id === 'setup',
    builtinAlwaysListed: () => false,
    getStatus: () => [],
  } as unknown as IntegrationManager;
  const made = createMcpServer(state, im);
  return {
    ...made,
    setTools: (t: DiscoveredTool[]) => { tools = t; made.registerProxiedTools(); made.refreshTools(); },
    grantSetup: () => {
      auths = [{ profileId: 'github.com/x/delegation@0.4', complete: true, attestations: [{ expiresAt: Math.floor(Date.now() / 1000) + 3600 }], bounds: {}, context: {} }];
      made.refreshTools();
    },
  };
}

async function client(server: ReturnType<typeof stack>['server']) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'fixed-list-app', version: '0' });
  await c.connect(b);
  return c;
}

const first = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const all = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map(c => c.text).join('\n');

describe('call-tool', () => {
  it('is listed from the start; the internal tool never is', async () => {
    const s = stack([SEND, INTERNAL]);
    const c = await client(s.server);
    const names = (await c.listTools()).tools.map(t => t.name);
    expect(names).toContain('call-tool');
    expect(names).not.toContain('setup__describe_mandate_proposal');
    await c.close();
  });

  it('reaches the same handler with the same arguments as a direct call', async () => {
    const s = stack([SEND]);
    const c = await client(s.server);
    reached.length = 0;
    const direct = await c.callTool({ name: 'mail__send_message', arguments: { to: 'a@x.example', count: 1 } });
    const through = await c.callTool({ name: 'call-tool', arguments: { tool: 'mail__send_message', arguments: { to: 'a@x.example', count: 1 } } });
    expect(reached).toEqual([
      { tool: 'mail__send_message', args: { to: 'a@x.example', count: 1 } },
      { tool: 'mail__send_message', args: { to: 'a@x.example', count: 1 } },
    ]);
    expect(first(through)).toBe(first(direct));
    await c.close();
  });

  it('an argument the tool does not offer is refused by that tool, as directly', async () => {
    const s = stack([SEND]);
    const c = await client(s.server);
    reached.length = 0;
    const r = await c.callTool({ name: 'call-tool', arguments: { tool: 'mail__send_message', arguments: { to: 'a@x.example', bcc: 'h@x.example' } } });
    expect(r.isError).toBe(true);
    expect(first(r)).toContain('does not offer "bcc"');
    expect(reached).toEqual([]);
    await c.close();
  });

  it('bad arguments are refused by the target tool\'s own schema; nothing reaches the gate', async () => {
    const s = stack([SEND]);
    const c = await client(s.server);
    reached.length = 0;
    const r = await c.callTool({ name: 'call-tool', arguments: { tool: 'mail__send_message', arguments: { count: 'three' } } });
    expect(r.isError).toBe(true);
    expect(first(r)).toContain('Refused: the arguments do not fit "mail__send_message"');
    expect(first(r)).toContain('no ticket was requested');
    expect(reached).toEqual([]);
    await c.close();
  });

  it('an internal tool, an unknown name and call-tool itself are refused as not there', async () => {
    const s = stack([SEND, INTERNAL]);
    const c = await client(s.server);
    reached.length = 0;
    for (const name of ['setup__describe_mandate_proposal', 'nothing__here', 'call-tool']) {
      const r = await c.callTool({ name: 'call-tool', arguments: { tool: name, arguments: {} } });
      expect(r.isError, name).toBe(true);
      expect(first(r)).toBe(`Refused: there is no tool "${name}" here. Nothing was done and no ticket was requested. Use a tool name exactly as the gateway names it; list-authorizations(domain) names the tools of an area.`);
    }
    expect(reached).toEqual([]);
    await c.close();
  });

  it('a Setup tool without a Setup mandate is refused, as directly; with one it runs', async () => {
    const s = stack([SEND, SETUP]);
    const c = await client(s.server);
    reached.length = 0;
    const direct = await c.callTool({ name: 'setup__create_mandate', arguments: { to: 'x' } });
    expect(direct.isError).toBe(true);
    const r = await c.callTool({ name: 'call-tool', arguments: { tool: 'setup__create_mandate', arguments: { to: 'x' } } });
    expect(r.isError).toBe(true);
    expect(first(r)).toContain('Refused: "setup__create_mandate" cannot be used now.');
    expect(reached).toEqual([]);
    s.grantSetup();
    const ok = await c.callTool({ name: 'call-tool', arguments: { tool: 'setup__create_mandate', arguments: { to: 'x' } } });
    expect(first(ok)).toBe('gate of setup__create_mandate');
    expect(reached).toEqual([{ tool: 'setup__create_mandate', args: { to: 'x' } }]);
    await c.close();
  });

  it('a tool added after the chat started is reachable without listing tools again', async () => {
    const s = stack([]);
    const c = await client(s.server);
    expect((await c.listTools()).tools.map(t => t.name)).not.toContain('mail__send_message');
    s.setTools([SEND]);
    reached.length = 0;
    const r = await c.callTool({ name: 'call-tool', arguments: { tool: 'mail__send_message', arguments: { to: 'a@x.example' } } });
    expect(first(r)).toBe('gate of mail__send_message');
    expect(reached).toHaveLength(1);
    await c.close();
  });
});

describe('the change note names tools added since the chat started', () => {
  it('once with the way to reach them, then only the names', async () => {
    const s = stack([]);
    const c = await client(s.server);
    expect(all(await c.callTool({ name: 'list-integrations', arguments: {} }))).not.toContain('[Suveren gateway]');
    s.setTools([SEND]);
    const one = all(await c.callTool({ name: 'list-integrations', arguments: {} }));
    expect(one).toContain('[Suveren gateway] New tools are available since this chat started: mail__send_message. If they are not in your tool list, call them through call-tool(tool: "<name>", arguments: {...}). Or the person restarts the AI app, which then lists them.');
    expect(all(await c.callTool({ name: 'list-integrations', arguments: {} }))).not.toContain('[Suveren gateway]');
    s.setTools([SEND, SETUP]);
    s.grantSetup();
    const two = all(await c.callTool({ name: 'call-tool', arguments: { tool: 'list-integrations', arguments: {} } }));
    // Setup was signed too: one note carries both.
    expect(two).toContain('[Suveren gateway] Mandates changed since this chat started: added');
    expect(two).toContain('\n\nNew tools are available since this chat started: setup__create_mandate.');
    expect(two).not.toContain('restarts');
    // One note per answer, also through call-tool.
    expect(two.split('[Suveren gateway]')).toHaveLength(2);
    await c.close();
  });

  it('many tools are counted per connector', () => {
    const names = Array.from({ length: 12 }, (_, i) => `mollie__T${i}`).concat(['mail__a']);
    expect(newToolsNote(names, false)).toBe('New tools are available since this chat started: 12 from mollie, 1 from mail. list-authorizations(domain) names them.');
    expect(newToolsNote([], true)).toBeUndefined();
  });

  it('a new session of an app that keeps its old list hears about tools added since it last connected', async () => {
    // Codex opens a new session inside the same chat after a gateway restart, and keeps its list.
    const store = new Map<string, Told>();
    const ledger = { lastTold: (app: string) => store.get(app), record: (app: string, t: Told) => { store.set(app, t); } };
    let tools = ['list-authorizations', 'call-tool'];
    const session = () => {
      const n = new SessionChangeNotice({ now: () => ({ brief: '', mandates: [] }), currentBrief: () => null, ledger, appName: () => 'keeps-its-list', listed: () => tools });
      n.startListing();
      return n;
    };
    const first = session();
    expect(first.noteForAnswer()).toBeUndefined();
    tools = [...tools, 'mail__send_message'];
    // The old session never answered again; a new one starts with the longer list.
    const second = session();
    expect(second.noteForAnswer()).toBe('[Suveren gateway] New tools are available since this app last connected: mail__send_message. If they are not in your tool list, call them through call-tool(tool: "<name>", arguments: {...}). Or the person restarts the AI app, which then lists them.');
    expect(second.noteForAnswer()).toBeUndefined();
    // A third session of the same app, with nothing new, hears nothing.
    expect(session().noteForAnswer()).toBeUndefined();
  });
});
