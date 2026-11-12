/**
 * Security review 2026-11, finding A3 (the part Andreas approved 2026-11-12):
 *
 *  a. /auth/login leaves the running session alone until the new key is
 *     accepted — a foreign key no longer signs the current person out;
 *  b. "another account's vault" no longer depends on the first stored
 *     credential: a verifier, or for an old vault every encrypted store;
 *  c. while a session is unlocked, a different account is refused with the
 *     approved sentence.
 *
 * The real requests against a running gateway are in suveren-e2e
 * (test/gateway-account-switch.test.ts). This pins the vault rule and the
 * route's ordering with a stubbed Authority Server answer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { createAuthRouter, SIGNED_IN_ELSEWHERE } from '../auth';
import { setInternalSecret } from '../../lib/mcp-bridge';

const tmp = () => mkdtempSync(join(tmpdir(), 'auth-account-switch-'));
const realFetch = globalThis.fetch;
let stop: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

function startServer(vault: Vault) {
  const app = express();
  app.use(express.json());
  const pass = (_q: express.Request, _r: express.Response, n: express.NextFunction) => n();
  app.use('/auth', createAuthRouter(vault, pass, pass));
  return new Promise<{ url: string }>(resolve => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      stop = () => new Promise<void>(r => server.close(() => r()));
      resolve({ url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` });
    });
  });
}

/** The AS answers every key with a session for the user that key maps to. */
function stubAs(serverUrl: string, users: Record<string, { id: string; did: string }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(serverUrl)) return realFetch(url, init);
    if (url.includes('/api/auth/session')) {
      const key = (init?.headers as Record<string, string>)['X-API-Key'];
      const user = users[key];
      if (!user) return { ok: false, status: 401, headers: { getSetCookie: () => [] }, json: async () => ({ error: 'Invalid API key' }) } as unknown as Response;
      return {
        ok: true, status: 200,
        headers: { getSetCookie: () => [`hap-session=${user.id}`] },
        json: async () => ({ user, sessionExpiresAt: 1_800_000_000 }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }));
  setInternalSecret('test-secret');
}

const login = (url: string, key: string, body: Record<string, unknown> = {}) =>
  fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(body) });

const USERS = { key_anna: { id: 'u-anna', did: 'did:key:anna' }, key_mallory: { id: 'u-mallory', did: 'did:key:mallory' } };

describe('A3a + A3c — sign-in while someone is signed in', () => {
  it('a different account is refused with the approved sentence, and the current session stays', async () => {
    const vault = new Vault(tmp());
    const { url } = await startServer(vault);
    stubAs(url, USERS);
    expect((await login(url, 'key_anna')).status).toBe(200);

    const res = await login(url, 'key_mallory', { confirmWipe: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'signed_in_to_another_account', message: SIGNED_IN_ELSEWHERE });
    expect(SIGNED_IN_ELSEWHERE).toBe('This gateway is signed in to another account. Sign out first, then sign in with the new one.');

    expect(vault.isUnlocked()).toBe(true);
    expect(vault.validateApiKey('key_anna')).toBe(true);
    expect(vault.getSpCookie()).toBe('hap-session=u-anna');
    expect(vault.getSessionUser()?.id).toBe('u-anna');
  });

  it('a wrong key leaves the current session alone', async () => {
    const vault = new Vault(tmp());
    const { url } = await startServer(vault);
    stubAs(url, USERS);
    await login(url, 'key_anna');
    expect((await login(url, 'not-a-key')).status).toBe(401);
    expect(vault.validateApiKey('key_anna')).toBe(true);
    expect(vault.getSpCookie()).toBe('hap-session=u-anna');
  });

  it('the same account signing in again still works', async () => {
    const vault = new Vault(tmp());
    const { url } = await startServer(vault);
    stubAs(url, USERS);
    await login(url, 'key_anna');
    expect((await login(url, 'key_anna')).status).toBe(200);
    expect(vault.validateApiKey('key_anna')).toBe(true);
  });
});

