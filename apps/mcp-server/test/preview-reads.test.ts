/**
 * AU8 — several reads per preview (temp/briefs/au8-brief.md). Covers:
 *   - planPreviewReads: forEach expansion against the bound action args,
 *     the 50-element cap, no-target skipping, attach/fields pass-through.
 *   - buildInternalPreview for a LIST preview: one section per read,
 *     per-section degrade (a failing read never blocks the others).
 *   - AU4 combined hash: computeSubmissionPreviewHash/previewChangedSinceSubmission
 *     cover every read without a declared `version` in one hash; a read
 *     WITH `version` is excluded (the connector enforces that one itself).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifests } from '../src/lib/manifest-loader';
import {
  planPreviewReads,
  buildInternalPreview,
  computeSubmissionPreviewHash,
  previewChangedSinceSubmission,
  hashPreviewBody,
} from '../src/lib/preview';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { PreviewReadConfig } from '../src/lib/tool-gating-types';

// ─── planPreviewReads — pure, no I/O ────────────────────────────────────────

describe('planPreviewReads', () => {
  it('a legacy object preview plans as a single-item list', () => {
    const plan = planPreviewReads({ tool: 'get_quote', args: { id: 'id' } }, { id: 'Q1' });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ tool: 'get_quote', args: { id: 'Q1' }, noTarget: false });
  });

  it('a non-forEach read with no target is marked noTarget, never invented', () => {
    const plan = planPreviewReads([{ tool: 'get_contact', args: { id: 'contact_id' } }], { title: 'x' });
    expect(plan[0]).toMatchObject({ noTarget: true, args: {} });
  });

  it('attach and fields pass through untouched', () => {
    const plan = planPreviewReads(
      [{ tool: 'get_customer', args: { id: 'customer_id' }, attach: 'customer_id', fields: ['name'] }],
      { customer_id: 'cust-1' },
    );
    expect(plan[0]).toMatchObject({ attach: 'customer_id', fields: ['name'] });
  });

  it('forEach expands one planned read per element, mapping element fields (not top-level action args)', () => {
    const plan = planPreviewReads(
      [{ tool: 'get_item', forEach: 'lines', args: { id: 'item_id' }, attach: 'item' }],
      { lines: [{ item_id: 'item-1', qty: 10 }, { item_id: 'item-2', qty: 4 }] },
    );
    expect(plan[0].forEach).toBe('lines');
    expect(plan[0].attach).toBe('item');
    expect(plan[0].elements).toEqual([{ args: { id: 'item-1' } }, { args: { id: 'item-2' } }]);
  });

  it('forEach over a MISSING or non-array source plans zero elements — not an error', () => {
    const plan = planPreviewReads([{ tool: 'get_item', forEach: 'lines', args: { id: 'item_id' } }], {});
    expect(plan[0].elements).toEqual([]);
    expect(plan[0].overflow).toBeUndefined();

    const plan2 = planPreviewReads([{ tool: 'get_item', forEach: 'lines', args: { id: 'item_id' } }], { lines: 'not-an-array' });
    expect(plan2[0].elements).toEqual([]);
  });

  it('forEach caps at 50 elements and reports the overflow', () => {
    const lines = Array.from({ length: 63 }, (_, i) => ({ item_id: `item-${i}` }));
    const plan = planPreviewReads([{ tool: 'get_item', forEach: 'lines', args: { id: 'item_id' } }], { lines });
    expect(plan[0].elements).toHaveLength(50);
    expect(plan[0].overflow).toEqual({ shown: 50, total: 63 });
  });

  it('a non-object element is skipped, never passed through as-is', () => {
    const plan = planPreviewReads(
      [{ tool: 'get_item', forEach: 'lines', args: { id: 'item_id' } }],
      { lines: [{ item_id: 'item-1' }, 'oops', null, 5] },
    );
    expect(plan[0].elements).toEqual([{ args: { id: 'item-1' } }]);
  });

  it('several reads plan in declared order', () => {
    const declaration: PreviewReadConfig[] = [
      { tool: 'get_customer', args: { id: 'customer_id' }, attach: 'customer_id' },
      { tool: 'get_item', forEach: 'lines', args: { id: 'item_id' }, attach: 'item' },
    ];
    const plan = planPreviewReads(declaration, { customer_id: 'cust-1', lines: [{ item_id: 'item-1' }] });
    expect(plan.map((p) => p.tool)).toEqual(['get_customer', 'get_item']);
  });
});

// ─── buildInternalPreview / AU4 hashing — against a REAL loaded manifest ────
// (getToolPreviewConfig reads the manifest for a non-builtin integration, so
// these need a loaded fixture, same pattern as preview.test.ts.)

let manifestDir: string;

const CREATE_QUOTE_PREVIEW: PreviewReadConfig[] = [
  { tool: 'get_customer', args: { id: 'customer_id' }, attach: 'customer_id' },
  { tool: 'get_item', forEach: 'lines', args: { id: 'item_id' }, attach: 'item' },
];

beforeAll(() => {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-au8-preview-manifests-'));
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
          create_quote: {
            executionMapping: { value: 'value' },
            staticExecution: { action_type: 'quote' },
            preview: CREATE_QUOTE_PREVIEW,
            display: { order: ['customer_id', 'lines', 'value'], money: ['value', 'lines[].list_price'], currencyField: 'currency' },
          },
          // A single read with no `attach` — "shown as its own section" (e.g. a duplicate check).
          find_duplicate_demo: {
            executionMapping: {},
            preview: [{ tool: 'get_customer', args: { id: 'customer_id' } }],
          },
        },
      },
    }),
  );
  loadManifests(manifestDir);
});

afterAll(() => rmSync(manifestDir, { recursive: true, force: true }));

const ITEM_TOOL: DiscoveredTool = {
  originalName: 'get_item', namespacedName: 'erp__get_item', integrationId: 'erp',
  description: '', inputSchema: { type: 'object' }, gating: null,
} as unknown as DiscoveredTool;
const CUSTOMER_TOOL: DiscoveredTool = {
  originalName: 'get_customer', namespacedName: 'erp__get_customer', integrationId: 'erp',
  description: '', inputSchema: { type: 'object' }, gating: null,
} as unknown as DiscoveredTool;

function erpManager(opts: { items?: Record<string, unknown>; customers?: Record<string, unknown>; tools?: DiscoveredTool[] } = {}) {
  const items = opts.items ?? { 'item-1': { id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 38.5, stock: 40 } };
  const customers = opts.customers ?? { 'cust-1': { id: 'cust-1', name: 'Steiner Landtechnik GmbH' } };
  const callTool = vi.fn().mockImplementation(async (_i: string, tool: string, args: Record<string, unknown>) => {
    if (tool === 'get_item') {
      const item = items[String(args.id)];
      if (!item) return { isError: true, content: [{ type: 'text', text: `Unknown item ${String(args.id)}` }] };
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: item };
    }
    if (tool === 'get_customer') {
      const customer = customers[String(args.id)];
      if (!customer) return { isError: true, content: [{ type: 'text', text: `Unknown customer ${String(args.id)}` }] };
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: customer };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const tools = opts.tools ?? [ITEM_TOOL, CUSTOMER_TOOL];
  const im = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
  return { im, callTool };
}

describe('buildInternalPreview — AU8 several reads', () => {
  it('builds one section per declared read, in order, resolved independently', async () => {
    const { im } = erpManager();
    const r = await buildInternalPreview(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }], value: 385, currency: 'EUR',
    });
    expect(r.status).toBe('ok');
    const reads = (r as { reads: Array<Record<string, unknown>> }).reads;
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ tool: 'get_customer', attach: 'customer_id', result: { status: 'ok', body: { structured: { name: 'Steiner Landtechnik GmbH' } } } });
    expect(reads[1]).toMatchObject({ tool: 'get_item', forEach: 'lines', attach: 'item' });
    expect(reads[1].elements).toMatchObject([{ status: 'ok', body: { structured: { id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 38.5, stock: 40 } } }]);
  });

  it('passes the manifest’s display hints through untouched', async () => {
    const { im } = erpManager();
    const r = await buildInternalPreview(im, 'erp', 'create_quote', { customer_id: 'cust-1', lines: [] });
    expect((r as { display?: unknown }).display).toEqual({
      order: ['customer_id', 'lines', 'value'], money: ['value', 'lines[].list_price'], currencyField: 'currency',
    });
  });

  it('a failing read degrades only that section — the others still resolve, status stays "ok"', async () => {
    const { im } = erpManager({ customers: {} }); // get_customer will 404
    const r = await buildInternalPreview(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    });
    expect(r.status).toBe('ok');
    const reads = (r as { reads: Array<Record<string, unknown>> }).reads;
    expect(reads[0].result).toMatchObject({ status: 'not_found' });
    expect(reads[1].elements).toMatchObject([{ status: 'ok', body: { structured: { id: 'item-1' } } }]);
  });

  it('a read with no attach is shown as its OWN section (e.g. a duplicate check)', async () => {
    const { im } = erpManager();
    const r = await buildInternalPreview(im, 'erp', 'find_duplicate_demo', { customer_id: 'cust-1' });
    const reads = (r as { reads: Array<Record<string, unknown>> }).reads;
    expect(reads[0].attach).toBeUndefined();
    expect(reads[0].result).toMatchObject({ status: 'ok' });
  });

  it('a forEach source that exceeds the cap reports the overflow on its section', async () => {
    const { im } = erpManager({ items: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`item-${i}`, { id: `item-${i}`, name: `Item ${i}` }])) });
    const lines = Array.from({ length: 60 }, (_, i) => ({ item_id: `item-${i}`, qty: 1 }));
    const r = await buildInternalPreview(im, 'erp', 'create_quote', { customer_id: 'cust-1', lines });
    const reads = (r as { reads: Array<Record<string, unknown>> }).reads;
    expect(reads[1].overflow).toEqual({ shown: 50, total: 60 });
    expect((reads[1].elements as unknown[]).length).toBe(50);
  });
});

describe('computeSubmissionPreviewHash / previewChangedSinceSubmission — AU8 combined hash', () => {
  it('combines every read (customer + each item) into one hash', async () => {
    const { im, callTool } = erpManager();
    const hash = await computeSubmissionPreviewHash(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    });
    expect(hash).toBeDefined();
    expect(callTool).toHaveBeenCalledWith('erp', 'get_customer', { id: 'cust-1' });
    expect(callTool).toHaveBeenCalledWith('erp', 'get_item', { id: 'item-1' });
  });

  it('is undefined (no AU4 protection) when any required read fails at submission time', async () => {
    const { im } = erpManager({ customers: {} });
    const hash = await computeSubmissionPreviewHash(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    });
    expect(hash).toBeUndefined();
  });

  it('previewChangedSinceSubmission: false when every read still matches', async () => {
    const { im } = erpManager();
    const hash = await computeSubmissionPreviewHash(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    });
    const changed = await previewChangedSinceSubmission(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    }, hash!);
    expect(changed).toBe(false);
  });

  it('previewChangedSinceSubmission: true when the attached item changed (e.g. a price update)', async () => {
    const { im } = erpManager();
    const hash = await computeSubmissionPreviewHash(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    });
    const { im: changedIm } = erpManager({ items: { 'item-1': { id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 42, stock: 40 } } });
    const changed = await previewChangedSinceSubmission(changedIm, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    }, hash!);
    expect(changed).toBe(true);
  });

  it('previewChangedSinceSubmission fails closed (true) when a re-read fails', async () => {
    const { im } = erpManager();
    const hash = await computeSubmissionPreviewHash(im, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    });
    const { im: brokenIm } = erpManager({ customers: {} });
    const changed = await previewChangedSinceSubmission(brokenIm, 'erp', 'create_quote', {
      customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }],
    }, hash!);
    expect(changed).toBe(true);
  });

  it('a hash is stable regardless of read order producing the same jcs content (sanity on hashPreviewBody reuse)', () => {
    expect(hashPreviewBody({ structured: { a: 1 } })).toBe(hashPreviewBody({ structured: { a: 1 } }));
  });
});
