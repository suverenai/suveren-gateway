/**
 * Andreas 2026-11-11: checks are for findings, not for the action itself. A tool
 * whose preview reads the record it changes (a read with `version`) shows each
 * changed field as Now → New on the card; a notice check that only compares a
 * bound argument with the same field of that record repeats the change above
 * the card ("List price: 120.00 EUR → 130.00 EUR"). No shipped manifest may
 * declare one. Checks against OTHER data (an item master on a quote line, the
 * tax treatment a change causes) say something new and stay.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

type Read = { attach?: string; forEach?: string; version?: unknown };
type Check = { key: string; path?: string; blocking?: boolean; compare?: { to?: unknown } };

/** Every (manifest, tool, check key) that only repeats a change the card shows. */
function repeatingChecks(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')) {
    const m = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    for (const [tool, o] of Object.entries((m.toolGating?.overrides ?? {}) as Record<string, { preview?: Read | Read[]; checks?: Check[] } | null>)) {
      const reads = o?.preview ? (Array.isArray(o.preview) ? o.preview : [o.preview]) : [];
      // A single read with a version has no attach: its fields are the record's own.
      const prefixes = reads.filter((r) => r.version && !r.forEach).map((r) => (r.attach ? `${r.attach}.` : ''));
      if (prefixes.length === 0) continue;
      for (const c of o?.checks ?? []) {
        if (c.blocking || !c.path || c.path.includes('.') || typeof c.compare?.to !== 'string') continue;
        if (prefixes.some((p) => c.compare!.to === `${p}${c.path}`)) out.push(`${file} ${tool} ${c.key}`);
      }
    }
  }
  return out;
}

describe('manifests: no check repeats a change the card already shows as Now → New', () => {
  it('none in the shipped manifests', () => {
    expect(repeatingChecks()).toEqual([]);
  });
});
