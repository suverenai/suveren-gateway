/**
 * DL1 (temp/briefs/dl-delegation-brief.md) — a built-in's `internal` tool
 * (today: `setup__describe_mandate_proposal` / `setup__describe_brief_proposal`,
 * the AU3 preview helpers for `create_mandate` / `set_agent_brief`) must be
 * never listed in `tools/list` and never callable by an agent, reachable
 * only through `IntegrationManager.callTool` called directly by
 * gateway-internal code (`/internal/preview`, see ../src/lib/preview.ts).
 *
 * Three independent layers, cheapest first:
 *  A. `DiscoveredTool.internal` survives `registerBuiltin` (manifest → runtime).
 *  B. `index.ts`'s `registerProxiedTools` never hands it to the real MCP SDK —
 *     the strongest proof of "never listed, never callable over MCP" (the SDK's
 *     own `tools/list`/`tools/call` only ever sees tools registered with it).
 *  C. `tool-proxy.ts`'s `createGatedToolHandler` refuses it too, independently —
 *     defence in depth for any future caller that builds a handler directly.
 *  D. `IntegrationManager.callTool` (what `/internal/preview` actually uses)
 *     still reaches it — the mechanism is a block on the AGENT path, not a
 *     dead tool.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// set_agent_brief's preview (describe_brief_proposal, test D below) reads the
// agent brief file — point it at a scratch dir, never ~/.suveren, BEFORE
// context-loader.ts is imported (it reads SUVEREN_DATA_DIR once, at import).
const dataDir = mkdtempSync(join(tmpdir(), 'gw-internal-preview-'));
process.env.SUVEREN_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { IntegrationManager } = await import('../src/lib/integration-manager');
const { registerBuiltins } = await import('../src/lib/builtins');
const { createGatedToolHandler } = await import('../src/lib/tool-proxy');
const { createMcpServer } = await import('../src/index');
import type { SharedState } from '../src/lib/shared-state';
import type { ReportSources } from '../src/lib/report';

function buildManager() {
  const im = new IntegrationManager();
  registerBuiltins({ state: {} as SharedState, integrationManager: im, reportSources: {} as ReportSources });
  return im;
}

const INTERNAL_TOOLS = ['setup__describe_mandate_proposal', 'setup__describe_brief_proposal'];

describe('internal builtin tools (DL1) — never listed, never callable by an agent', () => {
  it('A. DiscoveredTool.internal is set for the two preview tools, and ONLY for them', () => {
    const im = buildManager();
    const all = im.getAllTools();
    for (const name of INTERNAL_TOOLS) {
      expect(all.find((t) => t.namespacedName === name)?.internal).toBe(true);
    }
    const others = all.filter((t) => !INTERNAL_TOOLS.includes(t.namespacedName));
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) expect(t.internal).toBeFalsy();
  });

  it('B. never registered with the real MCP SDK — absent from the tools/list map entirely', () => {
    const im = buildManager();
    const state = {
      getEnrichedAuthorizations: () => [],
      executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [] },
      spClient: { isUnlocked: () => true },
    } as unknown as SharedState;
    const { server } = createMcpServer(state, im);
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    for (const name of INTERNAL_TOOLS) {
      expect(registered[name]).toBeUndefined();
    }
    // Control: an ordinary builtin tool of the SAME group IS registered.
    expect(registered['setup__get_guide']).toBeDefined();
  });

  it('C. createGatedToolHandler refuses it directly too (defence in depth)', async () => {
    const im = buildManager();
    const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__describe_mandate_proposal')!;
    const state = {} as unknown as SharedState;
    const result = await createGatedToolHandler(tool, im, state)({ profile: 'sales', limits: {}, intent: 'x', mode: 'review' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/internal and cannot be called directly/);
  });

  it('D. IntegrationManager.callTool (what /internal/preview uses) still reaches it', async () => {
    const im = buildManager();
    const result = await im.callTool('setup', 'describe_brief_proposal', { content: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ change: expect.any(String), words: 1 });
  });
});
