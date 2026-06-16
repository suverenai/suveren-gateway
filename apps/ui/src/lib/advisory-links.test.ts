import { describe, it, expect } from 'vitest';
import { resolveAdvisoryLinks, type AdvisoryGrant } from './advisory-links';

// NOTE: only the deterministic link resolution is tested here. The LLM call
// that produces the advisory text (getIntentReview) is non-deterministic and
// is NOT mocked by design — there is no fake-model test.

const G = (scope: string, intent = ''): AdvisoryGrant => ({ scope, intent, bounds: {} });

// Two grants share andreas.schadauer@gmail.com — the collision that broke the
// scope link (it used to resolve to the first one only).
const grants: AdvisoryGrant[] = [
  G('andreas.schadauer@gmail.com', 'read inbox'),     // [1]
  G('andreas@sublin.app'),                            // [2]
  G('andi@dsafssd.at'),                               // [3]
  G('andreas.schadauer@gmail.com', 'compose & send'), // [4] — same scope as [1]
];

const firstLink = (input: string, gs = grants, profile = 'Email') =>
  resolveAdvisoryLinks(input, gs, profile).find(s => s.matched);

describe('resolveAdvisoryLinks', () => {
  it('[N] resolves to the EXACT grant N, not by scope', () => {
    expect(firstLink('redundant with [4].')?.matched).toEqual([grants[3]]);
  });

  it('[N] renders a readable label, not the bracket number', () => {
    const link = firstLink('see [4]');
    expect(link?.label).toBe('Email: andreas.schadauer@gmail.com');
    expect(link?.label).not.toContain('[4]');
  });

  it('out-of-range [N] is not linked', () => {
    expect(resolveAdvisoryLinks('see [9]', grants, 'Email').some(s => s.matched)).toBe(false);
  });

  it('a scope shared by two grants resolves to BOTH (not the first)', () => {
    const link = firstLink('overlaps andreas.schadauer@gmail.com here');
    expect(link?.matched).toEqual([grants[0], grants[3]]);
  });

  it('a distinct scope resolves to its single grant', () => {
    expect(firstLink('see andi@dsafssd.at')?.matched).toEqual([grants[2]]);
  });

  it('scope match is case-insensitive', () => {
    expect(firstLink('ANDI@DSAFSSD.AT')?.matched).toEqual([grants[2]]);
  });

  it('unrecognized text stays plain (no links)', () => {
    const segs = resolveAdvisoryLinks('No intent conflicts found.', grants, 'Email');
    expect(segs.every(s => !s.matched)).toBe(true);
    expect(segs.map(s => s.text).join('')).toBe('No intent conflicts found.');
  });

  it('preserves the full original text across segments', () => {
    const input = 'redundant with [4] (scoped to andreas.schadauer@gmail.com).';
    const segs = resolveAdvisoryLinks(input, grants, 'Email');
    expect(segs.map(s => s.text).join('')).toBe(input);
  });

  it('no grants → a single plain segment', () => {
    expect(resolveAdvisoryLinks('anything [1]', [], 'Email')).toEqual([
      { text: 'anything [1]', label: 'anything [1]', matched: null },
    ]);
  });

  it('an unscoped grant cited by [N] labels as "all recipients"', () => {
    const g = [G('all (unscoped)', 'broad')];
    const link = firstLink('see [1]', g);
    expect(link?.label).toBe('Email: all recipients');
    expect(link?.matched).toEqual([g[0]]);
  });
});
