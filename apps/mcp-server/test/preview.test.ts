/**
 * AU3 preview mechanism — manifest-driven read-before-approve, gateway-
 * internal, never ticketed, never read-gated (decision 1,
 * temp/briefs/au3-au5-brief.md).
 *
 * Covers: only the declared preview tool can ever be called (never an
 * arbitrary one); version stale/not-stale; none/unavailable/not_found;
 * the AU4 previewHash helpers.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifests } from '../src/lib/manifest-loader';
import {
  mapPreviewArgs,
  getToolPreviewConfig,
  readPreview,
  hashPreviewBody,
  buildInternalPreview,
  computeSubmissionPreviewHash,
  previewChangedSinceSubmission,
  PREVIEW_MESSAGE_CAP,
} from '../src/lib/preview';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

// ─── Manifest fixture — mirrors content/integrations/erp.json's ERP3 shape ──

let manifestDir: string;

beforeAll(() => {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-preview-manifests-'));
  mkdirSync(join(manifestDir, 'erp'));
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json' } }));
  writeFileSync(
    join(manifestDir, 'erp/manifest.json'),
    JSON.stringify({
      id: 'erp',
      name: 'ERP',
      version: '1',
      profile: 'sales',
      mcp: { command: 'node', args: [] },
      credentials: { fields: [], envMapping: {} },
      oauth: null,
      toolGating: {
        default: { executionMapping: {}, staticExecution: {} },
        overrides: {
          get_quote: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
          list_quotes: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
          create_quote: {
            executionMapping: { value: 'value' },
            staticExecution: { action_type: 'quote' },
          },
          send_quote: {
            executionMapping: { value: 'value' },
            staticExecution: { action_type: 'send' },
            preview: {
              tool: 'get_quote',
              args: { id: 'id', revision: 'revision' },
              version: { arg: 'revision', field: 'revision' },
            },
          },
        },
      },
    }),
  );
  loadManifests(manifestDir);
});

afterAll(() => rmSync(manifestDir, { recursive: true, force: true }));

const GET_QUOTE_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'Quote',
  properties: {
    id: { type: 'string', title: 'Quote ID' },
    revision: { type: 'number', title: 'Revision' },
    net_total: { type: 'number', title: 'Net total' },
  },
};

/** `currentRevision` models the connector's CURRENT state — used for the
 *  version-less ("current") read, i.e. when the call omits `revision`. */
function buildIntegrationManager(opts: { currentRevision?: number; tools?: DiscoveredTool[] } = {}) {
  const currentRevision = opts.currentRevision ?? 1;
  const callTool = vi.fn().mockImplementation(async (_integrationId: string, toolName: string, args: Record<string, unknown>) => {
    if (toolName === 'get_quote') {
      const revision = args.revision !== undefined ? args.revision : currentRevision;
      return {
        content: [{ type: 'text', text: `Quote ${String(args.id)} at revision ${revision}` }],
        structuredContent: { id: args.id, revision, net_total: 100 },
      };
    }
    if (toolName === 'list_quotes') return { content: [{ type: 'text', text: '[]' }] };
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const tools: DiscoveredTool[] = opts.tools ?? [
    {
      originalName: 'get_quote',
      namespacedName: 'erp__get_quote',
      integrationId: 'erp',
      description: '',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'number' } } },
      outputSchema: GET_QUOTE_OUTPUT_SCHEMA,
      gating: null,
    },
    {
      originalName: 'send_quote',
      namespacedName: 'erp__send_quote',
      integrationId: 'erp',
      description: '',
      inputSchema: { type: 'object' },
      gating: { profile: 'sales', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
    },
  ];
  const integrationManager = { getAllTools: () => tools, callTool } as unknown as IntegrationManager;
  return { integrationManager, callTool };
}

describe('mapPreviewArgs', () => {
  it('maps preview-tool arg names from action arg names, omitting absent sources', () => {
    const mapped = mapPreviewArgs({ args: { id: 'id', revision: 'revision' } }, { id: 'Q1', value: 100 });
    expect(mapped).toEqual({ id: 'Q1' }); // `revision` absent in actionArgs → omitted, never invented
  });

  it('never invents a value for an arg the action did not carry', () => {
    const mapped = mapPreviewArgs({ args: { id: 'sourceField' } }, {});
    expect(mapped).toEqual({});
  });
});

