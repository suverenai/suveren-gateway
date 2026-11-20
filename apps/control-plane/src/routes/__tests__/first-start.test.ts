/**
 * One-time start access (DEC-93) through the REAL routers, vault and sessions; only the Authority Server is the
 * stand-in (StubAs: the real routes' shapes, the enrolment code bound to the gateway key it was redeemed with).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, sessionOf, tmpDir, type Reply } from '../../__tests__/helpers/device-rig';
import { CLAIMED_MARKER, START_COOKIE, START_HEADER } from '../../lib/first-start';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });

const NEW_PW = 'a fresh unlock password';

async function pristine(opts: { enabled?: boolean; dir?: string } = {}) {
  const as = await new StubAs().listen();
  as.connectAuthorizeRefuses = false; // the browser step of Connect works (the real AS's, signed in)
  open.push(as);
  const dir = opts.dir ?? tmpDir();
  const gw = await bootGateway({ as, dir, fresh: false, ...(opts.enabled === false ? { enabled: false } : {}) });
  open.push(gw);
  return { as, gw, dir };
}

function startSessionOf(r: Reply): { cookie: string; token: string } {
  const set = String(r.headers['set-cookie']?.[0] ?? '');
  const m = new RegExp(`${START_COOKIE}=([^;]+)`).exec(set);
  return { cookie: m?.[1] ?? '', token: String(r.body.startToken ?? '') };
}
const startHeaders = (s: { cookie: string; token: string }): Record<string, string> => ({ cookie: `${START_COOKIE}=${s.cookie}`, [START_HEADER]: s.token });

/** Open a start session and run Connect through the stub's browser step. */
async function connected(w: Awaited<ReturnType<typeof pristine>>) {
  const opened = await call(w.gw.port, 'POST', '/auth/start/open', { body: {} });
  expect(opened.status).toBe(200);
  const s = startSessionOf(opened);
  const h = startHeaders(s);
  const c = await call(w.gw.port, 'POST', '/auth/start/connect', { headers: h, body: {} });
  expect(c.status).toBe(200);
  const q = Object.fromEntries(new URL(String(c.body.authorizeUrl)).searchParams) as { port: string; state: string; code_challenge: string };
  const back = new URL(w.as.authorize(q)!);
  const cb = await call(w.gw.port, 'GET', `${back.pathname}${back.search}`, {});
  expect(cb.status).toBe(200);
  return { s, h };
}

