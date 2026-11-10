import { describe, expect, it } from 'vitest';
import type { MandateDiff } from '@hap/core/mandate-change';
import { gatewayFacts, rowValue, staysLines, tagClass, waitingWarning, type ChangeFacts } from './mandate-change-view';
import { applyChangeForEdit } from './mandate-change-edit';

const empty: MandateDiff = { rows: [], stays: [] };
const facts: ChangeFacts = { limitReached: [{ field: 'f', label: 'Per day', limit: 5, days: 3, ofDays: 7 }], today: [{ field: 'f', label: 'Per day', current: 5 }], waiting: 2 };

describe('the card\'s fixed sentences', () => {
  it('states how often the limit was reached and that today\'s count stays', () => {
    expect(gatewayFacts(facts, empty)).toEqual(['The limit of 5 was reached on 3 days of the last 7.', 'Today\'s count stays: 5 already used.']);
  });
  it('a version move says the count restarts, never that it stays', () => {
    const lines = gatewayFacts(facts, { ...empty, versionMove: { from: 'a@1', to: 'a@2' } });
    expect(lines).toContainEqual(expect.stringMatching(/restarts/));
    expect(lines.some((l) => /stays/.test(l))).toBe(false);
  });
  it('warns about waiting requests, in the singular too, and only when there are any', () => {
    expect(waitingWarning(2)).toBe('2 waiting requests under the old mandate will be closed.');
    expect(waitingWarning(1)).toBe('1 waiting request under the old mandate will be closed.');
    expect(waitingWarning(0)).toBeNull();
    expect(waitingWarning(undefined)).toBeNull();
  });
  it('unknown is said as unknown, never as none', () => {
    expect(waitingWarning(null)).toMatch(/could not check/);
  });
  it('a More tag and a Changed tag look like the more important one; Less does not', () => {
    expect(tagClass('More')).toBe('mc-more');
    expect(tagClass('Changed')).toBe('mc-more');
    expect(tagClass('New')).toBe('mc-more');
    expect(tagClass('Less')).toBe('mc-less');
  });
  it('values carry their unit', () => {
    expect(rowValue({ unit: 'currency:EUR' }, 1000)).toBe('EUR 1000');
    expect(rowValue({ unit: 'percent' }, 10)).toBe('10%');
    expect(rowValue({ unit: 'count' }, 5)).toBe('5');
    expect(rowValue({}, null)).toBe('—');
  });
  it('the unchanged rest reads in words', () => {
    expect(staysLines({ ...empty, stays: [{ label: 'Up to', value: '3' }, { label: 'mode', value: 'review' }, { label: 'lasts-until', value: '1800000000' }, { label: 'intent', value: '' }] }))
      .toEqual(['Up to: 3', 'Review Each Action', expect.stringMatching(/^Lasts until/), 'Why it\'s for']);
  });
});

describe('"Change it myself" starts from the signed mandate plus the sealed differences', () => {
  const old = { bounds: { a: 1, b: 2, profile: 'x' }, context: { c: 'one' }, intent: 'Old words.', deferredCommitmentDomains: ['d'], expiresAt: 1000 };
  it('applies only sealed rows; the rest is the signed values', () => {
    const p = applyChangeForEdit(old, {
      change: { ...empty, rows: [{ section: 'limit', field: 'a', label: 'A', before: 1, after: 9, tag: 'More' }, { section: 'scope', field: 'c', label: 'C', before: 'one', after: null, tag: 'Gone' }] },
      intent: 'New words.',
    }, 100);
    expect(p.bounds).toEqual({ a: 9, b: 2, profile: 'x' });
    expect(p.context).toEqual({});
    expect(p.gateContent.intent).toBe('New words.');
    expect(p.templateMode).toBe('review');
    expect(p.templateTtl).toBe(900);
  });
  it('the proposed end date wins; the signed intent stays when no new one is proposed', () => {
    const p = applyChangeForEdit(old, { change: { ...empty, lastsUntil: { before: 1000, after: 5000, tag: 'More' } } }, 100);
    expect(p.templateTtl).toBe(4900);
    expect(p.gateContent.intent).toBe('Old words.');
  });
});
