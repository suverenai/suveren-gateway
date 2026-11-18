/**
 * Connect (device-keys plan 20.18, DEC-56), the gateway's side: state and PKCE
 * verifier kept server-side, the local /connect/callback on 127.0.0.1, the token
 * exchange with this computer's signing public key. Real routers and vault; the
 * Authority Server is StubAs (real request and response shapes, PKCE checked).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { b64uEncode } from '@hap/core/device-keys';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, type Reply } from '../../__tests__/helpers/device-rig';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { CONNECT_TTL_MS } from '../../lib/device-setup';
import { loadOrGenerateDeviceSigningKey } from '../../lib/e2e-key-manager';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });

async function world() {
  const as = await new StubAs().listen();
  open.push(as);
  const clock = { t: Math.floor(Date.now() / 1000) };
  const gw = await bootGateway({ as, clock });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const get = (path: string) => call(gw.port, 'GET', path, { headers: h });
  const start = await post('/auth/device/setup/start');
  const connect = await post('/auth/device/setup/connect', { setupId: start.body.setupId });
  const url = new URL(String(connect.body.authorizeUrl));
  const q = { port: url.searchParams.get('port')!, state: url.searchParams.get('state')!, code_challenge: url.searchParams.get('code_challenge')! };
  const pageReplies: Reply[] = [start, connect];
  const status = async () => { const r = await get(`/auth/device/setup/connect/status?setupId=${start.body.setupId}`); pageReplies.push(r); return r; };
  /** What the browser does after the person pressed Connect on suveren.ai: follow the redirect, with no gateway cookie. */
  const browserReturns = async (redirect: string | null, extra: Parameters<typeof call>[3] = {}) => {
    if (!redirect) throw new Error('the Authority Server refused');
    const u = new URL(redirect);
    return call(gw.port, 'GET', u.pathname + u.search, extra);
  };
  return { as, gw, clock, session, h, post, get, start, connect, url, q, status, browserReturns, pageReplies, setupId: start.body.setupId as string };
}

