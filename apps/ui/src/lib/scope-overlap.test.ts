import { describe, it, expect } from 'vitest';
import { scopesOverlap, tokenSet } from './scope-overlap';

const EMAIL_KEYS = ['allowed_recipients', 'allowed_domains'];

describe('tokenSet', () => {
  it('splits, trims, lowercases, and drops empties', () => {
    expect([...tokenSet(' A@x.com , b@x.com ,')]).toEqual(['a@x.com', 'b@x.com']);
  });
  it('treats null/undefined/empty as the empty set', () => {
    expect(tokenSet(undefined).size).toBe(0);
    expect(tokenSet('').size).toBe(0);
    expect(tokenSet('   ').size).toBe(0);
  });
});

describe('scopesOverlap', () => {
  it('disjoint recipients → no overlap (the reported false-positive case)', () => {
    const a = { allowed_recipients: 'asdf@asdfasdfads.at' };
    const b = { allowed_recipients: 'andreas.schadauer@gmail.com' };
    expect(scopesOverlap(EMAIL_KEYS, a, b)).toBe(false);
  });

  it('intersecting recipients → overlap', () => {
    const a = { allowed_recipients: 'x@a.com, shared@a.com' };
    const b = { allowed_recipients: 'shared@a.com, y@b.com' };
    expect(scopesOverlap(EMAIL_KEYS, a, b)).toBe(true);
  });

  it('a wildcard (empty) field on one side → overlap', () => {
    const a = { allowed_recipients: '' };
    const b = { allowed_recipients: 'andreas@x.com' };
    expect(scopesOverlap(EMAIL_KEYS, a, b)).toBe(true);
  });

  it('separated on any single dimension → no overlap', () => {
    const a = { allowed_recipients: 'shared@a.com', allowed_domains: 'a.com' };
    const b = { allowed_recipients: 'shared@a.com', allowed_domains: 'b.com' };
    expect(scopesOverlap(EMAIL_KEYS, a, b)).toBe(false);
  });

  it('case-insensitive token match', () => {
    const a = { allowed_recipients: 'Andreas@X.com' };
    const b = { allowed_recipients: 'andreas@x.com' };
    expect(scopesOverlap(EMAIL_KEYS, a, b)).toBe(true);
  });

  it('no context keys (context-less profile) → always overlap', () => {
    expect(scopesOverlap([], { a: '1' }, { b: '2' })).toBe(true);
  });

  it('both fully unscoped → overlap', () => {
    expect(scopesOverlap(EMAIL_KEYS, {}, {})).toBe(true);
  });
});