describe('getToolPreviewConfig', () => {
  it('returns the declared preview for a tool that has one', () => {
    expect(getToolPreviewConfig('erp', 'send_quote')).toEqual({
      tool: 'get_quote',
      args: { id: 'id', revision: 'revision' },
      version: { arg: 'revision', field: 'revision' },
    });
  });

  it('returns undefined for a tool with no preview declared — including the read tool ITSELF', () => {
    expect(getToolPreviewConfig('erp', 'create_quote')).toBeUndefined();
    expect(getToolPreviewConfig('erp', 'get_quote')).toBeUndefined();
    expect(getToolPreviewConfig('erp', 'list_quotes')).toBeUndefined();
  });

  it('returns undefined for an unknown integration', () => {
    expect(getToolPreviewConfig('does-not-exist', 'send_quote')).toBeUndefined();
  });
});

describe('readPreview — only a tool CURRENTLY discovered can ever be called', () => {
  it('calls exactly the named tool, with the mapped args, and returns its structured body + outputSchema', async () => {
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await readPreview(integrationManager, 'erp', 'get_quote', { id: 'Q1', revision: 2 });

    expect(callTool).toHaveBeenCalledWith('erp', 'get_quote', { id: 'Q1', revision: 2 });
    expect(result).toEqual({
      status: 'ok',
      body: {
        structured: { id: 'Q1', revision: 2, net_total: 100 },
        outputSchema: GET_QUOTE_OUTPUT_SCHEMA,
        text: 'Quote Q1 at revision 2',
      },
    });
  });

  it('unavailable/no_connector when the named tool is not in the CURRENT discovered list', async () => {
    const { integrationManager, callTool } = buildIntegrationManager({ tools: [] });

    const result = await readPreview(integrationManager, 'erp', 'get_quote', { id: 'Q1' });

    expect(result).toEqual({ status: 'unavailable', reason: 'no_connector' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('not_found when the read tool answers isError, with a capped message', async () => {
    const { integrationManager } = buildIntegrationManager();
    (integrationManager.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: [{ type: 'text', text: 'x'.repeat(600) }],
      isError: true,
    });

    const result = await readPreview(integrationManager, 'erp', 'get_quote', { id: 'missing' });

    expect(result.status).toBe('not_found');
    expect((result as { message?: string }).message).toHaveLength(PREVIEW_MESSAGE_CAP);
  });

  it('unavailable/connector_error when the call throws', async () => {
    const { integrationManager } = buildIntegrationManager();
    (integrationManager.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNRESET'));

    const result = await readPreview(integrationManager, 'erp', 'get_quote', { id: 'Q1' });

    expect(result).toEqual({ status: 'unavailable', reason: 'connector_error', message: 'ECONNRESET' });
  });

  it('unavailable/timeout when the call does not settle within the per-read budget', async () => {
    vi.useFakeTimers();
    try {
      const { integrationManager } = buildIntegrationManager();
      (integrationManager.callTool as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {}), // never resolves
      );

      const pending = readPreview(integrationManager, 'erp', 'get_quote', { id: 'Q1' });
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await pending;

      expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hashPreviewBody', () => {
  it('is stable for the same structured content regardless of key order', () => {
    expect(hashPreviewBody({ structured: { a: 1, b: 2 } })).toBe(hashPreviewBody({ structured: { b: 2, a: 1 } }));
  });

  it('differs when the structured content differs', () => {
    expect(hashPreviewBody({ structured: { revision: 1 } })).not.toBe(hashPreviewBody({ structured: { revision: 2 } }));
  });

  it('falls back to text when there is no structured content', () => {
    expect(hashPreviewBody({ text: 'hello' })).toBe(hashPreviewBody({ text: 'hello' }));
    expect(hashPreviewBody({ text: 'hello' })).not.toBe(hashPreviewBody({ text: 'goodbye' }));
  });
});

describe('buildInternalPreview', () => {
  it('status "none" for a tool with no declared preview — and never calls anything', async () => {
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await buildInternalPreview(integrationManager, 'erp', 'create_quote', { value: 100 });

    expect(result).toEqual({ status: 'none' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('status "none" when asked about the READ tool itself — cannot be used to bootstrap an arbitrary call', async () => {
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await buildInternalPreview(integrationManager, 'erp', 'get_quote', { id: 'Q1' });

    expect(result).toEqual({ status: 'none' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('calls ONLY the manifest-declared preview tool, never the action tool itself', async () => {
    const { integrationManager, callTool } = buildIntegrationManager({ currentRevision: 2 });

    await buildInternalPreview(integrationManager, 'erp', 'send_quote', { id: 'Q1', revision: 2, value: 100 });

    for (const call of callTool.mock.calls) {
      expect(call[1]).toBe('get_quote');
    }
    expect(callTool).not.toHaveBeenCalledWith(expect.anything(), 'send_quote', expect.anything());
  });

  it('ok with no version info when the declared `version.arg` is absent from the action args', async () => {
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await buildInternalPreview(integrationManager, 'erp', 'send_quote', { id: 'Q1', value: 100 });

    expect(result.status).toBe('ok');
    expect((result as { version?: unknown }).version).toBeUndefined();
    // Only ONE read happens — nothing to compare "current" against.
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('version declared, NOT stale: current equals approved', async () => {
    const { integrationManager } = buildIntegrationManager({ currentRevision: 2 });

    const result = await buildInternalPreview(integrationManager, 'erp', 'send_quote', {
      id: 'Q1', revision: 2, value: 100,
    });

    expect(result.status).toBe('ok');
    const version = (result as { version?: { approved: unknown; current: unknown; stale: boolean; currentBody?: unknown } }).version;
    expect(version).toMatchObject({ field: 'revision', approved: 2, current: 2, stale: false });
    expect(version?.currentBody).toBeUndefined();
  });

  it('version declared, STALE: current differs from approved, carries currentBody', async () => {
    const { integrationManager } = buildIntegrationManager({ currentRevision: 3 });

    const result = await buildInternalPreview(integrationManager, 'erp', 'send_quote', {
      id: 'Q1', revision: 2, value: 100,
    });

    expect(result.status).toBe('ok');
    const version = (result as { version?: { approved: unknown; current: unknown; stale: boolean; currentBody?: { structured?: Record<string, unknown> } } }).version;
    expect(version).toMatchObject({ field: 'revision', approved: 2, current: 3, stale: true });
    expect(version?.currentBody?.structured).toMatchObject({ revision: 3 });
  });

  it('passes through "unavailable"/"not_found" from the first read untouched', async () => {
    const { integrationManager } = buildIntegrationManager({ tools: [] });

    const result = await buildInternalPreview(integrationManager, 'erp', 'send_quote', { id: 'Q1', revision: 2 });

    expect(result).toEqual({ status: 'unavailable', reason: 'no_connector' });
  });

  it('degrades to "ok" with no version block when the SECOND (current) read fails', async () => {
    const { integrationManager, callTool } = buildIntegrationManager({ currentRevision: 2 });
    let calls = 0;
    callTool.mockImplementation(async (_i: string, toolName: string, args: Record<string, unknown>) => {
      calls++;
      if (toolName !== 'get_quote') return { content: [{ type: 'text', text: 'ok' }] };
      if (args.revision === undefined) {
        // second read (current) fails
        return { content: [{ type: 'text', text: 'boom' }], isError: true };
      }
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { id: args.id, revision: args.revision } };
    });

    const result = await buildInternalPreview(integrationManager, 'erp', 'send_quote', {
      id: 'Q1', revision: 2, value: 100,
    });

    expect(result.status).toBe('ok');
    expect((result as { version?: unknown }).version).toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe('computeSubmissionPreviewHash (AU4)', () => {
  it('undefined when the tool declares a version (the connector enforces staleness itself)', async () => {
    const { integrationManager } = buildIntegrationManager();
    const hash = await computeSubmissionPreviewHash(integrationManager, 'erp', 'send_quote', { id: 'Q1', revision: 1, value: 100 });
    expect(hash).toBeUndefined();
  });

  it('undefined when the tool declares no preview at all', async () => {
    const { integrationManager } = buildIntegrationManager();
    const hash = await computeSubmissionPreviewHash(integrationManager, 'erp', 'create_quote', { value: 100 });
    expect(hash).toBeUndefined();
  });
});

describe('previewChangedSinceSubmission (AU4)', () => {
  it('false when the re-read matches the stored hash', async () => {
    const { integrationManager } = buildIntegrationManager({ currentRevision: 1 });
    const hash = hashPreviewBody({ structured: { id: 'Q1', revision: 1, net_total: 100 } });

    const changed = await previewChangedSinceSubmission(integrationManager, 'erp', 'send_quote', { id: 'Q1', value: 100 }, hash);

    expect(changed).toBe(false);
  });

  it('true when the re-read differs from the stored hash', async () => {
    const { integrationManager } = buildIntegrationManager({ currentRevision: 2 });

    const changed = await previewChangedSinceSubmission(
      integrationManager, 'erp', 'send_quote', { id: 'Q1', value: 100 }, 'sha256:stale',
    );

    expect(changed).toBe(true);
  });

  it('fails closed (true) when the re-read itself fails', async () => {
    const { integrationManager, callTool } = buildIntegrationManager({ tools: [] });

    const changed = await previewChangedSinceSubmission(integrationManager, 'erp', 'send_quote', { id: 'Q1' }, 'sha256:anything');

    expect(changed).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('fails closed (true) when the manifest no longer declares a preview for this tool', async () => {
    const { integrationManager } = buildIntegrationManager();

    const changed = await previewChangedSinceSubmission(integrationManager, 'erp', 'create_quote', { value: 100 }, 'sha256:anything');

    expect(changed).toBe(true);
  });
});
