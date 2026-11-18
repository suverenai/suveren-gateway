/**
 * Unlock password and page session through the real routes and middleware
 * (device-keys plan step 5). In-process Express on an ephemeral port; test
 * vaults in the OS temp dir; the clock is moved, never slept.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { createPasswordRouter } from '../password';
import { createVaultRouter } from '../vault';
import { createOAuthFlowRouter, CALLBACK_WINDOW_MS, type OAuthManifestEntry } from '../oauth-flow';
import { OAuthStartTickets } from '../../lib/oauth-start-ticket';
import type { McpRekeyClient } from '../../lib/vault';
import { createEventsHandler } from '../events';
import { OAuthStateStore } from '../../lib/oauth-state';
import { createInternalOsSignalRouter } from '../internal-os-signal';
import { requireAuth, requireAuthQueryOrHeader, closeStreamWhenSessionEnds, type PageSessionDeps } from '../../middleware/auth';
import { PageSessions, createOsSignalHook, IDLE_LIMIT_MS, SESSION_COOKIE, SESSION_HEADER } from '../../lib/page-session';
import { UnlockLimiter, FREE_ATTEMPTS, BASE_LOCKOUT_MS } from '../../lib/unlock-limiter';
import { ChangeConfirmations, CONFIRMATION_TTL_MS, CONFIRMATION_HEADER, createLoginChangeGate } from '../../lib/change-confirmation';
import { setInternalSecret } from '../../lib/mcp-bridge';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const PW = 'correct horse battery';
const KEY = 'hap_account_key';
const MIN = 60_000;

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'password-routes-')); dirs.push(d); return d; };

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string; origin?: string | null } = {}): Promise<Reply> {
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, ...(opts.headers ?? {}) };
  if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? `http://${host}`;
  else if (opts.origin) headers.origin = opts.origin;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      // The event stream never finishes: a status is all a request here needs.
      if (path.startsWith('/events') && res.statusCode === 200) { resolve({ status: 200, headers: res.headers, body: {} }); req.destroy(); return; }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { let body = {}; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, headers: res.headers, body }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const tok = (id: string, group?: string): OAuthManifestEntry => ({
  id,
  oauth: {
    authUrl: 'https://provider.example/auth', tokenUrl: 'https://provider.example/token', scopes: [`${id}.s`],
    credentialKeys: { clientId: 'clientId', clientSecret: 'clientSecret' }, tokenStorage: 'refreshToken',
    ...(group ? { signInGroup: { id: group, name: 'Google' } } : {}),
  },
});
/** A single connector, and two members of one sign-in group. */
const MANIFESTS: OAuthManifestEntry[] = [tok('cal'), tok('mail', 'google'), tok('calendar', 'google')];
const CAL: OAuthManifestEntry = {
  id: 'cal',
  oauth: {
    authUrl: 'https://provider.example/auth', tokenUrl: 'https://provider.example/token', scopes: ['s'],
    credentialKeys: { clientId: 'clientId', clientSecret: 'clientSecret' }, tokenStorage: 'refreshToken',
  },
};

/** No test may reach a real MCP server or provider: every outgoing fetch is answered here. */
function stubNetwork(extra?: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const special = extra?.(String(url));
    if (special) return special as Response;
    if (String(url).includes('provider.example/token')) return { ok: true, status: 200, json: async () => ({ refresh_token: 'new-refresh-token' }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ manifests: MANIFESTS }) } as unknown as Response;
  }));
  setInternalSecret('test-secret');
}

interface Rig {
  port: number; vault: Vault; dir: string; sessions: PageSessions; clock: { now: () => number; advance: (ms: number) => void };
  deps: PageSessionDeps; setCheckKey: (v: boolean) => void; failRekey: (v: boolean) => void; rekeys: string[][]; tickets: OAuthStartTickets; oauthStates: OAuthStateStore; confirmations: ChangeConfirmations; osSignals: string[]; close: () => Promise<void>; writes: string[];
}

