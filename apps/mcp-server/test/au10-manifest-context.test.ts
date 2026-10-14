/**
 * AU10 manifest validation — `context` (sources/history/recordKeys) and the
 * per-tool `contextKeys`/`sourceFromArg` overrides are rejected at LOAD time
 * when malformed (same pattern as AU3's manifest-preview-shape.test.ts):
 * one predicate (`invalidManifestContextReason`) shared by the loader and
 * this test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidManifestContextReason, loadManifests, getManifest } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

function baseManifest(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'x', name: 'X', version: '1', profile: 'customers',
    mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
    toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: {} },
    ...extra,
  };
}

describe('invalidManifestContextReason — context.sources', () => {
  it('absent context is fine', () => {
    expect(invalidManifestContextReason(baseManifest({}))).toBeNull();
  });

  it('a well-formed source is fine', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { sources: { message: { read: { tool: 'get_message', args: { id: '$id' } }, title: 'subject' } } },
    }))).toBeNull();
  });

  it('rejects a non-object sources map', () => {
    expect(invalidManifestContextReason(baseManifest({ context: { sources: 'nope' } }))).toMatch(/context\.sources/);
  });

  it('rejects a source missing its read.tool', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { sources: { message: { read: { args: { id: '$id' } } } } },
    }))).toMatch(/read\.tool/);
  });

  it('rejects a source read.args that is not an object', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { sources: { message: { read: { tool: 'get_message', args: 'nope' } } } },
    }))).toMatch(/read\.args/);
  });

  it('rejects an unrecognized keys entry (only "email" is a key type)', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { sources: { message: { read: { tool: 'get_message', args: {} }, keys: { phone: 'from.phone' } } } },
    }))).toMatch(/only "email" is a recognized identity key type/);
  });

  it('rejects a malformed chain', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { sources: { message: { read: { tool: 'get_message', args: {} }, chain: { field: 'in_reply_to', max: 0 } } } },
    }))).toMatch(/chain\.max/);
  });
});

describe('invalidManifestContextReason — context.history', () => {
  const okHistory = {
    byKey: 'email_domain',
    read: { tool: 'get_timeline', args: { email_domain: '$key', since: '$since', limit: '$limit' } },
    limit: 5, maxAgeDays: 14,
    item: { title: 'summary', at: 'date' },
  };

  it('a well-formed history is fine', () => {
    expect(invalidManifestContextReason(baseManifest({ context: { history: okHistory } }))).toBeNull();
  });

  it('rejects an unrecognized byKey', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { history: { ...okHistory, byKey: 'phone' } },
    }))).toMatch(/byKey/);
  });

  it('rejects a non-positive limit', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { history: { ...okHistory, limit: 0 } },
    }))).toMatch(/limit/);
  });

  it('rejects a non-positive maxAgeDays', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { history: { ...okHistory, maxAgeDays: -1 } },
    }))).toMatch(/maxAgeDays/);
  });

  it('rejects a non-object item mapping', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { history: { ...okHistory, item: 'nope' } },
    }))).toMatch(/item/);
  });
});

describe('invalidManifestContextReason — context.recordKeys', () => {
  it('a well-formed recordKeys entry is fine', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { recordKeys: { customer: { read: { tool: 'get_customer', args: { id: '$id' } }, keys: { email: 'email' } } } },
    }))).toBeNull();
  });

  it('rejects a missing keys object', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { recordKeys: { customer: { read: { tool: 'get_customer', args: {} } } } },
    }))).toMatch(/recordKeys\.customer\.keys/);
  });
});

describe('invalidManifestContextReason — per-tool contextKeys/sourceFromArg', () => {
  it('contextKeys naming "email" (a direct key type) is fine with no recordKeys at all', () => {
    expect(invalidManifestContextReason(baseManifest({
      toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { create_contact: { contextKeys: { email: 'email' } } } },
    }))).toBeNull();
  });

  it('contextKeys naming a declared recordKeys entry is fine', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { recordKeys: { customer: { read: { tool: 'get_customer', args: {} }, keys: { email: 'email' } } } },
      toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { create_quote: { contextKeys: { customer: 'customer_id' } } } },
    }))).toBeNull();
  });

  it('rejects contextKeys naming neither "email" nor a declared recordKeys entry', () => {
    expect(invalidManifestContextReason(baseManifest({
      toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { create_quote: { contextKeys: { customer: 'customer_id' } } } },
    }))).toMatch(/neither "email" nor a context\.recordKeys entry/);
  });

  it('sourceFromArg naming a declared source kind is fine', () => {
    expect(invalidManifestContextReason(baseManifest({
      context: { sources: { message: { read: { tool: 'get_message', args: {} } } } },
      toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { send_message: { sourceFromArg: { kind: 'message', arg: 'in_reply_to' } } } },
    }))).toBeNull();
  });

  it('rejects sourceFromArg naming an undeclared source kind', () => {
    expect(invalidManifestContextReason(baseManifest({
      toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { send_message: { sourceFromArg: { kind: 'message', arg: 'in_reply_to' } } } },
    }))).toMatch(/not declared in this manifest's context\.sources/);
  });

  it('rejects a malformed sourceFromArg', () => {
    expect(invalidManifestContextReason(baseManifest({
      toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { send_message: { sourceFromArg: { kind: 'message' } } } },
    }))).toMatch(/sourceFromArg\.arg/);
  });
});

describe('loader integration — a manifest with a malformed context is refused, not partially loaded', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('refuses the whole manifest on an invalid context', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-au10-bad-context-'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { bad: 'bad.json' } }));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(baseManifest({
      id: 'bad', context: { history: { byKey: 'phone' } },
    })));
    loadManifests(dir);
    expect(getManifest('bad')).toBeUndefined();
  });
});

describe('every bundled manifest (content/integrations) has a valid context block', () => {
  it('passes invalidManifestContextReason for every checked-in manifest', () => {
    const index = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'index.json'), 'utf8')) as { integrations: Record<string, string> };
    for (const [id, relPath] of Object.entries(index.integrations)) {
      const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, relPath), 'utf8'));
      expect(invalidManifestContextReason(manifest), `manifest "${id}"`).toBeNull();
    }
  });
});
