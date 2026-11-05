/**
 * Shared sign-in groups: the control-plane rules that decide which credentials
 * a connector runs on once several connectors share one sign-in.
 * Pure logic, no network: a real Google sign-in needs a person in a browser
 * (see the hand-test list in docs/development.md, "Shared sign-in groups").
 */
import { describe, it, expect } from 'vitest';
import {
  groupCredentialName, parseGroupCredentialName, groupOfMember, unionScopes, effectiveCredentials,
  withoutSignIn, resolveGroupClient, credentialsToPush, type OAuthLike,
} from '../lib/sign-in-group';

const oauth = (scopes: string[], group = { id: 'google', name: 'Google' }): OAuthLike => ({
  scopes,
  credentialKeys: { clientId: 'clientId', clientSecret: 'clientSecret' },
  tokenStorage: 'refreshToken',
  signInGroup: group,
});

const MANIFESTS = [
  { id: 'gmail', oauth: oauth(['openid', 'mail.send']) },
  { id: 'calendar', oauth: oauth(['openid', 'cal.events']) },
  { id: 'linkedin', oauth: { ...oauth(['w_member_social']), signInGroup: undefined } },
  { id: 'crm', oauth: null },
];

describe('group naming', () => {
  it('round-trips the vault entry name', () => {
    expect(parseGroupCredentialName(groupCredentialName('google'))).toBe('google');
    expect(parseGroupCredentialName('gmail')).toBeNull();
    expect(parseGroupCredentialName('sign-in:')).toBeNull();
  });
});

describe('membership comes from the manifests only', () => {
  it('finds the group and its members in manifest order', () => {
    const g = groupOfMember(MANIFESTS, 'calendar');
    expect(g?.id).toBe('google');
    expect(g?.name).toBe('Google');
    expect(g?.members.map(m => m.id)).toEqual(['gmail', 'calendar']);
  });
  it('a connector without signInGroup is in no group, however similar its OAuth block', () => {
    expect(groupOfMember(MANIFESTS, 'linkedin')).toBeNull();
    expect(groupOfMember(MANIFESTS, 'crm')).toBeNull();
    expect(groupOfMember(MANIFESTS, 'unknown')).toBeNull();
    expect(groupOfMember(undefined, 'gmail')).toBeNull();
  });
  it('requests the union of the members scopes, once each', () => {
    expect(unionScopes(groupOfMember(MANIFESTS, 'gmail')!)).toEqual(['openid', 'mail.send', 'cal.events']);
  });
});

describe('effectiveCredentials', () => {
  const o = oauth([]);
  it('MIGRATION: with no group token the member keeps its own client and token', () => {
    const own = { clientId: 'own-id', clientSecret: 'own-secret', refreshToken: 'own-token' };
    expect(effectiveCredentials(own, null, o)).toEqual(own);
    // a group entry that only holds client settings must not swap the client under the member's own token
    expect(effectiveCredentials(own, { clientId: 'g-id', clientSecret: 'g-secret' }, o)).toEqual(own);
  });
  it('once the group holds a token it replaces the member sign-in fields, keeps the member other fields', () => {
    const own = { clientId: 'own-id', clientSecret: 's', refreshToken: 'old', extra: 'keep' };
    const group = { clientId: 'g-id', clientSecret: 'g-s', refreshToken: 'new', _oauthAccount: 'a@b.c', unrelated: 'x' };
    expect(effectiveCredentials(own, group, o)).toEqual({
      clientId: 'g-id', clientSecret: 'g-s', refreshToken: 'new', _oauthAccount: 'a@b.c', extra: 'keep',
    });
  });
  it('a member with no entry of its own still gets the group sign-in', () => {
    expect(effectiveCredentials(null, { clientId: 'i', clientSecret: 's', refreshToken: 't' }, o))
      .toEqual({ clientId: 'i', clientSecret: 's', refreshToken: 't' });
  });
  it('is the identity for a connector without OAuth', () => {
    expect(effectiveCredentials({ a: '1' }, { refreshToken: 't' }, null)).toEqual({ a: '1' });
  });
});

describe('withoutSignIn', () => {
  it('removes token and _oauth metadata, keeps the client settings and other fields', () => {
    expect(withoutSignIn(
      { clientId: 'i', clientSecret: 's', refreshToken: 't', _oauthAccount: 'a', _oauthConnectedAt: 'x', other: 'o' },
      oauth([]),
    )).toEqual({ clientId: 'i', clientSecret: 's', other: 'o' });
  });
});

describe('resolveGroupClient', () => {
  const group = groupOfMember(MANIFESTS, 'gmail')!;
  const pair = (n: string) => ({ clientId: `${n}-id`, clientSecret: `${n}-s` });
  it('prefers the group entry', () => {
    expect(resolveGroupClient(group, 'gmail', pair('g'), () => pair('own'))).toEqual({ clientId: 'g-id', clientSecret: 'g-s' });
  });
  it('MIGRATION: else the requesting member, else the other member', () => {
    const own: Record<string, Record<string, string>> = { gmail: pair('gmail'), calendar: pair('cal') };
    expect(resolveGroupClient(group, 'calendar', null, id => own[id] ?? null)).toEqual({ clientId: 'cal-id', clientSecret: 'cal-s' });
    expect(resolveGroupClient(group, 'calendar', null, id => (id === 'gmail' ? own.gmail : null)))
      .toEqual({ clientId: 'gmail-id', clientSecret: 'gmail-s' });
  });
  it('null when nobody has a complete client pair', () => {
    expect(resolveGroupClient(group, 'gmail', { clientId: 'only-id' }, () => ({ clientId: 'x' }))).toBeNull();
  });
});

describe('credentialsToPush', () => {
  const store: Record<string, Record<string, string>> = {
    gmail: { clientId: 'old', clientSecret: 'old-s', refreshToken: 'old-gmail' },
    calendar: { clientId: 'old', clientSecret: 'old-s', refreshToken: 'old-cal' },
    'sign-in:google': { clientId: 'g', clientSecret: 'g-s', refreshToken: 'group-token', _oauthAccount: 'me@x.y' },
  };
  const get = (n: string) => store[n] ?? null;

  it('a group entry fans out to every member and is never pushed itself', () => {
    const out = credentialsToPush('sign-in:google', MANIFESTS, get);
    expect(out.map(([id]) => id)).toEqual(['gmail', 'calendar']);
    for (const [, c] of out) expect(c.refreshToken).toBe('group-token');
  });
  it('a member write is pushed with the group sign-in laid over it', () => {
    expect(credentialsToPush('gmail', MANIFESTS, get)[0][1].refreshToken).toBe('group-token');
  });
  it('MIGRATION: no group entry -> exactly the old behaviour (own entry, own token)', () => {
    const only = (n: string) => (n === 'sign-in:google' ? null : store[n] ?? null);
    expect(credentialsToPush('calendar', MANIFESTS, only)).toEqual([['calendar', store.calendar]]);
    expect(credentialsToPush('sign-in:google', MANIFESTS, only).map(([, c]) => c.refreshToken)).toEqual(['old-gmail', 'old-cal']);
  });
  it('non-members and unknown groups are untouched / empty', () => {
    expect(credentialsToPush('ai-config', MANIFESTS, n => (n === 'ai-config' ? { k: 'v' } : null))).toEqual([['ai-config', { k: 'v' }]]);
    expect(credentialsToPush('sign-in:nope', MANIFESTS, get)).toEqual([]);
  });
});