/** One "gateway process" over a data dir, wired like index.ts. */
async function boot(dir: string, opts: { loopbackOnly?: boolean; clock?: Rig['clock'] } = {}): Promise<Rig> {
  let t = 5_000_000;
  const clock = opts.clock ?? { now: () => t, advance: (ms: number) => { t += ms; } };
  const vault = new Vault(dir, { ...FAST, deviceKeys: true });
  const sessions = new PageSessions({ now: clock.now });
  const deps: PageSessionDeps = { sessions, listensOnLoopbackOnly: opts.loopbackOnly ?? true };
  vault.onLocked(() => sessions.endAll());
  const limiter = new UnlockLimiter({ now: clock.now });
  const confirmations = new ChangeConfirmations({ now: clock.now });
  let checkKey = false;
  let failRekey = false;
  const osSignals: string[] = [];
  const writes: string[] = [];
  const guard = requireAuth(vault, deps);
  const rekeys: string[][] = [];

  const app = express();
  app.use(express.json());
  let moved = false;
  const mcp: McpRekeyClient = {
    state: async () => ({ sealedWith: moved ? 'new' as const : 'old' as const }),
    rekey: async (o, n) => { if (failRekey) throw new Error('mcp down'); rekeys.push([o, n]); moved = true; },
  };
  app.use('/auth', createPasswordRouter({ vault, pageSession: deps, limiter, confirmations, hasCheckKey: () => checkKey, mcp }));
  app.use('/auth', createAuthRouter(vault, guard, (_q, _s, n) => n(), undefined, undefined, undefined, undefined, deps));
  app.get('/events', requireAuthQueryOrHeader(vault, deps), closeStreamWhenSessionEnds(vault, deps, 20), createEventsHandler());
  app.get('/api/poll', guard, (_q, s) => { s.json({ ok: true }); });
  app.post('/api/action', guard, (_q, s) => { s.json({ ok: true }); });
  app.get('/proposal-status/p1/preview', guard, (_q, s) => { s.json({ ok: true }); });
  const gate = createLoginChangeGate(vault, sessions, confirmations);
  app.use('/vault', guard, createVaultRouter(vault, gate));
  const oauthStates = new OAuthStateStore(undefined, clock.now);
  const tickets = new OAuthStartTickets(clock.now);
  app.use(createOAuthFlowRouter({
    vault, oauthStates,
    getOAuthManifest: async id => MANIFESTS.find(m => m.id === id) ?? null,
    manifestCache: () => MANIFESTS,
    resolveOrigin: () => 'http://127.0.0.1:1',
    pushEffective: async () => {},
    authGuard: guard,
    gate, pageSession: deps, tickets, now: clock.now,
  }));
  app.use('/internal', createInternalOsSignalRouter(() => 'sekret', sig => { osSignals.push(sig); createOsSignalHook(sessions, () => {})(sig); }));

  const server: Server = await new Promise(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const port = (server.address() as { port: number }).port;
  return {
    port, vault, dir, sessions, clock, deps, osSignals, writes,
    setCheckKey: v => { checkKey = v; },
    failRekey: v => { failRekey = v; }, rekeys, oauthStates, confirmations, tickets,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

const open: Rig[] = [];
async function rig(dir = tmp(), opts?: Parameters<typeof boot>[1]) { stubNetwork(); const r = await boot(dir, opts); open.push(r); return r; }
afterEach(async () => { for (const r of open.splice(0)) await r.close(); vi.unstubAllGlobals(); });

/** A gateway as the last release leaves it: unlocked by the account key, with a stored login. */
async function legacy(): Promise<Rig> {
  const r = await rig();
  await r.vault.deriveAndSetKey(KEY);
  r.vault.setSessionUser({ id: 'u1', did: 'did:key:u1' });
  r.vault.setCredential('gmail', { token: 'secret-token-1' });
  r.vault.setCredential('cal', { clientId: 'cid', clientSecret: 'csec', refreshToken: 'old-refresh-token' });
  return r;
}

const sessionHeaders = (token: string, cookie: string) => ({ cookie: `${SESSION_COOKIE}=${cookie}`, [SESSION_HEADER]: token });
function sessionOf(r: Reply): { token: string; cookie: string } {
  const setCookie = String(r.headers['set-cookie']?.[0] ?? '');
  const cookie = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
  return { token: String(r.body.sessionToken ?? ''), cookie };
}

/** Legacy gateway -> password set -> returns the first session. */
async function withPassword() {
  const r = await legacy();
  const set = await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: PW } });
  expect(set.status).toBe(200);
  return { r, ...sessionOf(set), set };
}

describe('a gateway without a password behaves as today', () => {
  it('the account key is the credential; no page session is asked for', async () => {
    const r = await legacy();
    expect((await call(r.port, 'GET', '/api/poll', { headers: { 'x-api-key': KEY } })).status).toBe(200);
    expect((await call(r.port, 'POST', '/api/action', { headers: { 'x-api-key': KEY }, origin: 'http://evil.example' })).status).toBe(200);
    expect((await call(r.port, 'GET', '/api/poll')).status).toBe(401);
    expect((await call(r.port, 'GET', '/events?key=' + KEY)).status).toBe(200);
  });

  it('a connector login can be replaced or removed with no confirmation', async () => {
    const r = await legacy();
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: { 'x-api-key': KEY }, body: { token: 'new' } })).status).toBe(200);
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: { 'x-api-key': KEY } })).status).toBe(200);
  });

  it('reports no password', async () => {
    const r = await legacy();
    expect((await call(r.port, 'GET', '/auth/password/status')).body).toEqual({ passwordSet: false });
  });
});

describe('setting the password', () => {
  it('needs the account key on an unlocked vault, and a password of 10+ characters', async () => {
    const r = await legacy();
    expect((await call(r.port, 'POST', '/auth/password/set', { body: { password: PW } })).status).toBe(401);
    expect((await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': 'wrong' }, body: { password: PW } })).status).toBe(401);
    expect((await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: 'short' } })).body.code).toBe('password_invalid');
    expect(r.vault.hasPassword()).toBe(false);
  });

  it('keeps every credential, opens a page session with a HttpOnly SameSite=Strict host-only cookie, and ends account-key access', async () => {
    const { r, set, token, cookie } = await withPassword();
    const sc = String(set.headers['set-cookie']);
    expect(sc).toContain('HttpOnly'); expect(sc).toContain('SameSite=Strict'); expect(sc.toLowerCase()).not.toContain('domain');
    expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    expect((await call(r.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(200);
    // the account key no longer opens this gateway's own routes
    expect((await call(r.port, 'GET', '/api/poll', { headers: { 'x-api-key': KEY } })).status).toBe(401);
    expect((await call(r.port, 'GET', '/events?key=' + KEY)).status).toBe(401);
  });

  it('is refused when the control plane listens beyond this machine', async () => {
    const r = await legacy();
    await r.close(); open.pop();
    const r2 = await rig(r.dir, { loopbackOnly: false });
    await r2.vault.deriveAndSetKey(KEY);
    expect((await call(r2.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: PW } })).body.code).toBe('not_local');
  });
});

