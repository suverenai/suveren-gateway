import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { refusalSentence, sharedLimitLabel, sharedLimitHelper, cumulativeBound, limitWordsForTool, limitWordsForProfile } from './limit-words';

// Words come from a manifest, keyed by bound key (never from the profile).
const WORDS = { box_daily_max: { noun: 'emails', pastParticiple: 'sent' }, bills_monthly_max: { noun: 'bills', pastParticiple: 'issued' } };

const profile = (fields: Record<string, unknown>) => ({ boundsSchema: { keyOrder: [], fields } }) as unknown as AgentProfile;

// Three profiles, all invented for the test: none of the code under test knows their names.
const WITH_WORDS = profile({
  box_daily_max: { displayName: 'Daily box limit', unit: 'count', appliesTo: ['send'], boundType: { kind: 'cumulative_count', window: 'daily' } },
  per_box_max: { displayName: 'Per box', unit: 'count', boundType: { kind: 'per_transaction', of: 'n' } },
});
const NO_WORDS = profile({
  thing_weekly_max: { displayName: 'Things per week', unit: 'count', appliesTo: ['make'], boundType: { kind: 'cumulative_count', window: 'weekly' } },
});
const MONEY = profile({
  total_monthly_max: { displayName: 'Billed per month', unit: 'currency:EUR', appliesTo: ['bill'], boundType: { kind: 'cumulative_sum', of: 'net', window: 'monthly' } },
  bills_monthly_max: { displayName: 'Bills per month', unit: 'count', appliesTo: ['bill'], boundType: { kind: 'cumulative_count', window: 'monthly' } },
  net_max: { displayName: 'Max net', unit: 'currency:EUR', boundType: { kind: 'per_transaction', of: 'net' } },
});

describe('refusalSentence (wording A)', () => {
  it('a dead mandate says so in plain words, never the code', () => {
    expect(refusalSentence({ code: 'MANDATE_REVOKED', message: 'The parent mandate has been revoked' }, NO_WORDS).text).toBe('Not done. This mandate was revoked.');
    expect(refusalSentence({ code: 'MANDATE_EXPIRED', message: 'The parent mandate has expired' }, NO_WORDS).text).toBe('Not done. This mandate has expired.');
  });
  it('uses the profile\'s noun and verb for a counted daily limit', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'x', field: 'box_daily_max', expected: 5, actual: 6 }, WITH_WORDS, WORDS);
    expect(r).toEqual({ text: 'Not sent. The daily limit is used up: 5 of 5 emails today.', basis: 'data' });
  });
  it('is still true without a noun or verb in the profile', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'x', field: 'thing_weekly_max', expected: 3, actual: 4 }, NO_WORDS);
    expect(r.text).toBe('Not done. The weekly limit is used up: 3 of 3 this week.');
  });
  it('takes another area\'s noun, verb and window from that profile', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'x', field: 'bills_monthly_max', expected: 10, actual: 11 }, MONEY, WORDS);
    expect(r.text).toBe('Not issued. The monthly limit is used up: 10 of 10 bills this month.');
  });
  it('says what would have been reached for a summed limit', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'x', field: 'total_monthly_max', expected: 5000, actual: 5400 }, MONEY);
    expect(r.text).toBe('Not done. The monthly limit would be exceeded: 5,400 EUR of 5,000 EUR this month.');
  });
  it('names a per-call limit from its display name and unit', () => {
    const r = refusalSentence({ code: 'BOUND_EXCEEDED', message: 'x', field: 'net_max', expected: 1000, actual: 1200 }, MONEY);
    expect(r.text).toBe('Not done. Max net: 1,200 EUR is above the limit of 1,000 EUR.');
    expect(r.basis).toBe('data');
  });
  it('falls back to the code alone when the server sent no numbers (missing data)', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (6) exceeds box_daily_max=5' }, WITH_WORDS);
    expect(r).toEqual({ text: 'Not done. A shared limit is used up.', basis: 'code' });
  });
  it('falls back to the code alone when the field is not in the profile', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'm', field: 'gone', expected: 5, actual: 6 }, WITH_WORDS);
    expect(r.basis).toBe('code');
  });
  it('falls back to the code alone when the profile is not loaded', () => {
    expect(refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'm', field: 'box_daily_max', expected: 5, actual: 6 }, null).basis).toBe('code');
  });
  it('shows an unknown refusal\'s message whole, never parsed', () => {
    const r = refusalSentence({ code: 'APPROVAL_REQUIRED', message: 'Needs a second approver.' }, WITH_WORDS);
    expect(r).toEqual({ text: 'Not done. Needs a second approver.', basis: 'message' });
  });
  it('does not read the numbers out of the message text', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (6) exceeds box_daily_max=5' }, WITH_WORDS);
    expect(r.text).not.toMatch(/\d/);
  });
});

describe('refusalSentence with the facts the server recorded', () => {
  const P = profile({ write_daily_max: { displayName: 'Writes per day', unit: 'count', appliesTo: ['write'], boundType: { kind: 'cumulative_count', window: 'daily' } } });
  it('reads the example refusal as "2 of 2"', () => {
    const r = refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'm', field: 'write_daily_max', expected: 2, actual: 3 }, P, { write_daily_max: { noun: 'writes', pastParticiple: 'done' } });
    expect(r.text).toBe('Not done. The daily limit is used up: 2 of 2 writes today.');
  });
  it('a row written before the facts existed keeps the fallback', () => {
    expect(refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (3) exceeds write_daily_max=2' }, P).text).toBe('Not done. A shared limit is used up.');
  });
});

