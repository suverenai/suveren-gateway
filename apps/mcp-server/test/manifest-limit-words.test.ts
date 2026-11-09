/**
 * Manifest `limitWords` (the noun and past participle a shared limit's
 * sentences use) — validated by manifest-loader.ts's `invalidLimitWordsReason`;
 * the shipped `mail` manifest declares them for its daily send limit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidLimitWordsReason } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
const check = (limitWords: unknown) => invalidLimitWordsReason({ limitWords } as never);

describe('invalidLimitWordsReason', () => {
  it('accepts none, and a well-formed map', () => {
    expect(check(undefined)).toBeNull();
    expect(check({ some_daily_max: { noun: 'emails', pastParticiple: 'sent' } })).toBeNull();
  });
  it('refuses a malformed one', () => {
    expect(check({})).toMatch(/non-empty/);
    expect(check([])).toMatch(/non-empty/);
    expect(check({ k: 'emails' })).toMatch(/must be an object/);
    expect(check({ k: { noun: 'emails' } })).toMatch(/pastParticiple/);
    expect(check({ k: { noun: '', pastParticiple: 'sent' } })).toMatch(/noun/);
    expect(check({ k: { noun: 'a\nb', pastParticiple: 'sent' } })).toMatch(/noun/);
    expect(check({ k: { noun: 'x'.repeat(41), pastParticiple: 'sent' } })).toMatch(/noun/);
    expect(check({ k: { noun: 'emails', pastParticiple: 'sent', extra: 1 } })).toMatch(/unknown key/);
  });
  it('the shipped mail manifest declares its send limit words and passes', () => {
    const mail = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'mail.json'), 'utf8'));
    expect(mail.limitWords).toEqual({ send_daily_max: { noun: 'emails', pastParticiple: 'sent' } });
    expect(invalidLimitWordsReason(mail)).toBeNull();
  });
});
