/**
 * AU3 manifest validation — `toolGating.overrides[<tool>].preview` is
 * rejected at LOAD time (not call time) when malformed, same pattern as the
 * npm-pin lint (manifest-npm-pin.test.ts): one predicate (`invalidPreviewReason`)
 * shared by the loader and this test, so the two can never disagree.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidPreviewReason, invalidManifestPreviewReason, loadManifests, getManifest } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

describe('invalidPreviewReason — the shared predicate', () => {
  it('null is fine (no preview to check)', () => {
    expect(invalidPreviewReason('x', null)).toBeNull();
  });

  it('an entry with no `preview` key is fine', () => {
    expect(invalidPreviewReason('x', { executionMapping: {} })).toBeNull();
  });

  it('a well-formed preview (no version) is fine', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: { id: 'id' } } })).toBeNull();
  });

  it('a well-formed preview WITH version is fine', () => {
    expect(
      invalidPreviewReason('x', {
        preview: { tool: 'get_x', args: { id: 'id', revision: 'revision' }, version: { arg: 'revision', field: 'revision' } },
      }),
    ).toBeNull();
  });

  it('rejects a non-object preview', () => {
    expect(invalidPreviewReason('x', { preview: 'oops' })).toMatch(/must be an object/);
    expect(invalidPreviewReason('x', { preview: ['oops'] })).toMatch(/must be an object/);
  });

  it('rejects a missing or empty `tool`', () => {
    expect(invalidPreviewReason('x', { preview: { args: {} } })).toMatch(/preview\.tool/);
    expect(invalidPreviewReason('x', { preview: { tool: '', args: {} } })).toMatch(/preview\.tool/);
  });

  it('rejects a missing or malformed `args`', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x' } })).toMatch(/preview\.args/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: 'nope' } })).toMatch(/preview\.args/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: [] } })).toMatch(/preview\.args/);
  });

  it('rejects an `args` entry whose source is not a non-empty string', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: { id: 5 } } })).toMatch(/preview\.args\.id/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: { id: '' } } })).toMatch(/preview\.args\.id/);
  });

  it('rejects a malformed `version`', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, version: 'nope' } })).toMatch(/preview\.version/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, version: { arg: 'revision' } } })).toMatch(/preview\.version\.field/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, version: { field: 'revision' } } })).toMatch(/preview\.version\.arg/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, version: { arg: '', field: 'revision' } } })).toMatch(/preview\.version\.arg/);
  });

  it('a well-formed `fields` allow-list is fine', () => {
    expect(
      invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, fields: ['number', 'lines', 'net_total'] } }),
    ).toBeNull();
  });

  it('an empty `fields` array is fine (falls back to the no-declaration behaviour)', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, fields: [] } })).toBeNull();
  });

  it('rejects a non-array `fields`', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, fields: 'number' } })).toMatch(/preview\.fields/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, fields: { 0: 'number' } } })).toMatch(/preview\.fields/);
  });

  it('rejects a `fields` entry that is not a non-empty string', () => {
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, fields: ['number', 5] } })).toMatch(/preview\.fields\[1\]/);
    expect(invalidPreviewReason('x', { preview: { tool: 'get_x', args: {}, fields: [''] } })).toMatch(/preview\.fields\[0\]/);
  });
});

describe('invalidManifestPreviewReason', () => {
  it('null for a manifest whose overrides are all clean', () => {
    expect(
      invalidManifestPreviewReason({
        toolGating: { default: { executionMapping: {} }, overrides: { a: { preview: { tool: 'b', args: {} } } } },
      }),
    ).toBeNull();
  });

  it('surfaces the first bad override found', () => {
    expect(
      invalidManifestPreviewReason({
        toolGating: { default: { executionMapping: {} }, overrides: { a: { preview: { args: {} } } } },
      }),
    ).toMatch(/"a"\.preview\.tool/);
  });
});

describe('loadManifests refuses a manifest whose preview shape is invalid', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('a malformed preview refuses the WHOLE manifest, not just that tool', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-bad-preview-manifest-'));
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { bad: 'bad/manifest.json' } }));
    writeFileSync(
      join(dir, 'bad/manifest.json'),
      JSON.stringify({
        id: 'bad',
        name: 'Bad',
        version: '1',
        profile: 'sales',
        mcp: { command: 'node', args: [] },
        credentials: { fields: [], envMapping: {} },
        oauth: null,
        toolGating: {
          default: { executionMapping: {} },
          overrides: { send_quote: { executionMapping: {}, preview: { args: {} } } }, // missing `tool`
        },
      }),
    );

    const loaded = loadManifests(dir);

    expect(loaded).toBe(0);
    expect(getManifest('bad')).toBeUndefined();
  });

  it('a well-formed preview loads normally', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-good-preview-manifest-'));
    mkdirSync(join(dir, 'good'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { good: 'good/manifest.json' } }));
    writeFileSync(
      join(dir, 'good/manifest.json'),
      JSON.stringify({
        id: 'good',
        name: 'Good',
        version: '1',
        profile: 'sales',
        mcp: { command: 'node', args: [] },
        credentials: { fields: [], envMapping: {} },
        oauth: null,
        toolGating: {
          default: { executionMapping: {} },
          overrides: {
            send_quote: {
              executionMapping: {},
              preview: { tool: 'get_quote', args: { id: 'id' }, version: { arg: 'revision', field: 'revision' } },
            },
          },
        },
      }),
    );

    const loaded = loadManifests(dir);

    expect(loaded).toBe(1);
    expect(getManifest('good')).toBeDefined();
  });
});

// ─── Lint over the REAL shipped manifests (ERP3) ───────────────────────────

describe('real manifests — preview declarations are well-formed', () => {
  const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');

  it('finds manifests to lint (guards against a broken path)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every declared preview is well-formed`, () => {
      const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, file), 'utf8'));
      expect(invalidManifestPreviewReason(manifest)).toBeNull();
    });
  }

  it('erp.json declares the ERP3 preview for send_quote and convert_quote_to_order, with the fields that matter shown first', () => {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8'));
    const overrides = manifest.toolGating.overrides;
    for (const tool of ['send_quote', 'convert_quote_to_order']) {
      expect(overrides[tool].preview).toEqual({
        tool: 'get_quote',
        args: { id: 'id', revision: 'revision' },
        version: { arg: 'revision', field: 'revision' },
        fields: ['number', 'revision', 'status', 'customer_id', 'lines', 'net_total', 'discount_pct', 'valid_until'],
      });
    }
  });
});
