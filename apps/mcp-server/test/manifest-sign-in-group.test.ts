/**
 * `oauth.signInGroup` - manifests that share ONE sign-in (Gmail + Google
 * Calendar). Validation, the load-time refusal of a member that disagrees, the
 * group list the UI reads, and the shipped manifests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifests, getManifest, getSignInGroups, computeSignInGroups,
  invalidSignInGroupReason, invalidSignInGroupMismatchReason, type ManifestOAuthConfig,
} from '../src/lib/manifest-loader';

const SHIPPED = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const oauth = (over: Partial<ManifestOAuthConfig> = {}): ManifestOAuthConfig => ({
  authUrl: 'https://auth.example/o', tokenUrl: 'https://auth.example/t', scopes: ['a'],
  credentialKeys: { clientId: 'clientId', clientSecret: 'clientSecret' }, tokenStorage: 'refreshToken',
  extraParams: { access_type: 'offline' },
  signInGroup: { id: 'acme', name: 'Acme' },
  ...over,
});

describe('invalidSignInGroupReason', () => {
  it('null when no group is declared', () => {
    expect(invalidSignInGroupReason({ oauth: null })).toBeNull();
    expect(invalidSignInGroupReason({ oauth: oauth({ signInGroup: undefined }) })).toBeNull();
  });
  it('accepts { id, name }', () => {
    expect(invalidSignInGroupReason({ oauth: oauth() })).toBeNull();
  });
  it('refuses a bad id or an empty name', () => {
    expect(invalidSignInGroupReason({ oauth: oauth({ signInGroup: { id: 'Not A Slug', name: 'X' } }) })).toMatch(/slug/);
    expect(invalidSignInGroupReason({ oauth: oauth({ signInGroup: { id: 'x', name: ' ' } }) })).toMatch(/name/);
    expect(invalidSignInGroupReason({ oauth: oauth({ signInGroup: 'google' as never }) })).toMatch(/object/);
  });
});

describe('invalidSignInGroupMismatchReason', () => {
  const first = { id: 'one', oauth: oauth() };
  it('members may differ in scopes only', () => {
    expect(invalidSignInGroupMismatchReason({ id: 'two', oauth: oauth({ scopes: ['b'] }) }, first)).toBeNull();
  });
  it.each([
    ['authUrl', { authUrl: 'https://other/o' }],
    ['tokenUrl', { tokenUrl: 'https://other/t' }],
    ['revokeUrl', { revokeUrl: 'https://other/r' }],
    ['tokenStorage', { tokenStorage: 'accessToken' }],
    ['credentialKeys', { credentialKeys: { clientId: 'cid', clientSecret: 'clientSecret' } }],
    ['extraParams', { extraParams: { access_type: 'online' } }],
  ])('refuses a member whose %s differs', (field, over) => {
    expect(invalidSignInGroupMismatchReason({ id: 'two', oauth: oauth(over as Partial<ManifestOAuthConfig>) }, first)).toContain(field);
  });
  it('refuses a different display name for the same group id', () => {
    expect(invalidSignInGroupMismatchReason({ id: 'two', oauth: oauth({ signInGroup: { id: 'acme', name: 'ACME Inc' } }) }, first)).toMatch(/named/);
  });
});

describe('computeSignInGroups', () => {
  it('lists members in order with the union of scopes; ignores connectors outside any group', () => {
    const groups = computeSignInGroups([
      { id: 'one', oauth: oauth({ scopes: ['a', 'shared'] }) },
      { id: 'solo', oauth: oauth({ signInGroup: undefined, scopes: ['z'] }) },
      { id: 'two', oauth: oauth({ scopes: ['shared', 'b'] }) },
      { id: 'none', oauth: null },
    ]);
    expect(groups).toEqual([{ id: 'acme', name: 'Acme', members: ['one', 'two'], scopes: ['a', 'shared', 'b'] }]);
  });
});

describe('loadManifests', () => {
  const write = (id: string, o: ManifestOAuthConfig) => {
    writeFileSync(join(dir!, `${id}.json`), JSON.stringify({
      id, name: id, version: '1', description: '', icon: '', profile: 'email',
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} },
      toolGating: { default: { executionMapping: {} }, overrides: {} }, oauth: o,
    }));
  };

  it('refuses a later member that disagrees with the first, by name, and keeps the rest', () => {
    dir = mkdtempSync(join(tmpdir(), 'sig-'));
    write('sgone', oauth({ scopes: ['a'] }));
    write('sgtwo', oauth({ scopes: ['b'] }));
    write('sgbad', oauth({ tokenUrl: 'https://other/t' }));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { sgone: 'sgone.json', sgtwo: 'sgtwo.json', sgbad: 'sgbad.json' } }));
    expect(loadManifests(dir)).toBe(3 - 1);
    expect(getManifest('sgone')).toBeDefined();
    expect(getManifest('sgbad')).toBeUndefined();
    const g = getSignInGroups().find(x => x.id === 'acme')!;
    expect(g.members).toEqual(expect.arrayContaining(['sgone', 'sgtwo']));
    expect(g.members).not.toContain('sgbad');
  });
});

describe('shipped manifests', () => {
  it('mail and calendar declare Google\'s revocation endpoint', () => {
    loadManifests(SHIPPED);
    expect(getManifest('mail')!.oauth!.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
    expect(getManifest('calendar')!.oauth!.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
  });
  it('mail and calendar declare the one Google sign-in; loading them yields the union of scopes', () => {
    loadManifests(SHIPPED);
    const g = getSignInGroups().find(x => x.id === 'google');
    expect(g?.name).toBe('Google');
    expect(g?.members).toEqual(expect.arrayContaining(['mail', 'calendar']));
    const scopes = [...(getManifest('mail')!.oauth!.scopes), ...(getManifest('calendar')!.oauth!.scopes)];
    expect(new Set(g!.scopes)).toEqual(new Set(scopes));
    expect(g!.scopes.length).toBe(new Set(scopes).size);
  });
  it('no other shipped connector declares a group', () => {
    const index = JSON.parse(readFileSync(join(SHIPPED, 'index.json'), 'utf-8')) as { integrations: Record<string, string> };
    const declared = Object.entries(index.integrations)
      .filter(([, f]) => JSON.parse(readFileSync(join(SHIPPED, f), 'utf-8')).oauth?.signInGroup)
      .map(([id]) => id).sort();
    expect(declared).toEqual(['calendar', 'mail']);
  });
});
