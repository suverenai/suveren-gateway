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

  // The approved title rule (Andreas, 2026-11-11): something new is "New …",
  // a change is "Change …", removing is "Archive …" / "Delete …"; a few
  // action verbs and document nouns that already read right stay. Never
  // "Create …" / "Update …", and never an id next to a record's name.
  const APPROVED_START = /^(New|Change|Archive|Delete|Restore|Convert|Complete|Log|Send|Save|Release|Revoke|Email to|Quote|Order of|Invoice|Credit note|Payment link|Payment of|Capture of|LinkedIn (post|image post|article):)(?=[ [])/;
  it('every summary starts with an approved verb or noun pattern', () => {
    const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
    const offenders: string[] = [];
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf8'));
      for (const [tool, o] of Object.entries(m.toolGating?.overrides ?? {}) as Array<[string, { summary?: string } | null]>) {
        const s = o?.summary;
        if (!s) continue;
        // A leading optional part ("[…]") or placeholder is not a verb.
        const ok = APPROVED_START.test(s) && !/\b(Create|Update)\b/.test(s) && !/\(\{[^}]*\|ref\}\)/.test(s);
        if (!ok) offenders.push(`${f} ${tool}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
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