describe('page session on every request', () => {
  it('needs the cookie AND the header token', async () => {
    const { r, token, cookie } = await withPassword();
    expect((await call(r.port, 'GET', '/api/poll', { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })).status).toBe(401);
    expect((await call(r.port, 'GET', '/api/poll', { headers: { [SESSION_HEADER]: token } })).status).toBe(401);
    expect((await call(r.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(200);
  });

  it('refuses a foreign Origin, a foreign Host, and a change without an Origin, even with both secrets', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    expect((await call(r.port, 'POST', '/api/action', { headers: h, origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(r.port, 'POST', '/api/action', { headers: h, origin: `http://127.0.0.1:${r.port + 1}` })).status).toBe(403);
    expect((await call(r.port, 'POST', '/api/action', { headers: h, origin: null })).status).toBe(403);
    expect((await call(r.port, 'GET', '/api/poll', { headers: h, host: 'evil.example' })).status).toBe(403);
    expect((await call(r.port, 'POST', '/api/action', { headers: h })).status).toBe(200);
  });

  it('is refused when the control plane listens beyond this machine', async () => {
    const { r, token, cookie } = await withPassword();
    r.deps.listensOnLoopbackOnly = false;
    expect((await call(r.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(403);
  });

  it('ends when the vault locks (sign-out, expiry, mismatch lock)', async () => {
    const { r, token, cookie } = await withPassword();
    r.vault.lockExpired();
    expect(r.sessions.count()).toBe(0);
    expect((await call(r.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(401);
  });
});

describe('session limits through the real routes (clock moved)', () => {
  it('an hour without use: the next request is refused', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    r.clock.advance(IDLE_LIMIT_MS - MIN);
    expect((await call(r.port, 'POST', '/api/action', { headers: h })).status).toBe(200);
    r.clock.advance(IDLE_LIMIT_MS + MIN);
    const refused = await call(r.port, 'POST', '/api/action', { headers: h });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('session_idle');
  });

  it('polling and the event stream for an hour do not keep it open', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    for (let i = 0; i < 11; i++) {
      r.clock.advance(5 * MIN);
      expect((await call(r.port, 'GET', '/api/poll', { headers: h })).status).toBe(200);
      expect((await call(r.port, 'GET', '/events', { headers: h })).status).toBe(200);
    }
    r.clock.advance(5 * MIN);
    expect((await call(r.port, 'GET', '/api/poll', { headers: h })).body.code).toBe('session_idle');
  });

  it('opening a card counts as use', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    for (let i = 0; i < 4; i++) {
      r.clock.advance(50 * MIN);
      expect((await call(r.port, 'GET', '/proposal-status/p1/preview', { headers: h })).status).toBe(200);
    }
  });

  it('after 12 hours it ends whatever the use', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    let last: Reply | null = null;
    for (let i = 0; i < 25; i++) {
      r.clock.advance(30 * MIN);
      last = await call(r.port, 'POST', '/api/action', { headers: h });
      if (last.status !== 200) break;
    }
    expect(last!.status).toBe(401);
    expect(last!.body.code).toBe('session_expired');
  });

  it('a restart ends it, and only the password opens the vault again', async () => {
    const { r, token, cookie } = await withPassword();
    await r.close(); open.pop();
    const again = await rig(r.dir);                       // new process, same data dir
    expect(again.vault.isUnlocked()).toBe(false);
    expect((await call(again.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(401);
    expect((await call(again.port, 'GET', '/api/poll', { headers: { 'x-api-key': KEY } })).status).toBe(401);
    const unlock = await call(again.port, 'POST', '/auth/unlock', { body: { password: PW } });
    expect(unlock.status).toBe(200);
    const s = sessionOf(unlock);
    expect((await call(again.port, 'GET', '/api/poll', { headers: sessionHeaders(s.token, s.cookie) })).status).toBe(200);
    expect(again.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('screen lock, sleep and user switch end it (simulated signal through the internal route)', async () => {
    for (const signal of ['screen-lock', 'sleep', 'user-switch']) {
      const { r, token, cookie } = await withPassword();
      expect((await call(r.port, 'POST', '/internal/os-signal', { headers: { 'x-internal-secret': 'wrong' }, body: { signal } })).status).toBe(401);
      expect((await call(r.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(200);
      expect((await call(r.port, 'POST', '/internal/os-signal', { headers: { 'x-internal-secret': 'sekret' }, body: { signal } })).status).toBe(200);
      expect(r.osSignals).toEqual([signal]);
      expect((await call(r.port, 'GET', '/api/poll', { headers: sessionHeaders(token, cookie) })).status).toBe(401);
      // the vault itself stays unlocked: the agent keeps working inside its mandates
      expect(r.vault.isUnlocked()).toBe(true);
      // and the password opens a new session
      const again = await call(r.port, 'POST', '/auth/unlock', { body: { password: PW } });
      expect(again.status).toBe(200);
    }
  });

  it('an unknown signal is refused', async () => {
    const { r } = await withPassword();
    expect((await call(r.port, 'POST', '/internal/os-signal', { headers: { 'x-internal-secret': 'sekret' }, body: { signal: 'nope' } })).status).toBe(400);
  });
});

describe('unlock with the password', () => {
  async function restarted() {
    const { r } = await withPassword();
    await r.close(); open.pop();
    return rig(r.dir);
  }

  it('a wrong password is refused and the vault stays locked', async () => {
    const g = await restarted();
    const res = await call(g.port, 'POST', '/auth/unlock', { body: { password: 'wrong password!!' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('wrong_password');
    expect(g.vault.isUnlocked()).toBe(false);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is rate-limited: after 5 wrong tries even the right password is refused, until the wait has passed', async () => {
    const g = await restarted();
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: `wrong password ${i}` } })).status).toBe(401);
    }
    const blocked = await call(g.port, 'POST', '/auth/unlock', { body: { password: PW } });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('too_many_attempts');
    expect(g.vault.isUnlocked()).toBe(false);
    g.clock.advance(BASE_LOCKOUT_MS + 1000);
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: PW } })).status).toBe(200);
    expect(g.vault.isUnlocked()).toBe(true);
  });

  it('the wait grows with further failures', async () => {
    const g = await restarted();
    for (let i = 0; i < FREE_ATTEMPTS; i++) await call(g.port, 'POST', '/auth/unlock', { body: { password: `wrong password ${i}` } });
    g.clock.advance(BASE_LOCKOUT_MS + 1000);
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: 'wrong again!!' } })).status).toBe(401);
    g.clock.advance(BASE_LOCKOUT_MS + 1000);                      // the first wait is not enough any more
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: PW } })).status).toBe(429);
  });

  it('is refused from a foreign Origin or Host, and where no password is set', async () => {
    const g = await restarted();
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: PW }, origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: PW }, host: 'evil.example' })).status).toBe(403);
    const fresh = await rig();
    expect((await call(fresh.port, 'POST', '/auth/unlock', { body: { password: PW } })).body.code).toBe('no_password');
  });
});

