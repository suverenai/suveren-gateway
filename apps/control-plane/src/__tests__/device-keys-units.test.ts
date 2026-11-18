/**
 * The pieces under device-keys step 6: sealed vault slots, the device signing key
 * beside the reading key, the stored chain, and how a bearer token is sent.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519PublicKey } from '@hap/core/device-keys';
import { Vault } from '../lib/vault';
import { loadOrGenerateKeyPair, loadOrGenerateDeviceSigningKey, getDeviceSigningPublicKey } from '../lib/e2e-key-manager';
import { DeviceChainStore, DeviceChainCorruptError, ChainHeadRefusedError, type StoredDeviceChain } from '../lib/device-chain-store';
import { asAuthHeaders, bearerCredential, isBearerCredential } from '../lib/as-credential';
import { scrubProxyRequest } from '../lib/proxy-headers';
import { createEstablish } from '../lib/device-session-establish';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const tmp = () => mkdtempSync(join(tmpdir(), 'dk-units-'));
const vaultFile = (d: string) => join(d, 'vault.enc.json');

async function pwVault(dir = tmp()) {
  const v = new Vault(dir, { ...FAST, deviceKeys: true });
  await v.createWithPassword('correct horse battery', 'u1');
  return { v, dir };
}

describe('vault secret slots', () => {
  it('are sealed, not listed among credentials, and not touched by credential writes', async () => {
    const { v, dir } = await pwVault();
    v.setSecretSlot('thing', { secret: 'plain-secret-value' });
    expect(v.getSecretSlot('thing')).toEqual({ secret: 'plain-secret-value' });
    expect(v.listCredentials()).toEqual([]);
    expect(v.getCredential('thing')).toBeNull();
    expect(readFileSync(vaultFile(dir), 'utf-8')).not.toContain('plain-secret-value');
    v.setCredential('gmail', { token: 't' });
    v.deleteCredential('gmail');
    v.setCredential('crm', { key: 'k' });
    expect(v.getSecretSlot('thing')).toEqual({ secret: 'plain-secret-value' });
    expect(v.listCredentials()).toEqual(['crm']);
  });

  it('survive a password change and a move to a fresh key, and open again after a restart', async () => {
    const { v, dir } = await pwVault();
    v.setSecretSlot('thing', { n: 1 });
    expect(await v.changePassword('correct horse battery', 'another long password')).toBe(true);
    expect(v.getSecretSlot('thing')).toEqual({ n: 1 });
    const again = new Vault(dir, { ...FAST, deviceKeys: true });
    expect(await again.unlockWithPassword('another long password')).toBe(true);
    expect(again.getSecretSlot('thing')).toEqual({ n: 1 });
  });

  it('are re-sealed when a vault moves to a password with a slot already in it', async () => {
    const dir = tmp();
    const v = new Vault(dir, FAST);
    await v.deriveAndSetKey('hap_account_key');
    v.setSecretSlot('thing', { n: 2 });
    await v.setPassword('correct horse battery', 'u1');
    expect(v.getSecretSlot('thing')).toEqual({ n: 2 });
  });

  it('cannot be read or written while locked', async () => {
    const { v } = await pwVault();
    v.setSecretSlot('thing', { n: 1 });
    v.clearKey();
    expect(() => v.getSecretSlot('thing')).toThrow();
    expect(() => v.setSecretSlot('thing', { n: 2 })).toThrow();
  });

  it('never write over a vault file that cannot be read (a write would drop the password header)', async () => {
    const { v, dir } = await pwVault();
    const before = readFileSync(vaultFile(dir), 'utf-8');
    writeFileSync(vaultFile(dir), '{ not json');
    expect(() => v.setSecretSlot('thing', { n: 1 })).toThrow();
    expect(readFileSync(vaultFile(dir), 'utf-8')).toBe('{ not json');
    writeFileSync(vaultFile(dir), before);
    v.setSecretSlot('thing', { n: 1 });
    expect(v.hasPassword()).toBe(true);
  });

  it('a wipe (a different account) removes them', async () => {
    const dir = tmp();
    const v = new Vault(dir, FAST);
    await v.deriveAndSetKey('hap_account_key');
    v.setSecretSlot('thing', { n: 3 });
    v.wipe();
    expect(readFileSync(vaultFile(dir), 'utf-8')).not.toContain('slots');
  });
});

describe('the device signing key', () => {
  it('is an Ed25519 key beside the reading key; the reading key slot is unchanged', async () => {
    const { v } = await pwVault();
    const reading = await loadOrGenerateKeyPair(v);
    const stored = JSON.stringify(v.getCredential('e2eKey'));
    const signing = await loadOrGenerateDeviceSigningKey(v);
    expect(signing.privateSeed).toHaveLength(32);
    expect(Buffer.from(signing.publicKey).equals(Buffer.from(await ed25519PublicKey(signing.privateSeed)))).toBe(true);
    expect(Buffer.from(signing.publicKey).equals(Buffer.from(reading.publicKey))).toBe(false);
    expect(JSON.stringify(v.getCredential('e2eKey'))).toBe(stored);
    expect(getDeviceSigningPublicKey(v)).toEqual(signing.publicKey);
    // it is not a credential: nothing that lists or pushes credentials sees it
    expect(v.listCredentials()).toEqual(['e2eKey']);
  });

  it('stays the same key: on every call, after a restart, and for calls made at the same moment', async () => {
    const { v, dir } = await pwVault();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => loadOrGenerateDeviceSigningKey(v)));
    for (const k of all) expect(Buffer.from(k.privateSeed).equals(Buffer.from(all[0].privateSeed))).toBe(true);
    const later = await loadOrGenerateDeviceSigningKey(v);
    expect(Buffer.from(later.privateSeed).equals(Buffer.from(all[0].privateSeed))).toBe(true);
    const again = new Vault(dir, { ...FAST, deviceKeys: true });
    await again.unlockWithPassword('correct horse battery');
    expect(Buffer.from((await loadOrGenerateDeviceSigningKey(again)).privateSeed).equals(Buffer.from(all[0].privateSeed))).toBe(true);
  });

  it('getDeviceSigningPublicKey never makes one', async () => {
    const { v } = await pwVault();
    expect(getDeviceSigningPublicKey(v)).toBeNull();
    expect(v.getSecretSlot('deviceSigningKey')).toBeNull();
  });
});

describe('the stored chain', () => {
  const chain = (over: Partial<StoredDeviceChain> = {}): StoredDeviceChain => ({
    v: 1, rootDid: 'did:key:z6MkExample', keyId: 'k'.repeat(43), head: { seq: 0, hash: `sha256:${'a'.repeat(64)}` },
    asUrl: 'https://as.example', label: 'This computer', setUpAt: 1_800_000_000, ...over,
  });

  it('is written once, and a second write is refused', async () => {
    const { v } = await pwVault();
    const s = new DeviceChainStore(v);
    expect(s.exists()).toBe(false);
    expect(s.read()).toBeNull();
    s.create(chain());
    expect(s.exists()).toBe(true);
    expect(() => s.create(chain({ rootDid: 'did:key:z6MkOther' }))).toThrow();
    expect(s.read()?.rootDid).toBe('did:key:z6MkExample');
  });

  it('refuses a record that is not what it writes', async () => {
    const { v } = await pwVault();
    const s = new DeviceChainStore(v);
    expect(() => s.create(chain({ rootDid: 'nope' }))).toThrow();
    expect(() => s.create(chain({ head: { seq: -1, hash: `sha256:${'a'.repeat(64)}` } }))).toThrow();
    expect(() => s.create(chain({ keyId: 'short' }))).toThrow();
    expect(s.exists()).toBe(false);
  });

  it('the head only moves forward: lower is a rollback, same number with another hash a fork', async () => {
    const { v } = await pwVault();
    const s = new DeviceChainStore(v);
    s.create(chain({ head: { seq: 2, hash: `sha256:${'b'.repeat(64)}` } }));
    const reasonOf = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return e instanceof ChainHeadRefusedError ? e.reason : 'other'; } return undefined; };
    expect(reasonOf(() => s.advance({ seq: 1, hash: `sha256:${'c'.repeat(64)}` }))).toBe('rollback');
    expect(reasonOf(() => s.advance({ seq: 2, hash: `sha256:${'c'.repeat(64)}` }))).toBe('fork');
    expect(s.read()?.head).toEqual({ seq: 2, hash: `sha256:${'b'.repeat(64)}` });
    expect(s.advance({ seq: 2, hash: `sha256:${'b'.repeat(64)}` }).head.seq).toBe(2);
    expect(s.advance({ seq: 3, hash: `sha256:${'d'.repeat(64)}` }).head).toEqual({ seq: 3, hash: `sha256:${'d'.repeat(64)}` });
    expect(s.read()?.head.seq).toBe(3);
  });

  it('a slot it cannot read counts as set up, never as not set up', async () => {
    const { v } = await pwVault();
    v.setSecretSlot('deviceChain', { v: 1, rootDid: 'bad' });
    const s = new DeviceChainStore(v);
    expect(() => s.read()).toThrow(DeviceChainCorruptError);
    expect(s.exists()).toBe(true);
    v.clearKey();
    expect(s.exists()).toBe(true); // locked with a slot present: unknown is "yes"
  });
});

describe('how the Authority Server credential is sent', () => {
  it('a token goes as Authorization; a session cookie as Cookie, exactly as before', () => {
    expect(asAuthHeaders('hap-session=abc; Path=/')).toEqual({ Cookie: 'hap-session=abc; Path=/' });
    const b = bearerCredential('11111111-2222-3333-4444-555555555555');
    expect(asAuthHeaders(b)).toEqual({ Authorization: b });
    expect(isBearerCredential(b)).toBe(true);
    expect(isBearerCredential('hap-session=abc')).toBe(false);
    expect(isBearerCredential(null)).toBe(false);
  });

  it('a token that is not a token never becomes a header', () => {
    for (const bad of ['', 'a b', 'a\r\nX: 1', 'x'.repeat(129), 'ü']) expect(() => bearerCredential(bad)).toThrow();
  });

  it('the /api proxy sends a bearer as Authorization, drops every Cookie, and keeps the page secrets from the Authority Server', () => {
    const headers: Record<string, string> = { cookie: 'suveren_page_session=PAGE', 'x-suveren-session': 'TOKEN', 'x-suveren-confirmation': 'c', authorization: 'Bearer forged-by-the-page' };
    const req = { setHeader: (n: string, v: string) => { headers[n.toLowerCase()] = v; }, removeHeader: (n: string) => { delete headers[n.toLowerCase()]; } };
    const b = bearerCredential('11111111-2222-3333-4444-555555555555');
    scrubProxyRequest(req, b);
    expect(headers.authorization).toBe(b);
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-suveren-session']).toBeUndefined();
    expect(headers['x-suveren-confirmation']).toBeUndefined();
  });

  it('the /api proxy is what it was for a cookie session and for none', () => {
    const mk = () => { const h: Record<string, string> = { cookie: 'suveren_page_session=PAGE', 'x-suveren-session': 'T' }; return { h, req: { setHeader: (n: string, v: string) => { h[n.toLowerCase()] = v; }, removeHeader: (n: string) => { delete h[n.toLowerCase()]; } } }; };
    const a = mk(); scrubProxyRequest(a.req, 'hap-session=AS');
    expect(a.h).toEqual({ cookie: 'hap-session=AS' });
    const n = mk(); scrubProxyRequest(n.req, null);
    expect(n.h).toEqual({});
  });
});

describe('the hand-over after a sign-in', () => {
  const session = { token: '11111111-2222-3333-4444-555555555555', expiresAt: 2_000_000_000, user: { id: 'u1', did: 'did:key:z6MkExample' }, head: { seq: 0, hash: `sha256:${'a'.repeat(64)}` } };

  it('finishes an unfinished move to a fresh vault key BEFORE it hands the MCP server a key, and hands it what the MCP server reports', async () => {
    const { v } = await pwVault();
    vi.spyOn(v, 'hasPendingRekey').mockReturnValue(true);
    const reconcile = vi.spyOn(v, 'reconcileRekey').mockResolvedValue({ outcome: 'pending', mcpKeyHex: 'ee'.repeat(32) });
    const configured: Array<{ c: string; k?: string }> = [];
    const establish = createEstablish({ vault: v, configure: async (c, k) => { configured.push({ c, k }); }, log: () => {} });
    await establish(session, true);
    expect(reconcile).toHaveBeenCalled();
    expect(configured).toEqual([{ c: `Bearer ${session.token}`, k: 'ee'.repeat(32) }]);
  });

  it('a move that cannot be finished hands over nothing and says so', async () => {
    const { v } = await pwVault();
    vi.spyOn(v, 'hasPendingRekey').mockReturnValue(true);
    vi.spyOn(v, 'reconcileRekey').mockResolvedValue({ outcome: 'locked', mcpKeyHex: null });
    const configured: unknown[] = [];
    const establish = createEstablish({ vault: v, configure: async (...a) => { configured.push(a); }, log: () => {} });
    await expect(establish(session, true)).rejects.toThrow('rekey_incomplete');
    expect(configured).toEqual([]);
    expect(v.getSpCookie()).toBeNull();
  });

  it('a locked vault takes nothing, for the first sign-in of an unlock and for a renewal', async () => {
    const { v } = await pwVault();
    v.clearKey();
    const configured: unknown[] = [];
    const establish = createEstablish({ vault: v, configure: async (...a) => { configured.push(a); }, log: () => {} });
    await expect(establish(session, true)).rejects.toThrow();
    await expect(establish(session, false)).rejects.toThrow('locked');
    expect(v.getSpCookie()).toBeNull();
    expect(configured).toEqual([]);
  });
});

describe('every caller that sends the Authority Server credential sends a bearer token as Authorization', () => {
  it('the team check and the evidence export reach the Authority Server with a device session', async () => {
    const { StubAs } = await import('./helpers/stub-as');
    const express = (await import('express')).default;
    const { activeTeamId } = await import('../lib/managed-team');
    const { createEvidenceExportRouter } = await import('../routes/evidence-export');
    const as = await new StubAs().listen();
    const dir = tmp();
    // a device session opened the way the AS opens one: seed the stub's own table through its sign-in is not needed here
    const token = '11111111-2222-3333-4444-555555555555';
    (as as unknown as { sessions: Map<string, unknown> }).sessions.set(token, { keyId: 'k', userId: 'u1', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const credential = bearerCredential(token);
    try {
      expect(await activeTeamId(as.url, credential, { enforce: false })).toBe('team-1');
      const app = express();
      app.use('/api/evidence-export', createEvidenceExportRouter(as.url, { getSpCookie: () => credential } as unknown as Vault, dir, () => {}));
      const srv = app.listen(0, '127.0.0.1');
      await new Promise<void>(r => srv.on('listening', r));
      try {
        const port = (srv.address() as { port: number }).port;
        const body = await (await fetch(`http://127.0.0.1:${port}/api/evidence-export`)).json() as { authorityServer?: unknown };
        expect(body.authorityServer).toEqual({ tickets: [] });
      } finally { srv.close(); }
      const seen = as.requests.filter(r => r.path === '/api/groups/me' || r.path === '/api/tickets/export');
      expect(seen).toHaveLength(2);
      for (const r of seen) { expect(r.headers.authorization).toBe(credential); expect(r.headers.cookie).toBeUndefined(); }
    } finally { await as.close(); }
  });
});

describe('the proposal preview sends a device session as Authorization', () => {
  it('proposal preview', async () => {
    const express = (await import('express')).default;
    const { createProposalStatusRouter } = await import('../routes/proposal-preview');
    const { ShownSnapshotStore } = await import('../lib/shown-snapshot');
    const credential = bearerCredential('11111111-2222-3333-4444-555555555555');
    const dir = tmp();
    const realFetch = globalThis.fetch;
    const asCalls: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://as.example.test')) { asCalls.push(init?.headers as Record<string, string>); return { ok: false, status: 404, json: async () => ({}) } as unknown as Response; }
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }));
    const app = express();
    app.use(express.json());
    const vault = { getSpCookie: () => credential, getSessionUser: () => null, getCredential: () => null, isUnlocked: () => true } as unknown as Vault;
    app.use('/proposal-status', createProposalStatusRouter('https://as.example.test', vault, dir, () => {}, new ShownSnapshotStore(dir)));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.on('listening', r));
    try {
      await realFetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/proposal-status/p1/preview`);
    } finally { srv.close(); vi.unstubAllGlobals(); }
    expect(asCalls.length).toBeGreaterThan(0);
    for (const h of asCalls) { expect(h.Authorization).toBe(credential); expect(h.Cookie).toBeUndefined(); }
  });
});
