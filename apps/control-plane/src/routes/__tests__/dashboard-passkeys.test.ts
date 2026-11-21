/**
 * Approving a dashboard passkey on this computer (plan 6.4 point 3; AS step 17, the device side): the list comes from the Authority
 * Server, the object is signed with this computer's key and its check (one touch) over exactly what the list named, and nothing
 * else the page sends is signed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as dk from '@hap/core/device-keys';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { PlatformHelper } from '../../lib/platform-helper';
import { PlatformChecks } from '../../lib/platform-checks';

const FAKE = fileURLToPath(new URL('../../../../../packages/unlock-helper/test/fake-helper.mjs', import.meta.url));

const open: Array<{ close: () => Promise<void> }> = [];
const hosts: PlatformHelper[] = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  for (const h of hosts.splice(0)) h.close();
  vi.restoreAllMocks();
});

const fakeHost = (env: Record<string, string>): PlatformHelper => {
  const h = new PlatformHelper({ locate: () => ({ spec: { command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, files: [] } }), idleMs: 30, touchTimeoutMs: 20_000 });
  hosts.push(h);
  return h;
};

const b64u = (n: number) => dk.b64uEncode(new Uint8Array(randomBytes(n)));
const RP = 'suveren.ai';

interface Pending { request_id: string; cred_id: string; rp_id: string; code: string; created_at: number; credential_at: number; expires_at: number; account: { email: string; name: string } }

async function world(o: { checkKey?: boolean } = {}) {
  const as = await new StubAs().listen();
  open.push(as);
  const now = () => Math.floor(Date.now() / 1000);
  const pending: Pending[] = [];
  const received: Array<Record<string, unknown>> = [];
  let verdict: { ok: boolean; why?: string } | null = null;
  as.extraRoutes = async c => {
    if (c.method === 'GET' && c.path === '/api/passkeys/register/pending') {
      if (!c.session) { c.refuse(401, 'UNAUTHORIZED'); return true; }
      c.json(200, { pending });
      return true;
    }
    if (c.method === 'POST' && c.path === '/api/passkeys/register') {
      if (!c.session) { c.refuse(401, 'UNAUTHORIZED'); return true; }
      received.push(c.body);
      // What the real Authority Server checks (dashboard-passkeys.ts approveRegistration), against the chain it holds.
      const reg = c.body.register as Record<string, unknown>;
      const state = await dk.verifyChain({ expectedRootDid: String(reg.root_did), entries: as.chainEntries() as never });
      const dev = state.devices[String(reg.key_id)];
      const sigOk = await dk.verifyEd25519(dk.b64uDecode(dev.sign_pub), dk.signedBytes(reg as never), dk.b64uDecode(String(c.body.sig)));
      const checkOk = dev.check ? await dk.verifyCheck(dev.check, await dk.objectHash(reg as never), dk.validateCheckProof(dev.check.type, c.body.check)) : false;
      const listed = pending.find(p => p.request_id === reg.request_id);
      verdict = { ok: sigOk && checkOk && !!listed && reg.cred_id === listed.cred_id && reg.rp_id === listed.rp_id && reg.key_id === c.session.keyId, why: JSON.stringify({ sigOk, checkOk }) };
      if (!verdict.ok) { c.refuse(403, 'BAD_SIGNATURE'); return true; }
      pending.splice(pending.indexOf(listed!), 1);
      c.json(201, { registered: true, cred_id: reg.cred_id });
      return true;
    }
    return false;
  };
  const helperEnv: Record<string, string> = {};
  const helper = fakeHost(helperEnv);
  const gw: GatewayRig = await bootGateway({ as, platform: helper });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const get = (path: string) => call(gw.port, 'GET', path, { headers: h });
  const start = await post('/auth/device/setup/start', o.checkKey === false ? {} : { checkKey: true });
  expect(start.status, start.text).toBe(200);
  const fin = await post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status, fin.text).toBe(200);
  const add = (extra: Partial<Pending> = {}): Pending => {
    const p: Pending = { request_id: b64u(16), cred_id: b64u(32), rp_id: RP, code: '482913', created_at: now() - 30, credential_at: now() - 20, expires_at: now() + 500, account: { email: 'owner@dev.local', name: 'Owner' }, ...extra };
    pending.push(p);
    return p;
  };
  const touches = vi.spyOn(PlatformChecks.prototype, 'sign');
  const helperNow = (env: Record<string, string>): void => { Object.assign(helperEnv, env); helper.close(); };
  return { as, gw, h, post, get, add, pending, received, verdict: () => verdict, touches, helperNow, keyId: String(start.body.deviceKeyId), rootDid: String(start.body.rootDid) };
}

describe('dashboard passkey: approved on this computer', () => {
  it('lists what the Authority Server lists, then approves one with one touch: the object names exactly that request, signed with this computer\'s key and check', async () => {
    const w = await world();
    const p = w.add();
    const list = await w.get('/auth/device/dashboard-passkeys');
    expect(list.status, list.text).toBe(200);
    expect(list.body.canApprove).toBe(true);
    expect(list.body.pending).toEqual([{ requestId: p.request_id, credId: p.cred_id, rpId: RP, code: '482913', createdAt: p.created_at, credentialAt: p.credential_at, expiresAt: p.expires_at, account: { email: 'owner@dev.local', name: 'Owner' } }]);

    w.touches.mockClear();
    const r = await w.post(`/auth/device/dashboard-passkeys/${p.request_id}/approve`);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ registered: true, credId: p.cred_id, code: '482913' });
    expect(w.touches).toHaveBeenCalledTimes(1);
    expect(w.verdict()?.ok, w.verdict()?.why).toBe(true);
    const reg = w.received[0].register as Record<string, unknown>;
    expect(Object.keys(reg).sort()).toEqual(['chain_head', 'chain_seq', 'cred_id', 'issued_at', 'key_id', 'request_id', 'root_did', 'rp_id', 'typ', 'v']);
    expect(reg).toMatchObject({ typ: 'suveren-passkey-register', v: 1, root_did: w.rootDid, key_id: w.keyId, request_id: p.request_id, cred_id: p.cred_id, rp_id: RP });
    expect((await w.get('/auth/device/dashboard-passkeys')).body.pending).toEqual([]);
  });

  it('a request the Authority Server does not list (unknown, or expired) is refused before any touch, whatever the page sends', async () => {
    const w = await world();
    w.add({ expires_at: Math.floor(Date.now() / 1000) - 1, request_id: 'A'.repeat(22) });
    w.touches.mockClear();
    for (const id of ['B'.repeat(22), 'A'.repeat(22)]) {
      const r = await w.post(`/auth/device/dashboard-passkeys/${id}/approve`);
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('passkey_request_gone');
    }
    const bad = await w.post('/auth/device/dashboard-passkeys/not-an-id/approve');
    expect(bad.status).toBe(400);
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.received).toEqual([]);
    // An expired request is not listed either.
    expect((await w.get('/auth/device/dashboard-passkeys')).body.pending).toEqual([]);
  });

  it('a cancelled touch sends nothing', async () => {
    const w = await world();
    const p = w.add();
    w.helperNow({ FAKE_TOUCH: 'cancel' });
    const r = await w.post(`/auth/device/dashboard-passkeys/${p.request_id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('check_failed');
    expect(w.received).toEqual([]);
  });

  it('a computer without a check key cannot approve: it says so in the list and refuses before anything is signed', async () => {
    const w = await world({ checkKey: false });
    const p = w.add();
    const list = await w.get('/auth/device/dashboard-passkeys');
    expect(list.body.canApprove).toBe(false);
    const r = await w.post(`/auth/device/dashboard-passkeys/${p.request_id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_check_key');
    expect(w.received).toEqual([]);
  });

  it('every route needs the page session', async () => {
    const w = await world();
    const p = w.add();
    expect((await call(w.gw.port, 'GET', '/auth/device/dashboard-passkeys', {})).status).toBe(401);
    expect((await call(w.gw.port, 'POST', `/auth/device/dashboard-passkeys/${p.request_id}/approve`, { body: {} })).status).toBe(401);
    expect(w.received).toEqual([]);
  });
});