describe('Connect: starting', () => {
  it('hands back the Authority Server address with this server\'s port, a state and a PKCE challenge; the verifier stays inside', async () => {
    const w = await world();
    expect(w.connect.status).toBe(200);
    expect(w.url.origin).toBe(w.as.url);
    expect(w.url.pathname).toBe('/connect');
    expect(w.q.port).toBe(String(w.gw.port));
    expect(w.q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // only these three parameters; no code, no verifier, no redirect URL
    expect([...w.url.searchParams.keys()].sort()).toEqual(['code_challenge', 'port', 'state']);
    expect(w.connect.headers['cache-control']).toBe('no-store');
    expect((await w.status()).body).toMatchObject({ state: 'waiting' });
  });

  it('needs a started set-up and the page session', async () => {
    const w = await world();
    expect((await w.post('/auth/device/setup/connect', { setupId: 'nope' })).body.code).toBe('setup_unknown');
    expect((await call(w.gw.port, 'POST', '/auth/device/setup/connect', { body: { setupId: w.setupId } })).status).toBe(401);
    expect((await call(w.gw.port, 'POST', '/AUTH/device/setup/connect/', { body: { setupId: w.setupId } })).status).toBe(401);
  });
});

describe('Connect: the way back', () => {
  it('redeems the code with the verifier and this computer\'s signing key, then finishes with no pasted code', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const back = await w.browserReturns(w.as.authorize(w.q));
    expect(back.status).toBe(200);
    expect(back.headers['cache-control']).toBe('no-store');
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    // the callback says nothing about the account
    expect(back.text).not.toContain('person@example.test');

    const tokenCall = w.as.requests.find(r => r.path === '/api/connect/token')!;
    const sent = JSON.parse(tokenCall.body) as { code: string; code_verifier: string; gateway_key: string };
    const signing = await loadOrGenerateDeviceSigningKey(w.gw.vault);
    expect(sent.gateway_key).toBe(b64uEncode(signing.publicKey));
    expect(sent.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

    const st = await w.status();
    expect(st.body).toMatchObject({ state: 'ready', account: { name: 'Test Person', email: 'person@example.test' } });
    const fin = await w.post('/auth/device/setup/finish', { setupId: w.setupId });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ signedIn: true, account: { email: 'person@example.test' } });
    expect(new DeviceChainStore(w.gw.vault).read()?.keyId).toBe(w.start.body.deviceKeyId);

    // the genesis carried the Connect-issued code, bound to this key, and the chain holds this key
    const genesis = w.as.requests.find(r => r.method === 'POST' && r.path === '/api/devices/chain')!;
    expect(JSON.parse(genesis.body).enrolment_code).toBeTruthy();
    // the secrets of Connect never went to the page: no verifier, no authorisation code, no enrolment code
    const enrolment = JSON.parse(genesis.body).enrolment_code as string;
    for (const r of w.pageReplies) for (const secret of [sent.code_verifier, sent.code, enrolment]) expect(r.text).not.toContain(secret);
  });

  it('works without any gateway cookie or header token: the redirect from another site carries none', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const back = await w.browserReturns(w.as.authorize(w.q), { headers: {} });
    expect(back.status).toBe(200);
  });

  it('a wrong state does nothing and the right one still works afterwards', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const redirect = w.as.authorize(w.q)!;
    const u = new URL(redirect);
    const bad = new URL(redirect);
    bad.searchParams.set('state', b64uEncode(new Uint8Array(32).fill(1)));
    for (const path of [bad.pathname + bad.search, bad.pathname.toUpperCase() + bad.search, bad.pathname + '/' + bad.search]) {
      const r = await call(w.gw.port, 'GET', path);
      expect(r.status, path).toBe(400);
    }
    expect(w.as.requests.filter(r => r.path === '/api/connect/token')).toHaveLength(0);
    expect((await w.status()).body.state).toBe('waiting');
    expect((await call(w.gw.port, 'GET', u.pathname + u.search)).status).toBe(200);
    expect((await w.status()).body.state).toBe('ready');
  });

  it('a state works once: a replay of the same redirect is refused and changes nothing', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const redirect = w.as.authorize(w.q)!;
    const u = new URL(redirect);
    expect((await call(w.gw.port, 'GET', u.pathname + u.search)).status).toBe(200);
    expect((await call(w.gw.port, 'GET', u.pathname + u.search)).status).toBe(400);
    expect((await call(w.gw.port, 'GET', u.pathname.toUpperCase() + '/' + u.search)).status).toBe(400);
    expect(w.as.requests.filter(r => r.path === '/api/connect/token')).toHaveLength(1);
    expect((await w.status()).body.state).toBe('ready');
  });

  it('a state is refused after ten minutes', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const redirect = w.as.authorize(w.q)!;
    w.clock.t += CONNECT_TTL_MS / 1000 + 1;
    const u = new URL(redirect);
    expect((await call(w.gw.port, 'GET', u.pathname + u.search)).status).toBe(400);
    expect(w.as.requests.filter(r => r.path === '/api/connect/token')).toHaveLength(0);
  });

  it('a second Connect replaces the first: the first state no longer matches', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const first = w.as.authorize(w.q)!;
    const again = await w.post('/auth/device/setup/connect', { setupId: w.setupId });
    expect(new URL(String(again.body.authorizeUrl)).searchParams.get('state')).not.toBe(w.q.state);
    const u = new URL(first);
    expect((await call(w.gw.port, 'GET', u.pathname + u.search)).status).toBe(400);
  });

  it('odd query shapes (arrays, objects, empty, missing) are refused without a request to the Authority Server', async () => {
    const w = await world();
    for (const qs of ['', '?state=', `?state[]=${w.q.state}&code=x`, `?state[a]=${w.q.state}&code=x`, '?code=x', `?state=${w.q.state}&state=${w.q.state}&code=x`]) {
      const r = await call(w.gw.port, 'GET', `/connect/callback${qs}`);
      expect(r.status, qs).toBe(400);
    }
    expect(w.as.requests.filter(r => r.path === '/api/connect/token')).toHaveLength(0);
  });

  it('a foreign Host is refused (DNS rebinding), whatever the state', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    const u = new URL(w.as.authorize(w.q)!);
    const r = await call(w.gw.port, 'GET', u.pathname + u.search, { host: 'evil.example' });
    expect(r.status).toBe(403);
    expect((await call(w.gw.port, 'GET', u.pathname + u.search, { origin: 'http://evil.example' })).status).toBe(403);
    expect(w.as.requests.filter(r => r.path === '/api/connect/token')).toHaveLength(0);
    // the state was not used up by the refusals
    expect((await call(w.gw.port, 'GET', u.pathname + u.search)).status).toBe(200);
  });

  it('a PKCE mismatch at the Authority Server is a failed Connect with its code, and no enrolment code', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    // the code was issued for another challenge than the one this gateway made
    const other = b64uEncode(new Uint8Array(32).fill(9));
    await w.browserReturns(w.as.authorize({ ...w.q, code_challenge: other }));
    expect((await w.status()).body).toMatchObject({ state: 'failed', code: 'connect_refused', asCode: 'PKCE_MISMATCH' });
    expect((await w.post('/auth/device/setup/finish', { setupId: w.setupId })).body.code).toBe('enrolment_code_missing');
  });

  it('an error redirect (RFC 6749) is a failed Connect, with the Authority Server\'s code when it looks like one', async () => {
    const w = await world();
    const r = await call(w.gw.port, 'GET', `/connect/callback?state=${w.q.state}&error=CONNECT_SIGNIN_REQUIRED`);
    expect(r.status).toBe(200);
    expect((await w.status()).body).toMatchObject({ state: 'failed', code: 'connect_refused', asCode: 'CONNECT_SIGNIN_REQUIRED' });
  });

  it('an error redirect with a text that is not a code gives no code at all (nothing the AS wrote reaches the page)', async () => {
    const w = await world();
    await call(w.gw.port, 'GET', `/connect/callback?state=${w.q.state}&error=${encodeURIComponent('<script>alert(1)</script>')}`);
    const st = await w.status();
    expect(st.body).toMatchObject({ state: 'failed', code: 'connect_refused' });
    expect(st.body.asCode).toBeUndefined();
  });
});