describe('A3a + A3b — sign-in on a locked gateway that holds another account\'s data', () => {
  it('mandates but no credential: the switch is not silent, and nothing is touched', async () => {
    const dir = tmp();
    const vault = new Vault(dir);
    await vault.deriveAndSetKey('key_anna');
    // A store sealed under Anna's key (the MCP server's gate store uses the
    // same key and blob shape). No connector credential at all.
    writeFileSync(join(dir, 'gates.enc.json'), JSON.stringify({ version: 1, entries: { g1: vault.encrypt('{"mandate":1}') } }));
    // Strip the verifier: an old vault from before it existed.
    const vf = JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8'));
    delete vf.verifier;
    writeFileSync(join(dir, 'vault.enc.json'), JSON.stringify(vf));
    vault.clearKey();

    const { url } = await startServer(vault);
    stubAs(url, USERS);
    const res = await login(url, 'key_mallory');
    expect(res.status).toBe(409);
    expect((await res.json() as { error?: string }).error).toBe('different_account');
    expect(vault.isUnlocked()).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).verifier).toBeUndefined();
  });

  it('an old vault without a verifier recognises its own key and gains the verifier', async () => {
    const dir = tmp();
    const vault = new Vault(dir);
    await vault.deriveAndSetKey('key_anna');
    writeFileSync(join(dir, 'receipt-archive.enc.json'), JSON.stringify({ version: 1, blob: vault.encrypt('[]') }));
    const vf = JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8'));
    delete vf.verifier;
    writeFileSync(join(dir, 'vault.enc.json'), JSON.stringify(vf));
    vault.clearKey();

    const { url } = await startServer(vault);
    stubAs(url, USERS);
    expect((await login(url, 'key_anna')).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).verifier).toBeTruthy();
    vault.clearKey();
    // With the verifier, the other account is still refused.
    expect((await login(url, 'key_mallory')).status).toBe(409);
  });
});

describe('vault.keyMatch', () => {
  it('a fresh vault is empty, then the verifier decides', async () => {
    const vault = new Vault(tmp());
    const anna = await vault.deriveCandidateFromApiKey('key_anna');
    expect(vault.keyMatch(anna)).toBe('empty');
    vault.adopt(anna);
    vault.clearKey();
    expect(vault.keyMatch(await vault.deriveCandidateFromApiKey('key_anna'))).toBe('match');
    expect(vault.keyMatch(await vault.deriveCandidateFromApiKey('key_mallory'))).toBe('conflict');
  });

  it('deriving a candidate never changes the running session', async () => {
    const vault = new Vault(tmp());
    await vault.deriveAndSetKey('key_anna');
    vault.setSpCookie('c');
    await vault.deriveCandidateFromApiKey('key_mallory');
    expect(vault.validateApiKey('key_anna')).toBe(true);
    expect(vault.getSpCookie()).toBe('c');
  });

  it('without a verifier, one store that opens is a match (stores left over from an earlier account do not count against)', async () => {
    const dir = tmp();
    const old = new Vault(dir);
    await old.deriveAndSetKey('key_old');
    writeFileSync(join(dir, 'denials.enc.json'), JSON.stringify({ version: 1, blob: old.encrypt('[]') }));
    old.clearKey();
    const vault = new Vault(dir);
    const anna = await vault.deriveCandidateFromApiKey('key_anna');
    vault.adopt(anna);
    writeFileSync(join(dir, 'gates.enc.json'), JSON.stringify({ version: 1, entries: { a: vault.encrypt('x') } }));
    const vf = JSON.parse(readFileSync(join(dir, 'vault.enc.json'), 'utf-8'));
    delete vf.verifier;
    writeFileSync(join(dir, 'vault.enc.json'), JSON.stringify(vf));
    expect(vault.keyMatch(anna)).toBe('match');
    expect(vault.keyMatch(await vault.deriveCandidateFromApiKey('key_mallory'))).toBe('conflict');
  });
});