describe('sharedLimitLabel (wording B)', () => {
  it('reads "Team limit per day (3 of 5 used)" in a team', () => {
    const l = sharedLimitLabel({ profile: WITH_WORDS, key: 'box_daily_max', team: true, used: 3, usedIsTeamWide: true, limit: 5 })!;
    expect(l.text).toBe('Team limit per day (3 of 5 used)');
    expect(l.name).toBe('Team limit per day');
    expect(l.figures).toBe('3 of 5 used');
  });
  it('drops "Team" in a personal workspace', () => {
    expect(sharedLimitLabel({ profile: WITH_WORDS, key: 'box_daily_max', team: false, used: 0, limit: 5 })!.text).toBe('Limit per day (0 of 5 used)');
  });
  it('follows the window of the bound', () => {
    expect(sharedLimitLabel({ profile: NO_WORDS, key: 'thing_weekly_max', team: true })!.name).toBe('Team limit per week');
  });
  it('in a team, never shows a count that is only this account\'s own', () => {
    const l = sharedLimitLabel({ profile: WITH_WORDS, key: 'box_daily_max', team: true, used: 3, limit: 5 })!;
    expect(l.figures).toBeUndefined();
    expect(l.text).toBe('Team limit per day');
  });
  it('in a personal workspace the account\'s own count is the whole count', () => {
    expect(sharedLimitLabel({ profile: WITH_WORDS, key: 'box_daily_max', team: false, used: 3, limit: 5 })!.text).toBe('Limit per day (3 of 5 used)');
  });
  it('leaves the brackets out when the figures cannot be proven', () => {
    const l = sharedLimitLabel({ profile: WITH_WORDS, key: 'box_daily_max', team: true, limit: 5 })!;
    expect(l.text).toBe('Team limit per day');
    expect(l.figures).toBeUndefined();
  });
  it('leaves the brackets out while the form value is empty', () => {
    expect(sharedLimitLabel({ profile: WITH_WORDS, key: 'box_daily_max', team: true, used: 3, usedIsTeamWide: true, limit: '' })!.figures).toBeUndefined();
  });
  it('shows money with its unit, and keeps the field name when two limits share a window', () => {
    const l = sharedLimitLabel({ profile: MONEY, key: 'total_monthly_max', team: true, used: 1200, usedIsTeamWide: true, limit: 5000 })!;
    expect(l.text).toBe('Team limit per month · Billed per month (1,200 EUR of 5,000 EUR used)');
  });
  it('does not add the field name when the other limit governs a different action', () => {
    const p = profile({
      a_daily: { displayName: 'A', unit: 'count', appliesTo: ['send'], boundType: { kind: 'cumulative_count', window: 'daily' } },
      b_daily: { displayName: 'B', unit: 'count', appliesTo: ['setup'], boundType: { kind: 'cumulative_count', window: 'daily' } },
    });
    expect(sharedLimitLabel({ profile: p, key: 'a_daily', team: true })!.name).toBe('Team limit per day');
  });
  it('is null for a bound that is not cumulative', () => {
    expect(sharedLimitLabel({ profile: WITH_WORDS, key: 'per_box_max', team: true })).toBeNull();
    expect(cumulativeBound(WITH_WORDS, 'missing')).toBeNull();
  });
  it('the helper line names the thing only when the profile does, and only in a team', () => {
    expect(sharedLimitHelper(cumulativeBound(WITH_WORDS, 'box_daily_max')!, true, WORDS)).toBe("Every colleague's emails count toward this one number.");
    expect(sharedLimitHelper(cumulativeBound(NO_WORDS, 'thing_weekly_max')!, true)).toBe('Everyone on the team counts toward this one number.');
    expect(sharedLimitHelper(cumulativeBound(WITH_WORDS, 'box_daily_max')!, false)).toBeNull();
  });
});

describe('limit words from the manifest', () => {
  const manifests = [{ id: 'mail', profile: 'email', limitWords: WORDS }, { id: 'other', profile: 'email' }];
  it('finds them by the tool\'s connector', () => {
    expect(limitWordsForTool(manifests, 'mail__send_message')).toBe(WORDS);
    expect(limitWordsForTool(manifests, 'other__x')).toBeUndefined();
    expect(limitWordsForTool(undefined, 'mail__x')).toBeUndefined();
  });
  it('finds them by profile for the form, from any version id', () => {
    expect(limitWordsForProfile(manifests, 'github.com/x/hap-profiles/email@0.10')).toEqual(WORDS);
    expect(limitWordsForProfile(manifests, 'sales@0.4')).toBeUndefined();
  });
  it('a bound with no words still gets the plain sentence', () => {
    expect(refusalSentence({ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'm', field: 'box_daily_max', expected: 5, actual: 6 }, WITH_WORDS, {}).text)
      .toBe('Not done. The daily limit is used up: 5 of 5 today.');
  });
});