describe('DEC-93: a gateway nobody has used starts at Connect, without an account key', () => {
  it('Connect → password → set-up finishes with the enrolment code Connect got, bound to the key now in the vault', async () => {
    const w = await pristine();
    expect((await call(w.gw.port, 'GET', '/auth/start/status')).body).toEqual({ available: true });
    const { h } = await connected(w);
    const st = await call(w.gw.port, 'GET', '/auth/start/connect/status', { headers: h });
    expect(st.body).toMatchObject({ state: 'ready', account: { email: expect.any(String) } });
    // Claimed: the marker is on disk, and the start access is gone for anyone else.
    expect(existsSync(join(w.dir, CLAIMED_MARKER))).toBe(true);
    expect((await call(w.gw.port, 'GET', '/auth/start/status')).body).toEqual({ available: false });

    const pw = await call(w.gw.port, 'POST', '/auth/start/password', { headers: h, body: { password: NEW_PW } });
    expect(pw.status).toBe(200);
    expect(String(pw.headers['set-cookie'])).toContain(`${START_COOKIE}=;`);
    // The vault is bound to the account Connect named (the stub's user u1).
    expect(w.gw.vault.getPasswordAccountId()).toBe('u1');
    const page = sessionHeaders(sessionOf(pw));
    const status = await call(w.gw.port, 'GET', '/auth/device/status', { headers: page });
    expect(status.body).toMatchObject({ setUp: false, preConnected: { email: expect.any(String) } });

    const start = await call(w.gw.port, 'POST', '/auth/device/setup/start', { headers: page, body: {} });
    expect(start.status).toBe(200);
    const fin = await call(w.gw.port, 'POST', '/auth/device/setup/finish', { headers: page, body: { setupId: start.body.setupId } });
    // The stub refuses a genesis whose device key is not the one the enrolment code is bound to: this passing proves
    // the key made before the vault existed is the one the vault signs with.
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ ok: true, signedIn: true, account: { email: expect.any(String) } });
    expect(w.as.chainEntries()).toHaveLength(1);
    // The password opens the vault after a restart.
    expect(readFileSync(join(w.dir, 'vault.enc.json'), 'utf-8')).toContain('"password"');
  });

  it('the start session reaches nothing but the start routes', async () => {
    const w = await pristine();
    const opened = await call(w.gw.port, 'POST', '/auth/start/open', { body: {} });
    const h = startHeaders(startSessionOf(opened));
    for (const [m, p] of [
      ['GET', '/auth/device/status'], ['POST', '/auth/device/setup/start'], ['POST', '/auth/password/set'],
      ['POST', '/auth/password/change'], ['GET', '/api/x'], ['GET', '/vault/credentials'], ['POST', '/device-decision/p1/approve'],
    ] as const) {
      const r = await call(w.gw.port, m, p, { headers: h, body: m === 'POST' ? {} : undefined });
      expect([401, 403, 404, 409], `${m} ${p} -> ${r.status}`).toContain(r.status);
      expect(r.status, `${m} ${p}`).not.toBe(200);
    }
    // The start cookie alone (no header token) is not enough, and the header alone neither.
    const s = startSessionOf(opened);
    expect((await call(w.gw.port, 'POST', '/auth/start/connect', { headers: { cookie: `${START_COOKIE}=${s.cookie}` }, body: {} })).status).toBe(401);
    expect((await call(w.gw.port, 'POST', '/auth/start/connect', { headers: { [START_HEADER]: s.token }, body: {} })).status).toBe(401);
  });

  it('a foreign Origin or Host is refused', async () => {
    const w = await pristine();
    expect((await call(w.gw.port, 'POST', '/auth/start/open', { body: {}, origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(w.gw.port, 'POST', '/auth/start/open', { body: {}, host: 'evil.example' })).status).toBe(403);
    expect((await call(w.gw.port, 'POST', '/auth/start/open', { body: {}, origin: null })).status).toBe(403);
  });

  it('once claimed it is refused, also after a restart; another start session cannot go on', async () => {
    const w = await pristine();
    const other = startHeaders(startSessionOf(await call(w.gw.port, 'POST', '/auth/start/open', { body: {} })));
    await connected(w);
    expect((await call(w.gw.port, 'POST', '/auth/start/open', { body: {} })).status).toBe(409);
    // The session opened before the claim is out: it holds no Connect of its own.
    expect((await call(w.gw.port, 'POST', '/auth/start/connect', { headers: other, body: {} })).status).toBe(401);
    expect((await call(w.gw.port, 'POST', '/auth/start/password', { headers: other, body: { password: NEW_PW } })).status).toBe(401);
    // Restart before the password: memory is gone, the marker is not; no start access ever again.
    await w.gw.close();
    open.splice(open.indexOf(w.gw), 1);
    const gw2 = await bootGateway({ as: w.as, dir: w.dir, fresh: false });
    open.push(gw2);
    expect((await call(gw2.port, 'GET', '/auth/start/status')).body).toEqual({ available: false });
    expect((await call(gw2.port, 'POST', '/auth/start/open', { body: {} })).status).toBe(409);
  });

  it('a gateway with a vault (a password, or an account key) never offers it', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const withPw = await bootGateway({ as }); // fresh: a password vault
    open.push(withPw);
    expect((await call(withPw.port, 'GET', '/auth/start/status')).body).toEqual({ available: false });
    expect((await call(withPw.port, 'POST', '/auth/start/open', { body: {} })).status).toBe(409);
    const legacy = await bootGateway({ as, dir: tmpDir(), fresh: false });
    open.push(legacy);
    await legacy.vault.deriveAndSetKey('hap_account_key');
    expect((await call(legacy.port, 'GET', '/auth/start/status')).body).toEqual({ available: false });
  });

  it('the password step needs the Connect of this session, and a long enough password', async () => {
    const w = await pristine();
    const h = startHeaders(startSessionOf(await call(w.gw.port, 'POST', '/auth/start/open', { body: {} })));
    expect((await call(w.gw.port, 'POST', '/auth/start/password', { headers: h, body: { password: NEW_PW } })).body).toMatchObject({ code: 'connect_not_ready' });
    const c = await connected(w);
    expect((await call(w.gw.port, 'POST', '/auth/start/password', { headers: c.h, body: { password: 'short' } })).status).toBe(400);
    expect(w.gw.vault.hasPassword()).toBe(false);
  });

  it('with the switch off none of it exists', async () => {
    const w = await pristine({ enabled: false });
    for (const [m, p] of [['GET', '/auth/start/status'], ['POST', '/auth/start/open'], ['POST', '/auth/start/connect']] as const) {
      expect((await call(w.gw.port, m, p, { body: m === 'POST' ? {} : undefined })).status, `${m} ${p}`).toBe(404);
    }
    expect(existsSync(join(w.dir, CLAIMED_MARKER))).toBe(false);
  });
});