describe('changing the password', () => {
  it('needs the page session and the current password, keeps every credential, and the old password stops working', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const body = { currentPassword: PW, newPassword: 'another long password' };
    expect((await call(r.port, 'POST', '/auth/password/change', { body })).status).toBe(401);                          // no session
    expect((await call(r.port, 'POST', '/auth/password/change', { headers: h, body: { ...body, currentPassword: 'not the one!!' } })).status).toBe(401);
    expect((await call(r.port, 'POST', '/auth/password/change', { headers: h, body: { ...body, newPassword: 'short' } })).body.code).toBe('password_invalid');
    expect((await call(r.port, 'POST', '/auth/password/change', { headers: h, body })).status).toBe(200);

    await r.close(); open.pop();
    const g = await rig(r.dir);
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: PW } })).status).toBe(401);
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: 'another long password' } })).status).toBe(200);
    expect(g.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('wrong current passwords count against the same limit', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      await call(r.port, 'POST', '/auth/password/change', { headers: h, body: { currentPassword: `wrong password ${i}`, newPassword: 'another long password' } });
    }
    expect((await call(r.port, 'POST', '/auth/password/change', { headers: h, body: { currentPassword: PW, newPassword: 'another long password' } })).status).toBe(429);
  });
});

describe('the account key and a vault that has a password', () => {
  function stubAs(user: { id: string; did: string }) {
    stubNetwork(url => url.includes('/api/auth/session')
      ? { ok: true, status: 200, headers: { getSetCookie: () => ['hap-session=s; Path=/; HttpOnly'] }, json: async () => ({ user, sessionExpiresAt: 1_800_000_000 }) }
      : null);
  }

  it('the wipe-and-claim journey with another account\'s key is refused, and nothing is wiped', async () => {
    const { r, token, cookie } = await withPassword();
    const keyBefore = r.vault.getVaultKeyHex();
    const res = await call(r.port, 'POST', '/auth/login', { headers: { ...sessionHeaders(token, cookie), 'x-api-key': 'hap_someone_else' }, body: { confirmWipe: true } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('wipe_refused');
    expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    expect(r.vault.getVaultKeyHex()).toBe(keyBefore);
    expect(r.vault.hasPassword()).toBe(true);
  });

  it('after a restart the account key cannot open the vault: login needs the password-unlocked page session first', async () => {
    const { r } = await withPassword();
    await r.close(); open.pop();
    const g = await rig(r.dir);
    stubAs({ id: 'u1', did: 'did:key:u1' });
    const res = await call(g.port, 'POST', '/auth/login', { headers: { 'x-api-key': KEY }, body: {} });
    expect(res.status).toBe(401);
    expect(g.vault.isUnlocked()).toBe(false);
    expect(g.vault.hasPassword()).toBe(true);
  });

  it('a different account signing in on a password vault is refused; the same account signs in without touching the vault', async () => {
    const { r, token, cookie } = await withPassword();
    const h = { ...sessionHeaders(token, cookie), 'x-api-key': 'hap_someone_else' };
    const keyBefore = r.vault.getVaultKeyHex();

    stubAs({ id: 'u-other', did: 'did:key:other' });
    const other = await call(r.port, 'POST', '/auth/login', { headers: h, body: {} });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('account_mismatch');
    expect(r.vault.getSpCookie()).toBeNull();

    stubAs({ id: 'u1', did: 'did:key:u1' });
    const same = await call(r.port, 'POST', '/auth/login', { headers: { ...h, 'x-api-key': KEY }, body: {} });
    expect(same.status).toBe(200);
    expect(r.vault.getSpCookie()).toContain('hap-session=s');
    expect(r.vault.getVaultKeyHex()).toBe(keyBefore);
    expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    expect(r.vault.unsealedByProvider()).toBe('password');
  });
});


const PUT = (fields: Record<string, string>) => ({ route: 'credentials', op: 'put-merge', fields });
const DEL = { route: 'credentials', op: 'delete' };

/** A confirmed request for one exact change; returns its request id. */
async function confirmed(r: Rig, h: Record<string, string>, kind: string, name: string, change: unknown = null, password = PW) {
  const req = await call(r.port, 'POST', '/auth/confirm/request', { headers: h, body: { kind, name, change } });
  expect(req.status).toBe(200);
  const request = req.body.request as { request_id: string; kind: string; change_hash: string; gateway_key_id: null; expires_at: number };
  const conf = await call(r.port, 'POST', '/auth/confirm', { headers: h, body: { request_id: request.request_id, password } });
  return { request, conf, id: request.request_id };
}
const withConf = (h: Record<string, string>, id: string) => ({ ...h, [CONFIRMATION_HEADER]: id });

describe('replacing or removing a connector login: enforced where the vault router writes', () => {
  const untouched = (r: Rig) => expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });

  it('entering a login for the first time needs no confirmation', async () => {
    const { r, token, cookie } = await withPassword();
    const res = await call(r.port, 'PUT', '/vault/credentials/crm', { headers: sessionHeaders(token, cookie), body: { key: 'k' } });
    expect(res.status).toBe(200);
    expect(r.vault.getCredential('crm')).toMatchObject({ key: 'k' });
  });

  it('every way of reaching the replace or remove is refused without a confirmation, and nothing changes (dryRun, trailing slash, other case, services)', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const svc = { name: 'g', description: 'd', credFields: [], credentials: { token: 'x' } };
    const tries: Array<[string, string, unknown]> = [
      ['PUT', '/vault/credentials/gmail', { token: 'x' }],
      ['PUT', '/vault/credentials/gmail?dryRun=1', { token: 'x' }],
      ['PUT', '/vault/credentials/gmail?dryRun=true', { token: 'x' }],
      ['PUT', '/vault/credentials/gmail/', { token: 'x' }],
      ['PUT', '/vault/Credentials/gmail', { token: 'x' }],
      ['PUT', '/vault/CREDENTIALS/gmail/', { token: 'x' }],
      ['PUT', '/vault/services/gmail', svc],
      ['PUT', '/vault/services/gmail/', svc],
      ['DELETE', '/vault/credentials/gmail', undefined],
      ['DELETE', '/vault/credentials/gmail/', undefined],
      ['DELETE', '/vault/Credentials/gmail', undefined],
      ['DELETE', '/vault/services/gmail', undefined],
      ['DELETE', '/vault/services/gmail/', undefined],
    ];
    for (const [m, p, body] of tries) {
      const res = await call(r.port, m, p, { headers: h, body });
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(res.body.code).toBe('confirmation_required');
      untouched(r);
    }
  });

  it('a request is built for one exact change: {request_id, kind, change_hash, gateway_key_id, expires_at}; request_id is 16 random bytes', async () => {
    const { r, token, cookie } = await withPassword();
    const { request } = await confirmed(r, sessionHeaders(token, cookie), 'replace', 'gmail', PUT({ token: 'a' }));
    expect(Object.keys(request).sort()).toEqual(['change_hash', 'expires_at', 'gateway_key_id', 'kind', 'request_id']);
    expect(Buffer.from(request.request_id, 'base64url')).toHaveLength(16);
    expect(request.change_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(request.expires_at - r.clock.now()).toBe(CONFIRMATION_TTL_MS);
  });

  it('the confirmation fits exactly that change, once', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const a = await confirmed(r, h, 'replace', 'gmail', PUT({ token: 'a' }));
    expect(a.conf.status).toBe(200);
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, a.id), body: { token: 'b' } })).status).toBe(403);
    untouched(r);
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, a.id), body: { token: 'a' } })).status).toBe(403); // spent

    const b = await confirmed(r, h, 'replace', 'gmail', PUT({ token: 'a' }));
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, b.id), body: { token: 'a' } })).status).toBe(200);
    expect(r.vault.getCredential('gmail')).toMatchObject({ token: 'a' });
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, b.id), body: { token: 'a' } })).status).toBe(403);
  });

  it('a different token, one never confirmed, one for another login or another kind, is refused', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, 'Zm9yZ2VkLXRva2Vu'), body: { token: 'x' } })).status).toBe(403);
    const req = await call(r.port, 'POST', '/auth/confirm/request', { headers: h, body: { kind: 'remove', name: 'gmail' } });
    const id = (req.body.request as { request_id: string }).request_id;
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(h, id) })).status).toBe(403);
    const rm = await confirmed(r, h, 'remove', 'gmail', DEL);
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, rm.id), body: {} })).status).toBe(403);
    const rm2 = await confirmed(r, h, 'remove', 'gmail', DEL);
    expect((await call(r.port, 'DELETE', '/vault/credentials/cal', { headers: withConf(h, rm2.id) })).status).toBe(403);
    untouched(r);
    const rm3 = await confirmed(r, h, 'remove', 'gmail', DEL);
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(h, rm3.id) })).status).toBe(200);
    expect(r.vault.getCredential('gmail')).toBeNull();
  });

  it('is tied to the page session that asked: another session cannot use it', async () => {
    const { r, token, cookie } = await withPassword();
    const c = await confirmed(r, sessionHeaders(token, cookie), 'remove', 'gmail', DEL);
    const second = sessionOf(await call(r.port, 'POST', '/auth/unlock', { body: { password: PW } }));
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(sessionHeaders(second.token, second.cookie), c.id) })).status).toBe(403);
    untouched(r);
  });

  it('a wrong password gives no confirmation; the request ends after 300 seconds', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const bad = await confirmed(r, h, 'remove', 'gmail', DEL, 'not the password');
    expect(bad.conf.status).toBe(401);
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(h, bad.id) })).status).toBe(403);

    const c = await confirmed(r, h, 'remove', 'gmail', DEL);
    r.clock.advance(CONFIRMATION_TTL_MS - 1000);
    expect((await call(r.port, 'POST', '/api/action', { headers: h })).status).toBe(200);
    r.clock.advance(2000);
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(h, c.id) })).status).toBe(403);
    untouched(r);
  });

  it('on a computer with a check key the password is not a confirmation', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    r.setCheckKey(true);
    const c = await confirmed(r, h, 'remove', 'gmail', DEL);
    expect(c.conf.status).toBe(409);
    expect(c.conf.body.code).toBe('check_key_required');
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(h, c.id) })).status).toBe(403);
  });

  it('requesting and confirming need the page session, and password tries count against the limit', async () => {
    const { r, token, cookie } = await withPassword();
    expect((await call(r.port, 'POST', '/auth/confirm/request', { body: { kind: 'remove', name: 'gmail' } })).status).toBe(401);
    const h = sessionHeaders(token, cookie);
    const req = await call(r.port, 'POST', '/auth/confirm/request', { headers: h, body: { kind: 'remove', name: 'gmail' } });
    const id = (req.body.request as { request_id: string }).request_id;
    for (let i = 0; i < FREE_ATTEMPTS; i++) await call(r.port, 'POST', '/auth/confirm', { headers: h, body: { request_id: id, password: `wrong password ${i}` } });
    expect((await call(r.port, 'POST', '/auth/confirm', { headers: h, body: { request_id: id, password: PW } })).status).toBe(429);
  });
});

