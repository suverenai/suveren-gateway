/**
 * Real-gateway e2e (2026-10-15): right after "Different user confirmed —
 * wiping vault…", the very next AI tool call that needed the control
 * plane's own Authority Server session (an above-cap proposal's encrypted
 * content, via /internal/encrypt-content) failed with "no Authority Server
 * session" — vault.getSpCookie() was null.
 *
 * Root cause: `vault.wipe()` calls `clearKey()`, which also nulls
 * `spSessionCookie` (and `sessionUser`) — the SAME cookie the login route
 * had just set a few lines earlier, before deciding a wipe was needed.
 * `sessionUser` is explicitly re-set after the wipe (unconditionally,
 * further down the route); the cookie was not — so every subsequent
 * `vault.getSpCookie()` read for the rest of that session returned null,
 * even though the login response itself looked completely successful to
 * the browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { setInternalSecret } from '../../lib/mcp-bridge';

const tmp = () => mkdtempSync(join(tmpdir(), 'auth-wipe-session-'));

function startServer(vault: Vault) {
  const app = express();
  app.use(express.json());
  const noopAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const noopRateLimit = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/auth', createAuthRouter(vault, noopAuth, noopRateLimit));
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;
let stop: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;

afterEach(async () => {
  await stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

/** Mirrors auth-session.test.ts's stubFetch — the AS/MCP calls the route
 *  handler makes, never the test's own request into its local server. */
function stubFetch(serverUrl: string, sessionResponse: { status: number; body: unknown }, sessionCookie: string) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(serverUrl)) return realFetch(url, init);
    if (url.includes('/api/auth/session')) {
      return {
        ok: sessionResponse.status >= 200 && sessionResponse.status < 300,
        status: sessionResponse.status,
        headers: { getSetCookie: () => [sessionCookie] },
        json: async () => sessionResponse.body,
      } as unknown as Response;
    }
    // /internal/configure, /internal/remove-integration, /api/users/me/pubkey — succeed quietly.
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  setInternalSecret('test-secret');
}

describe('POST /auth/login — the Authority Server session must survive a confirmed vault wipe', () => {
  it('a login that WIPES the vault (a different API key than the stored one) still leaves ' +
    'vault.getSpCookie() populated — the real regression (reproduced live: "Different user ' +
    'confirmed — wiping vault…" immediately followed by "no Authority Server session")', async () => {
    const vault = new Vault(tmp());

    // Seed a credential encrypted under the FIRST user's key, exactly what
    // makes a later login with a DIFFERENT key trip isVaultFromDifferentKey().
    await vault.deriveAndSetKey('hap_old_user_key');
    vault.setCredential('gmail', { token: 'old-user-secret' });
    vault.clearKey(); // simulate a fresh process boot — locked, nothing cached

    const { url, close } = await startServer(vault); stop = close;
    const newCookie = 'hap-session=new-user-session; Path=/; HttpOnly';
    stubFetch(url, { status: 200, body: { user: { id: 'u-new', did: 'did:key:new' }, sessionExpiresAt: 1_800_000_000 } }, newCookie);

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_new_user_key' },
      // The UI already showed the "different account" warning and the
      // person confirmed — same as a real wipe-triggering login.
      body: JSON.stringify({ confirmWipe: true }),
    });

    expect(res.status).toBe(200);
    // The real regression: this was null after a wipe-triggering login.
    expect(vault.getSpCookie()).toBe(newCookie);
    // sessionUser already worked before this fix (set unconditionally,
    // after the wipe) — asserted here too so a future regression that
    // breaks THIS one is caught by the same test.
    expect(vault.getSessionUser()).toEqual({ id: 'u-new', did: 'did:key:new' });
    // The vault is usable (re-derived key) and the old credential is gone.
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.listCredentials()).toEqual([]);
  });

  it('a login that does NOT wipe (same key, or an empty vault) still sets the cookie — unchanged', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault); stop = close;
    const cookie = 'hap-session=same-user; Path=/; HttpOnly';
    stubFetch(url, { status: 200, body: { user: { id: 'u1', did: 'did:key:u1' }, sessionExpiresAt: 1_800_000_000 } }, cookie);

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(200);
    expect(vault.getSpCookie()).toBe(cookie);
  });
});
