/**
 * UI spec §6.1 / §12.2 — `toolGating.overrides[<tool>].summary`, the template
 * for the approval's one-sentence summary, is checked at LOAD time: a
 * malformed template refuses the manifest (same predicate the loader uses).
 * And every bundled manifest's templates pass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidSummaryReason, invalidManifestPreviewReason, loadManifests, getManifest } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

describe('invalidSummaryReason', () => {
  it('no summary, or a well-formed one, is fine', () => {
    expect(invalidSummaryReason('x', null)).toBeNull();
    expect(invalidSummaryReason('x', { actionLabel: 'X' })).toBeNull();
    expect(invalidSummaryReason('x', { summary: 'Quote of {value|money} net[ — {discount_pct|percent} discount]' })).toBeNull();
    expect(invalidSummaryReason('x', { summary: 'Update contact {name,id}' })).toBeNull();
    expect(invalidSummaryReason('x', { summary: 'Event[ on {start.dateTime,start.date|date}]' })).toBeNull();
  });

  it('rejects empty, unbalanced, nested, unknown formats and bad paths', () => {
    expect(invalidSummaryReason('x', { summary: '' })).toMatch(/non-empty/);
    expect(invalidSummaryReason('x', { summary: 42 })).toMatch(/non-empty/);
    expect(invalidSummaryReason('x', { summary: 'Hi {name' })).toMatch(/unbalanced/);
    expect(invalidSummaryReason('x', { summary: 'Hi [a [b]]' })).toMatch(/unbalanced or nested \[/);
    expect(invalidSummaryReason('x', { summary: '{a|bold}' })).toMatch(/unknown format/);
    expect(invalidSummaryReason('x', { summary: '{a|money|percent}' })).toMatch(/more than one format/);
    expect(invalidSummaryReason('x', { summary: '{a b}' })).toMatch(/invalid field path/);
    expect(invalidSummaryReason('x', { summary: 'x'.repeat(201) })).toMatch(/at most 200/);
  });
});

describe('bundled manifests', () => {
  it('every summary template in content/integrations passes', () => {
    const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
    let templates = 0;
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf8'));
      expect(invalidManifestPreviewReason(m), f).toBeNull();
      for (const o of Object.values(m.toolGating?.overrides ?? {}) as Array<{ summary?: string } | null>) {
        if (o?.summary) templates += 1;
      }
    }
    expect(templates).toBeGreaterThan(30);
  });
});

describe('loader', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('refuses a manifest whose summary is malformed', () => {
    dir = mkdtempSync(join(tmpdir(), 'summary-manifest-'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { badsum: 'badsum.json' } }));
    writeFileSync(join(dir, 'badsum.json'), JSON.stringify({
      id: 'badsum', name: 'Bad', npmPackage: '@x/y', npmVersion: '1.0.0',
      toolGating: { overrides: { do_it: { summary: 'Do {it' } } },
    }));
    loadManifests(dir);
    expect(getManifest('badsum')).toBeUndefined();
  });
});
