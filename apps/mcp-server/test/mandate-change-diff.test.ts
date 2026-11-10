/**
 * The differences a person sees on a change card, computed from the signed mandate.
 * Direction is the safety part: a tricked AI asking for more must show as More, and
 * only what the profile can actually order may claim a direction at all.
 */
import { describe, it, expect } from 'vitest';
import { computeMandateDiff, diffIsEmpty, wordDiff, carryValues, type ChangeProfile } from '@hap/core/mandate-change';

const profile: ChangeProfile = {
  id: 'p/area@1',
  boundsSchema: {
    keyOrder: ['profile', 'daily_max', 'amount_max', 'access'],
    fields: {
      profile: {},
      daily_max: { displayName: 'Per day', unit: 'count', boundType: { kind: 'cumulative_count' } },
      amount_max: { displayName: 'Largest amount', unit: 'currency:EUR', boundType: { kind: 'per_transaction' } },
      access: { displayName: 'Access', boundType: { kind: 'enum' } },
    },
  },
  scopeSchema: {
    keyOrder: ['recipients', 'currency'],
    fields: {
      recipients: { displayName: 'May write to', constraint: { enforceable: ['subset'] } },
      currency: { displayName: 'Currency', constraint: { enforceable: ['enum'] } },
    },
  },
};
const side = (b: Record<string, string | number>, s: Record<string, string | number>, over: Partial<{ intent: string; mode: string; expiresAt: number; profile: ChangeProfile }> = {}) => ({
  profile, bounds: { profile: 'p/area@1', ...b }, scope: s, intent: 'Why.', mode: 'review', expiresAt: 1000, ...over,
});

describe('direction of a change', () => {
  it('a higher number is More, a lower one Less', () => {
    const d = computeMandateDiff({ before: side({ daily_max: 5, amount_max: 100 }, {}), after: side({ daily_max: 15, amount_max: 50 }, {}) });
    expect(d.rows.map((r) => [r.field, r.tag])).toEqual([['daily_max', 'More'], ['amount_max', 'Less']]);
  });
  it('a value a profile declares no order for claims no direction', () => {
    const d = computeMandateDiff({ before: side({ access: 'none' }, { currency: 'EUR' }), after: side({ access: 'unlimited' }, { currency: 'USD' }) });
    expect(d.rows.map((r) => r.tag)).toEqual(['Changed', 'Changed']);
  });
  it('a list shows only what is added and removed; an addition makes it More', () => {
    const d = computeMandateDiff({ before: side({}, { recipients: 'a@x,b@x' }), after: side({}, { recipients: 'b@x,c@x' }) });
    expect(d.rows[0]).toMatchObject({ tag: 'More', added: ['c@x'], removed: ['a@x'] });
  });
  it('removing only is Less', () => {
    const d = computeMandateDiff({ before: side({}, { recipients: 'a@x,b@x' }), after: side({}, { recipients: 'a@x' }) });
    expect(d.rows[0]).toMatchObject({ tag: 'Less', added: [], removed: ['b@x'] });
  });
  it('an empty scope field means anything, so emptying it is More and setting it is Less', () => {
    expect(computeMandateDiff({ before: side({}, { recipients: 'a@x' }), after: side({}, {}) }).rows[0].tag).toBe('More');
    expect(computeMandateDiff({ before: side({}, {}), after: side({}, { recipients: 'a@x' }) }).rows[0].tag).toBe('Less');
  });
  it('mode: running on its own is More, asking first is Less', () => {
    expect(computeMandateDiff({ before: side({}, {}), after: side({}, {}, { mode: 'automatic' }) }).mode?.tag).toBe('More');
    expect(computeMandateDiff({ before: side({}, {}, { mode: 'automatic' }), after: side({}, {}) }).mode?.tag).toBe('Less');
  });
  it('a later end date is More, an earlier one Less', () => {
    expect(computeMandateDiff({ before: side({}, {}), after: side({}, {}, { expiresAt: 2000 }) }).lastsUntil?.tag).toBe('More');
    expect(computeMandateDiff({ before: side({}, {}), after: side({}, {}, { expiresAt: 500 }) }).lastsUntil?.tag).toBe('Less');
  });
  it('a field the newer version adds is New; one it drops is Gone', () => {
    const newer: ChangeProfile = { ...profile, id: 'p/area@2', boundsSchema: { keyOrder: ['extra'], fields: { extra: { displayName: 'Extra', unit: 'count' } } }, scopeSchema: { keyOrder: [], fields: {} } };
    const d = computeMandateDiff({ before: side({ daily_max: 5 }, {}), after: { profile: newer, bounds: { extra: 3 }, scope: {}, intent: 'Why.', mode: 'review', expiresAt: 1000 } });
    expect(d.rows.map((r) => [r.field, r.tag])).toEqual([['extra', 'New'], ['daily_max', 'Gone']]);
    expect(d.versionMove).toEqual({ from: 'p/area@1', to: 'p/area@2' });
  });
});

describe('nothing changes, nothing to sign', () => {
  it('same values are not a change, and carry to Stays the same', () => {
    const d = computeMandateDiff({ before: side({ daily_max: 5 }, {}), after: side({ daily_max: 5 }, {}) });
    expect(diffIsEmpty(d)).toBe(true);
    expect(d.stays).toContainEqual({ label: 'Per day', value: '5' });
  });
  it('a version move alone is not a change', () => {
    const newer = { ...profile, id: 'p/area@2' };
    expect(diffIsEmpty(computeMandateDiff({ before: side({}, {}), after: side({}, {}, { profile: newer }) }))).toBe(true);
  });
});

describe('the intent as a word diff', () => {
  it('the two texts are reproduced exactly, and only changed words are marked', () => {
    const before = 'Answer questions about open quotes from existing customers. Show me each reply first.';
    const after = 'Answer questions about open quotes and new enquiries. Show me each reply first.';
    const parts = wordDiff(before, after);
    expect(parts.filter((p) => p.kind !== 'add').map((p) => p.text).join('')).toBe(before);
    expect(parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe(after);
    expect(parts.filter((p) => p.kind === 'add').map((p) => p.text).join('').replace(/\s+/g, ' ').trim()).toBe('and new enquiries.');
    expect(parts.filter((p) => p.kind === 'del').map((p) => p.text).join('').replace(/\s+/g, ' ').trim()).toBe('from existing customers.');
  });
  it('identical text is one unchanged part', () => {
    expect(wordDiff('a b', 'a b')).toEqual([{ kind: 'same', text: 'a b' }]);
  });
});

describe('carrying values to a newer version', () => {
  it('a field the version dropped is left out and a new one is NOT defaulted', () => {
    expect(carryValues({ a: 1, gone: 2 }, { keyOrder: ['a', 'added'], fields: { a: {}, added: {} } })).toEqual({ a: 1 });
  });
});