describe('OAuth sign-in on a vault with a password (real routes)', () => {
  const startPath = (id: string) => `/auth/oauth/${id}/start`;
  const changeOf = async (r: Rig, h: Record<string, string>, id: string, op = 'sign-in') =>
    (await call(r.port, 'GET', `/auth/oauth/${id}/change?op=${op}`, { headers: h })).body.change;
  const ticket = (r: Rig, h: Record<string, string>, id: string) => call(r.port, 'POST', `/auth/oauth/${id}/start-ticket`, { headers: h, body: {} });
  const cookieOnly = (cookie: string) => ({ cookie: `${SESSION_COOKIE}=${cookie}` });

  it('without a password nothing changes: start needs no session, the account key signs out', async () => {
    const r = await legacy();
    const start = await call(r.port, 'GET', startPath('cal'));
    expect(start.status).toBe(302);
    expect(String(start.headers.location)).toContain('provider.example/auth');
    expect((await call(r.port, 'POST', '/auth/oauth/cal/start-ticket', { headers: { 'x-api-key': KEY } })).body.url).toBe(startPath('cal'));
    const out = await call(r.port, 'POST', '/auth/oauth/cal/disconnect', { headers: { 'x-api-key': KEY } });
    expect(out.status).toBe(200);
    expect(r.vault.getCredential('cal')).not.toHaveProperty('refreshToken');
  });

  it('a real browser can start it: a ticket from the page (with its header), then the new window with the cookie only', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    // 'mail' has its client set up but no stored sign-in, and neither has its group: no confirmation needed
    r.vault.setCredential('mail', { clientId: 'cid', clientSecret: 'csec' });
    const t = await ticket(r, h, 'mail');
    expect(t.status).toBe(200);
    const url = String(t.body.url);
    expect(url).toMatch(/^\/auth\/oauth\/mail\/start\?ticket=/);
    const start = await call(r.port, 'GET', url, { headers: cookieOnly(cookie) });
    expect(start.status).toBe(302);
    expect(String(start.headers.location)).toContain('provider.example/auth');
  });

  it('start refuses: no ticket, a ticket without the cookie, another session\'s ticket, a spent or expired ticket, or a ticket for another connector', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const url = String((await ticket(r, h, 'mail')).body.url);
    expect((await call(r.port, 'GET', startPath('mail'))).status).toBe(401);                                  // nothing
    expect((await call(r.port, 'GET', startPath('mail'), { headers: cookieOnly(cookie) })).status).toBe(403);  // cookie, no ticket
    expect((await call(r.port, 'GET', url)).status).toBe(401);                                                 // ticket, no cookie
    expect((await call(r.port, 'GET', url, { headers: { 'x-api-key': KEY } })).status).toBe(401);
    const second = sessionOf(await call(r.port, 'POST', '/auth/unlock', { body: { password: PW } }));
    expect((await call(r.port, 'GET', url, { headers: cookieOnly(second.cookie) })).status).toBe(403);        // another session (and the ticket is spent)
    expect((await call(r.port, 'GET', url, { headers: cookieOnly(cookie) })).status).toBe(403);               // spent
    const fresh = String((await ticket(r, h, 'mail')).body.url);
    expect((await call(r.port, 'GET', fresh.replace('/mail/', '/calendar/'), { headers: cookieOnly(cookie) })).status).toBe(403); // wrong connector
    const old = String((await ticket(r, h, 'mail')).body.url);
    r.clock.advance(61_000);
    expect((await call(r.port, 'GET', old, { headers: cookieOnly(cookie) })).status).toBe(403);               // expired
  });

  it('the ticket needs the page\'s header token', async () => {
    const { r, token, cookie } = await withPassword();
    expect((await call(r.port, 'POST', '/auth/oauth/mail/start-ticket', { headers: cookieOnly(cookie), body: {} })).status).toBe(401);
    expect((await call(r.port, 'POST', '/auth/oauth/mail/start-ticket', { headers: { [SESSION_HEADER]: token }, body: {} })).status).toBe(401);
  });

  it('signing in again over a stored sign-in needs the confirmation of exactly that change; the callback then stores the token', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    expect((await ticket(r, h, 'cal')).status).toBe(403);
    const change = await changeOf(r, h, 'cal');
    expect(change).toEqual({ route: 'oauth', op: 'sign-in', integration: 'cal', group: null, replaces: ['cal'] });
    const c = await confirmed(r, h, 'replace', 'cal', change);
    const t = await call(r.port, 'POST', '/auth/oauth/cal/start-ticket', { headers: withConf(h, c.id), body: {} });
    expect(t.status).toBe(200);
    const start = await call(r.port, 'GET', String(t.body.url), { headers: cookieOnly(cookie) });
    expect(start.status).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const cb = await call(r.port, 'GET', `/auth/oauth/cal/callback?code=abc&state=${state}`);   // from the provider: no page session
    expect(cb.status).toBe(200);
    expect(r.vault.getCredential('cal')).toMatchObject({ refreshToken: 'new-refresh-token' });
  });

  it('a confirmation for another change, or the old shape, does not give a ticket', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const wrong = await confirmed(r, h, 'replace', 'cal', { oauth: 'sign-in' });
    expect((await call(r.port, 'POST', '/auth/oauth/cal/start-ticket', { headers: withConf(h, wrong.id), body: {} })).status).toBe(403);
    const disc = await confirmed(r, h, 'remove', 'cal', await changeOf(r, h, 'cal', 'disconnect'));
    expect((await call(r.port, 'POST', '/auth/oauth/cal/start-ticket', { headers: withConf(h, disc.id), body: {} })).status).toBe(403);
  });

  it('GROUP: signing in from a member with no token counts every member\'s stored sign-in; the callback never retires an unconfirmed one', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    r.vault.setCredential('mail', { clientId: 'cid', clientSecret: 'csec' });                       // member A: no token
    r.vault.setCredential('calendar', { clientId: 'cid', clientSecret: 'csec', refreshToken: 'CALENDAR-TOKEN' }); // member B: has one
    expect(await changeOf(r, h, 'mail')).toMatchObject({ group: 'google', replaces: ['calendar'] });
    expect((await ticket(r, h, 'mail')).status).toBe(403);

    // a callback whose state was NOT confirmed at start must not strip member B
    const state = r.oauthStates.issue({ integrationId: 'mail', redirectUri: 'http://127.0.0.1:1/auth/oauth/mail/callback' });
    const cb = await call(r.port, 'GET', `/auth/oauth/mail/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(403);
    expect(r.vault.getCredential('calendar')).toMatchObject({ refreshToken: 'CALENDAR-TOKEN' });
    expect(r.vault.getCredential('sign-in:google')).toBeNull();
  });

  it('GROUP: a callback is accepted only for what was confirmed: a sign-in that appeared after the confirmation is not overwritten', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    r.vault.setCredential('mail', { clientId: 'cid', clientSecret: 'csec', refreshToken: 'MAIL-TOKEN' });
    const c = await confirmed(r, h, 'replace', 'mail', await changeOf(r, h, 'mail'));
    const t = await call(r.port, 'POST', '/auth/oauth/mail/start-ticket', { headers: withConf(h, c.id), body: {} });
    const start = await call(r.port, 'GET', String(t.body.url), { headers: cookieOnly(cookie) });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    r.vault.setCredential('calendar', { clientId: 'cid', clientSecret: 'csec', refreshToken: 'LATE-TOKEN' }); // appears meanwhile
    expect((await call(r.port, 'GET', `/auth/oauth/mail/callback?code=abc&state=${state}`)).status).toBe(403);
    expect(r.vault.getCredential('calendar')).toMatchObject({ refreshToken: 'LATE-TOKEN' });
  });

  it('the callback must arrive within 300 seconds of the confirmation', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const c = await confirmed(r, h, 'replace', 'cal', await changeOf(r, h, 'cal'));
    const t = await call(r.port, 'POST', '/auth/oauth/cal/start-ticket', { headers: withConf(h, c.id), body: {} });
    const start = await call(r.port, 'GET', String(t.body.url), { headers: cookieOnly(cookie) });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    r.clock.advance(CALLBACK_WINDOW_MS + 1000);
    expect((await call(r.port, 'GET', `/auth/oauth/cal/callback?code=abc&state=${state}`)).status).toBe(403);
    expect(r.vault.getCredential('cal')).toMatchObject({ refreshToken: 'old-refresh-token' });
  });

  it('signing out is a removal covering everything it removes: refused without a confirmation of that exact change; allowed with one', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const refused = await call(r.port, 'POST', '/auth/oauth/cal/disconnect', { headers: h });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('confirmation_required');
    expect(r.vault.getCredential('cal')).toMatchObject({ refreshToken: 'old-refresh-token' });
    expect((await call(r.port, 'POST', '/auth/oauth/cal/disconnect', { headers: { 'x-api-key': KEY } })).status).toBe(401);

    const c = await confirmed(r, h, 'remove', 'cal', await changeOf(r, h, 'cal', 'disconnect'));
    expect((await call(r.port, 'POST', '/auth/oauth/cal/disconnect', { headers: withConf(h, c.id) })).status).toBe(200);
    expect(r.vault.getCredential('cal')).not.toHaveProperty('refreshToken');
  });
});

describe('a sign-in group entry is a stored login (the real vault router)', () => {
  const GROUP = 'sign-in:google';

  it('writing the group entry over members\' stored sign-ins is refused without a confirmation; nothing is pushed or stored', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    r.vault.setCredential('mail', { refreshToken: 'MAIL-TOKEN' });
    r.vault.setCredential('calendar', { refreshToken: 'CAL-TOKEN' });
    const res = await call(r.port, 'PUT', `/vault/credentials/${GROUP}`, { headers: h, body: { clientId: 'x', clientSecret: 'y', refreshToken: 'ATTACKER' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('confirmation_required');
    expect(r.vault.getCredential(GROUP)).toBeNull();
    expect((await call(r.port, 'DELETE', `/vault/credentials/${GROUP}`, { headers: h })).status).toBe(403);
  });

  it('a group entry with no stored sign-in anywhere is still a first entry', async () => {
    const { r, token, cookie } = await withPassword();
    const res = await call(r.port, 'PUT', `/vault/credentials/${GROUP}`, { headers: sessionHeaders(token, cookie), body: { clientId: 'x', clientSecret: 'y' } });
    expect(res.status).toBe(200);
  });

  it('with the right confirmation it goes through, once', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    r.vault.setCredential('mail', { refreshToken: 'MAIL-TOKEN' });
    const body = { clientId: 'x', clientSecret: 'y' };
    const c = await confirmed(r, h, 'replace', GROUP, PUT(body));
    expect((await call(r.port, 'PUT', `/vault/credentials/${GROUP}`, { headers: withConf(h, c.id), body })).status).toBe(200);
    expect((await call(r.port, 'PUT', `/vault/credentials/${GROUP}`, { headers: withConf(h, c.id), body })).status).toBe(403);
  });
});

describe('a confirmation is bound to the exact operation (route included)', () => {
  const svc = (credentials: Record<string, string>) => ({ name: 'g', description: 'd', credFields: [], credentials });

  it('one for credentials merge does not allow a services replace of the same data, nor the other way round', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const data = { token: 'a' };
    const merge = await confirmed(r, h, 'replace', 'gmail', PUT(data));
    expect((await call(r.port, 'PUT', '/vault/services/gmail', { headers: withConf(h, merge.id), body: svc(data) })).status).toBe(403);
    const replace = await confirmed(r, h, 'replace', 'gmail', { route: 'services', op: 'put-replace', credentials: data });
    expect((await call(r.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(h, replace.id), body: data })).status).toBe(403);
    expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    const ok = await confirmed(r, h, 'replace', 'gmail', { route: 'services', op: 'put-replace', credentials: data });
    expect((await call(r.port, 'PUT', '/vault/services/gmail', { headers: withConf(h, ok.id), body: svc(data) })).status).toBe(200);
    expect(r.vault.getCredential('gmail')).toEqual(data);
  });

  it('one for deleting the credential does not delete the service, and the other way round', async () => {
    const { r, token, cookie } = await withPassword();
    const h = sessionHeaders(token, cookie);
    const a = await confirmed(r, h, 'remove', 'gmail', DEL);
    expect((await call(r.port, 'DELETE', '/vault/services/gmail', { headers: withConf(h, a.id) })).status).toBe(403);
    const b = await confirmed(r, h, 'remove', 'gmail', { route: 'services', op: 'delete' });
    expect((await call(r.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(h, b.id) })).status).toBe(403);
    expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    const c = await confirmed(r, h, 'remove', 'gmail', { route: 'services', op: 'delete' });
    expect((await call(r.port, 'DELETE', '/vault/services/gmail', { headers: withConf(h, c.id) })).status).toBe(200);
    expect(r.vault.getCredential('gmail')).toBeNull();
  });
});

describe('a login that was in flight cannot wipe a vault that just got a password', () => {
  it('the AS round-trip is slow, the password is set meanwhile: the login is refused and nothing is wiped', async () => {
    const r = await legacy();                                           // unlocked by the account key, user u1
    let release: () => void = () => {};
    const gate = new Promise<void>(res => { release = res; });
    let asCalled = false;
    stubNetwork(url => {
      if (!url.includes('/api/auth/session')) return null;
      asCalled = true;
      return gate.then(() => ({ ok: true, status: 200, headers: { getSetCookie: () => ['hap-session=s; Path=/; HttpOnly'] }, json: async () => ({ user: { id: 'u1', did: 'did:key:u1' }, sessionExpiresAt: 1_800_000_000 }) }));
    });
    // the same account signing in with a rotated key, confirming a wipe
    const login = call(r.port, 'POST', '/auth/login', { headers: { 'x-api-key': 'hap_rotated_key' }, body: { confirmWipe: true } });
    for (let i = 0; i < 100 && !asCalled; i++) await new Promise(res => setTimeout(res, 5));
    expect(asCalled).toBe(true);

    const set = await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: PW } });
    expect(set.status).toBe(200);
    release();
    const res = await login;
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('password_changed');
    expect(r.vault.hasPassword()).toBe(true);
    expect(r.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });
});

describe('moving to the password re-keys everything', () => {
  it('re-seals under a fresh key, tells the MCP server both keys, and the account key opens nothing afterwards', async () => {
    const r = await legacy();
    const oldHex = r.vault.getVaultKeyHex();
    const set = await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: PW } });
    expect(set.status).toBe(200);
    expect(r.rekeys).toHaveLength(1);
    expect(r.rekeys[0][0]).toBe(oldHex);
    expect(r.rekeys[0][1]).toBe(r.vault.getVaultKeyHex());
    expect(r.rekeys[0][1]).not.toBe(oldHex);

    await r.close(); open.pop();
    const g = await rig(r.dir);
    expect(g.vault.keyMatch(await g.vault.deriveCandidateFromApiKey(KEY))).toBe('conflict');
    expect((await call(g.port, 'POST', '/auth/unlock', { body: { password: PW } })).status).toBe(200);
    expect(g.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('when the MCP server cannot be reached the password is set, the marker stays, and the next unlock finishes it', async () => {
    const r = await legacy();
    r.failRekey(true);
    const set = await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: PW } });
    expect(set.status).toBe(202);
    expect(set.body.rekeyPending).toBe(true);
    expect(r.vault.hasPassword()).toBe(true);

    await r.close(); open.pop();
    const g = await rig(r.dir);
    const unlock = await call(g.port, 'POST', '/auth/unlock', { body: { password: PW } });
    expect(unlock.status).toBe(200);
    expect(unlock.body.rekeyPending).toBeUndefined();
    expect(g.rekeys).toHaveLength(1);
    expect(g.vault.hasPendingRekey()).toBe(false);
  });

  it('is refused when the signed-in account is unknown', async () => {
    const r = await legacy();
    r.vault.setSessionUser(null);
    const res = await call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: PW } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_signed_in');
    expect(r.vault.hasPassword()).toBe(false);
  });

  it('two parallel requests: one sets the password, the other is refused', async () => {
    const r = await legacy();
    const go = (pw: string) => call(r.port, 'POST', '/auth/password/set', { headers: { 'x-api-key': KEY }, body: { password: pw } });
    const [a, b] = await Promise.all([go(PW), go('another long password')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe('an open event stream ends with its session', () => {
  function stream(port: number, h: Record<string, string>) {
    return new Promise<{ ended: Promise<void> }>(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, ...h } }, res => {
        const ended = new Promise<void>(r => { res.on('end', () => r()); res.on('close', () => r()); });
        res.resume();
        resolve({ ended });
      });
      req.end();
    });
  }
  const within = (p: Promise<void>, ms: number) => Promise.race([p.then(() => 'ended'), new Promise(r => setTimeout(() => r('open'), ms))]);

  it('closes when the idle limit passes, with nothing else making a request', async () => {
    const { r, token, cookie } = await withPassword();
    const { ended } = await stream(r.port, sessionHeaders(token, cookie));
    expect(await within(ended, 100)).toBe('open');
    r.clock.advance(IDLE_LIMIT_MS + MIN);
    expect(await within(ended, 1000)).toBe('ended');
  });

  it('closes at once when the vault locks', async () => {
    const { r, token, cookie } = await withPassword();
    const { ended } = await stream(r.port, sessionHeaders(token, cookie));
    r.vault.lockExpired();
    expect(await within(ended, 1000)).toBe('ended');
  });
});