describe('Connect: today the Authority Server refuses in the browser, and the gateway says so as a neutral code', () => {
  it('no way back: waiting, then connect_timeout after ten minutes; nothing was sent to the Authority Server', async () => {
    const w = await world();
    // the real AS refuses `authorize` for every session until the browser-bound Connect sign-in exists
    expect(w.as.authorize(w.q)).toBeNull();
    expect((await w.status()).body.state).toBe('waiting');
    w.clock.t += CONNECT_TTL_MS / 1000 + 1;
    expect((await w.status()).body).toMatchObject({ state: 'expired', code: 'connect_timeout' });
    expect(w.as.requests.filter(r => r.path === '/api/connect/token')).toHaveLength(0);
    // and the pasted code still finishes the same set-up
    const fin = await w.post('/auth/device/setup/finish', { setupId: w.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(200);
  });
});

describe('Connect: whose result it is', () => {
  it('only the page session that started Connect reads its status or uses its result', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    await w.browserReturns(w.as.authorize(w.q));
    const other = await w.gw.unlock(); // a second page session of the same person
    const oh = sessionHeaders(other);
    const peek = await call(w.gw.port, 'GET', `/auth/device/setup/connect/status?setupId=${w.setupId}`, { headers: oh });
    expect(peek.status).toBe(403);
    expect(peek.body.code).toBe('connect_other_session');
    expect(peek.text).not.toContain('person@example.test');
    const fin = await call(w.gw.port, 'POST', '/auth/device/setup/finish', { headers: oh, body: { setupId: w.setupId } });
    expect(fin.body.code).toBe('enrolment_code_missing');
    expect(new DeviceChainStore(w.gw.vault).exists()).toBe(false);
    // the starting session still can
    expect((await w.post('/auth/device/setup/finish', { setupId: w.setupId })).status).toBe(200);
  });

  it('with no page session the status is 401', async () => {
    const w = await world();
    expect((await call(w.gw.port, 'GET', `/auth/device/setup/connect/status?setupId=${w.setupId}`)).status).toBe(401);
    expect((await call(w.gw.port, 'GET', `/auth/DEVICE/setup/connect/status/?setupId=${w.setupId}`)).status).toBe(401);
  });

  it('a pasted code wins over a Connect result, and a bad pasted code is refused rather than falling back', async () => {
    const w = await world();
    w.as.connectAuthorizeRefuses = false;
    await w.browserReturns(w.as.authorize(w.q));
    const bad = await w.post('/auth/device/setup/finish', { setupId: w.setupId, enrolmentCode: 'garbage' });
    expect(bad.body).toMatchObject({ code: 'setup_refused', asCode: 'ENROLMENT_CODE_INVALID' });
    expect((await w.post('/auth/device/setup/finish', { setupId: w.setupId })).status).toBe(200);
  });
});
