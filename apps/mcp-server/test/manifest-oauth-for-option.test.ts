/**
 * `oauth.forOption` — a sign-in used by ONE data-source option only (Email
 * signs in with Google for Gmail, never for the test mailbox) — and
 * `replaces` (a connector that takes over a retired one). Loader validation
 * and the shipped mail.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifests, getManifest, invalidOAuthForOptionReason, invalidReplacesReason, type ManifestOAuthConfig,
} from '../src/lib/manifest-loader';

const SHIPPED = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const oauth = (forOption?: unknown): ManifestOAuthConfig => ({
  authUrl: 'https://a/o', tokenUrl: 'https://a/t', scopes: ['s'],
  credentialKeys: { clientId: 'clientId', clientSecret: 'clientSecret' }, tokenStorage: 'refreshToken',
  ...(forOption !== undefined ? { forOption: forOption as never } : {}),
});
const choice = {
  simulation: { field: 'mode', default: 'simulation' },
  modeLabels: { simulation: 'Test', live: { gmail: 'Gmail' }, plain: 'Plain' } as Record<string, string | Record<string, string>>,
};

describe('invalidOAuthForOptionReason', () => {
  it('null when not declared', () => {
    expect(invalidOAuthForOptionReason({ oauth: oauth(), ...choice })).toBeNull();
    expect(invalidOAuthForOptionReason({ oauth: null })).toBeNull();
  });
  it('accepts an adapter option and a plain mode', () => {
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'live', adapter: 'gmail' }), ...choice })).toBeNull();
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'plain' }), ...choice })).toBeNull();
  });
  it('needs the manifest\'s own mode choice', () => {
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'live', adapter: 'gmail' }) })).toMatch(/mode choice/);
  });
  it('the mode must exist; the adapter is given exactly for an adapter-keyed mode and must exist', () => {
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'nope' }), ...choice })).toMatch(/no modeLabels entry/);
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'live' }), ...choice })).toMatch(/adapter is required/);
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'live', adapter: 'imap' }), ...choice })).toMatch(/no modeLabels entry under/);
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'plain', adapter: 'x' }), ...choice })).toMatch(/not allowed/);
  });
  it('refuses a wrong shape or an unknown key', () => {
    expect(invalidOAuthForOptionReason({ oauth: oauth('live'), ...choice })).toMatch(/object/);
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: '' }), ...choice })).toMatch(/mode must be/);
    expect(invalidOAuthForOptionReason({ oauth: oauth({ mode: 'live', adapter: 'gmail', x: 1 }), ...choice })).toMatch(/unknown key/);
  });
});

describe('invalidReplacesReason', () => {
  const m = { id: 'new', credentials: { fields: [{ key: 'mode', label: 'm', type: 'text' as const }], envMapping: {} } };
  it('null when absent; accepts { id, set }', () => {
    expect(invalidReplacesReason(m)).toBeNull();
    expect(invalidReplacesReason({ ...m, replaces: [{ id: 'old', set: { mode: 'live' } }] })).toBeNull();
  });
  it('refuses empty, own id, duplicates, unknown keys, undeclared or non-string set values', () => {
    expect(invalidReplacesReason({ ...m, replaces: [] })).toMatch(/non-empty/);
    expect(invalidReplacesReason({ ...m, replaces: [{ id: 'new' }] })).toMatch(/own id/);
    expect(invalidReplacesReason({ ...m, replaces: [{ id: 'old' }, { id: 'old' }] })).toMatch(/twice/);
    expect(invalidReplacesReason({ ...m, replaces: [{ id: 'old', x: 1 } as never] })).toMatch(/unknown key/);
    expect(invalidReplacesReason({ ...m, replaces: [{ id: 'old', set: { other: 'x' } }] })).toMatch(/not a declared credential field/);
    expect(invalidReplacesReason({ ...m, replaces: [{ id: 'old', set: { mode: 1 as never } }] })).toMatch(/string/);
  });
});

describe('loadManifests', () => {
  it('refuses a manifest whose forOption names no option, keeps the others', () => {
    dir = mkdtempSync(join(tmpdir(), 'fo-'));
    const write = (id: string, extra: Record<string, unknown>) => writeFileSync(join(dir!, `${id}.json`), JSON.stringify({
      id, name: id, version: '1', description: '', icon: '', profile: 'email',
      mcp: { command: 'node', args: [] }, credentials: { fields: [{ key: 'mode', label: 'm', type: 'text', optional: true }, { key: 'liveAdapter', label: 'a', type: 'text', optional: true }], envMapping: {} },
      toolGating: { default: { executionMapping: {} }, overrides: {} }, ...extra,
    }));
    write('fogood', { ...choice, adapterField: 'liveAdapter', oauth: oauth({ mode: 'live', adapter: 'gmail' }) });
    write('fobad', { ...choice, adapterField: 'liveAdapter', oauth: oauth({ mode: 'live', adapter: 'imap' }) });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { fogood: 'fogood.json', fobad: 'fobad.json' } }));
    expect(loadManifests(dir)).toBe(1);
    expect(getManifest('fogood')).toBeDefined();
    expect(getManifest('fobad')).toBeUndefined();
  });
});

describe('shipped manifests', () => {
  it('mail signs in with Google ONLY for its Gmail option; calendar always', () => {
    loadManifests(SHIPPED);
    expect(getManifest('mail')!.oauth!.forOption).toEqual({ mode: 'live', adapter: 'gmail' });
    expect(getManifest('mail')!.oauth!.signInGroup).toEqual({ id: 'google', name: 'Google' });
    expect(getManifest('calendar')!.oauth!.forOption).toBeUndefined();
  });
  it('mail offers the test mailbox and Gmail, maps the token env, declares the outside calls, replaces gmail', () => {
    loadManifests(SHIPPED);
    const m = getManifest('mail')!;
    expect(m.modeLabels).toEqual({ simulation: 'Test mailbox', live: { gmail: 'Gmail' } });
    expect(m.modeOptions).toEqual({ live: { gmail: { label: 'Gmail', fields: ['clientId', 'clientSecret'] } } });
    expect(m.adapterField).toBe('liveAdapter');
    expect(m.npmVersion).toBe('0.5.2');
    expect(m.credentials.envMapping).toMatchObject({
      EMAIL_MODE: 'mode', EMAIL_LIVE_ADAPTER: 'liveAdapter', CLIENT_ID: 'clientId', CLIENT_SECRET: 'clientSecret', REFRESH_TOKEN: 'refreshToken',
    });
    expect(m.network?.map(n => n.host)).toEqual(['gmail.googleapis.com', 'oauth2.googleapis.com']);
    expect(m.replaces).toEqual([{ id: 'gmail', set: { mode: 'live', liveAdapter: 'gmail' } }]);
  });
  it('the old Gmail connector is no longer offered', () => {
    loadManifests(SHIPPED);
    expect(getManifest('gmail')).toBeUndefined();
    const index = JSON.parse(readFileSync(join(SHIPPED, 'index.json'), 'utf-8')) as { integrations: Record<string, string> };
    expect(Object.keys(index.integrations)).not.toContain('gmail');
  });
  it('Gmail keeps the mail area: same profile as before, so Email mandates stay valid', () => {
    loadManifests(SHIPPED);
    expect(getManifest('mail')!.profile).toBe('email');
  });
});
