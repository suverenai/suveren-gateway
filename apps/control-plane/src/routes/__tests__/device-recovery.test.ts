/**
 * Recovery with the recovery code, replacing the recovery code, and the alarm and cancel for a
 * request for a new identity (device-keys plan step 7, gateway side), through the REAL routers,
 * vault, page sessions, helper client and (where a check key is made) the helper process.
 *
 * The only stand-in is the Authority Server's network (StubAs, over HTTP on port 0). It answers
 * the REAL shapes of /api/devices/{chain,challenge,session} and /api/identity/reset/cancel and
 * verifies everything with hap-core. The hand-off routes (lib/device-recovery-contract.ts) do NOT
 * exist on the real Authority Server yet: the stub answers the contract, so what these tests prove
 * about them is "the gateway does what the contract says", not "the Authority Server does".
 *
 * Helpers: FAKE (packages/unlock-helper/test/fake-helper.mjs, software P-256 keys, no touch) and
 * SOFT (the real Swift helper, debug build, software backend; skipped where it is not built).
 * No test shows a real Touch ID prompt.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Server } from 'node:http';
import {
  rootKeyFromRecoveryCode, parseRecoveryCode, generateRecoveryCode, verifyChain, entryHash, hexEncode, b64uEncode,
  type ChainEntry,
} from '@hap/core/device-keys';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, type GatewayRig, type Reply } from '../../__tests__/helpers/device-rig';
import { PlatformHelper, type HelperSpec } from '../../lib/platform-helper';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { eventBus, type BusEvent } from '../../lib/event-bus';
import { confirmCodeOf, readStageResponse, readRedeemResponse, readLookupResponse, authorizeUrl } from '../../lib/device-recovery-contract';
import { readPendingReset } from '../../lib/device-signin';
import { LoopbackHandoff } from '../../lib/loopback-handoff';
import { IdentityResetAlarm } from '../../lib/identity-reset-alarm';
import { DeviceRecovery } from '../../lib/device-recovery';
import { DeviceAsClient } from '../../lib/device-as-client';
import { DeviceSignin } from '../../lib/device-signin';
import { createAsKeyCheck, asPinning } from '../../lib/device-as-trust';
import { checkAsKeyBeforeLogin } from '../auth';
import { createDeviceRecoveryRouter } from '../device-recovery';
import { PageSessions } from '../../lib/page-session';
import { Vault } from '../../lib/vault';
import { tmpDir, FAST, PW } from '../../__tests__/helpers/device-rig';

const PKG = '../../../../../packages/unlock-helper/';
const SOFT = fileURLToPath(new URL(`${PKG}macos/.build/debug/suveren-unlock-helper`, import.meta.url));
const FAKE = fileURLToPath(new URL(`${PKG}test/fake-helper.mjs`, import.meta.url));
const haveSoft = process.platform === 'darwin' && existsSync(SOFT);
const sit = it.skipIf(!haveSoft);

const open: Array<{ close: () => Promise<void> }> = [];
const hosts: PlatformHelper[] = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  for (const h of hosts.splice(0)) h.close();
  vi.restoreAllMocks();
});

const host = (spec: HelperSpec): PlatformHelper => {
  const h = new PlatformHelper({ locate: () => ({ spec }), idleMs: 30, touchTimeoutMs: 20_000 });
  hosts.push(h);
  return h;
};
const fakeHost = (env: Record<string, string> = {}) => host({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, files: [] });
const softHost = () => host({ command: SOFT, args: ['serve', '--backend', 'software', '--allow-any-caller'], files: [] });

interface Gw {
  gw: GatewayRig;
  h: Record<string, string>;
  post: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;
  get: (path: string, headers?: Record<string, string>) => Promise<Reply>;
}

async function boot(as: StubAs, o: { platform?: PlatformHelper; dir?: string; fresh?: boolean; enabled?: boolean; notes?: Array<[string, string]> } = {}): Promise<Gw> {
  const gw = await bootGateway({
    as, platform: o.platform, dir: o.dir, fresh: o.fresh, enabled: o.enabled,
    ...(o.notes ? { notifyIdentityReset: (t: string, m: string) => { o.notes!.push([t, m]); } } : {}),
  });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  return {
    gw, h,
    post: (path, body = {}, headers = h) => call(gw.port, 'POST', path, { headers, body }),
    get: (path, headers = h) => call(gw.port, 'GET', path, { headers }),
  };
}

async function newAs(): Promise<StubAs> {
  const as = await new StubAs().listen();
  open.push(as);
  return as;
}

/** An existing account: one computer set up with a pasted enrolment code. Returns its recovery code. */
async function setUp(as: StubAs, w: Gw, o: { checkKey?: boolean; label?: string } = {}): Promise<{ code: string; rootDid: string; keyId: string }> {
  const start = await w.post('/auth/device/setup/start', { ...(o.label ? { label: o.label } : {}), ...(o.checkKey ? { checkKey: true } : {}) });
  expect(start.status).toBe(200);
  const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status).toBe(200);
  expect(fin.body.signedIn).toBe(true);
  return { code: String(start.body.recoveryCode), rootDid: String(start.body.rootDid), keyId: String(start.body.deviceKeyId) };
}

/** The browser's part: open the address, press the button with an email-link session, follow the redirect to the gateway. */
async function browser(as: StubAs, w: Gw, started: Reply, o: Parameters<StubAs['authorizeHandoff']>[1] = {}): Promise<{ refused: string } | { redirect: string; callback: Reply }> {
  const u = new URL(String(started.body.authorizeUrl));
  expect(u.origin).toBe(as.url);
  expect(u.pathname).toBe('/recover');
  const r = await as.authorizeHandoff({ handoff: u.searchParams.get('handoff')!, port: u.searchParams.get('port')!, state: u.searchParams.get('state')! }, o);
  if ('refused' in r) return r;
  const cb = new URL(r.redirect);
  expect(cb.hostname).toBe('127.0.0.1');
  expect(Number(cb.port)).toBe(w.gw.port);
  return { redirect: r.redirect, callback: await call(w.gw.port, 'GET', cb.pathname + cb.search) };
}

function allFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push({ path: p, text: readFileSync(p).toString('latin1') });
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const recoveryRequests = (as: StubAs) => as.requests.filter(r => r.path.startsWith('/api/devices/recovery/'));

// ─────────────────────────────────────────────────────────────────────────────

describe('recovery on a fresh gateway: a reset with the recovery code', () => {
  it('makes this computer the only device, through the browser hand-off, and signs in', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old, { label: 'Old Mac' });

    const fresh = await boot(as);
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code, label: 'New Mac' });
    expect(start.status).toBe(200);
    expect(start.body.rootDid).toBe(acct.rootDid);
    expect(start.body.removes).toEqual([{ label: 'Old Mac', kind: 'gateway' }]);
    expect(start.body.confirmCode).toMatch(/^\d{6}$/);
    // nothing is appended by the gateway: the entry is only staged
    expect(as.chainEntries()).toHaveLength(1);

    const b = await browser(as, fresh, start);
    expect('callback' in b && b.callback.status).toBe(200);
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`);
    expect(st.body).toMatchObject({ ok: true, state: 'authorised' });

    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ ok: true, rootDid: acct.rootDid, signedIn: true, head: { seq: 1 } });

    // the Authority Server holds genesis + a root-signed reset that hap-core accepts
    const entries = as.chainEntries() as ChainEntry[];
    expect(entries).toHaveLength(2);
    const reset = entries[1];
    expect(reset).toMatchObject({ op: 'reset', seq: 1, signer: 'root', root_did: acct.rootDid });
    expect(reset.device).toMatchObject({ kind: 'gateway', label: 'New Mac', keystore: 'software', check: null });
    expect(reset.sigs.map(s => s.by).sort()).toEqual(['root', fin.body.deviceKeyId as string].sort());
    const state = await verifyChain({ expectedRootDid: acct.rootDid, entries });
    expect(state.devices[acct.keyId].removed_seq).toBe(1);
    expect(state.devices[fin.body.deviceKeyId as string].removed_seq).toBeNull();
    expect(fin.body.head).toEqual({ seq: 1, hash: await entryHash(reset) });
    // the confirmation code is computed from the entry hash, as the Authority Server's page will compute it
    expect(start.body.confirmCode).toBe(confirmCodeOf(await entryHash(reset)));

    // the stored chain and the sign-in
    expect(new DeviceChainStore(fresh.gw.vault).read()).toMatchObject({ rootDid: acct.rootDid, keyId: fin.body.deviceKeyId, head: { seq: 1, hash: await entryHash(reset) } });
    expect(fresh.gw.vault.getSpCookie()).toMatch(/^Bearer [A-Za-z0-9-]+$/);
    expect((await fresh.get('/auth/device/status')).body).toMatchObject({ setUp: true, signedIn: true, setupPending: false });

    // the old computer is refused at sign-in, with the Authority Server's reason
    const r = await old.gw.signin!.signIn();
    expect(r).toMatchObject({ ok: false, code: 'signin_refused', asCode: 'NOT_ACTIVE' });
  });

  it('the email-link cookie never passes through the gateway: no request carries a cookie, a key, or the recovery code', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as);
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code });
    await browser(as, fresh, start);
    await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    for (const r of as.requests) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers['x-api-key']).toBeUndefined();
    }
    // the hand-off posts carry no credential at all: the entry and the challenge are the whole of them
    for (const r of recoveryRequests(as)) expect(r.headers.authorization).toBeUndefined();
    // the redirect the browser follows carries `code` and `state`, nothing of the account
    expect(recoveryRequests(as).map(r => r.path)).toEqual(['/api/devices/recovery/chain', '/api/devices/recovery/handoffs', '/api/devices/recovery/redeem']);
  });

  it('the recovery code and the root key are in no request, no answer, no log line and no file; the seeds are zeroed', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const root = await rootKeyFromRecoveryCode(acct.code);
    const recoverySeedHex = hexEncode(await parseRecoveryCode(acct.code));
    // every 16- and 32-byte array that is zeroed: the recovery seed and the root private seed must be among them
    const zeroed: string[] = [];
    const orig = Uint8Array.prototype.fill;
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (this: Uint8Array, ...a: [number, number?, number?]) {
      if (this.length === 16 || this.length === 32) zeroed.push(Buffer.from(this).toString('hex'));
      return orig.apply(this, a as never) as never;
    });
    const fresh = await boot(as);
    const replies: Reply[] = [];
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code });
    replies.push(start);
    await browser(as, fresh, start);
    replies.push(await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`));
    replies.push(await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId }));
    replies.push(await fresh.get('/auth/device/status'));
    vi.mocked(Uint8Array.prototype.fill).mockRestore();

    const compact = acct.code.replace(/-/g, '');
    const needles = [acct.code, compact, hexEncode(root.privateSeed), b64uEncode(root.privateSeed), Buffer.from(root.privateSeed).toString('base64')];
    const hay = (label: string, text: string) => { for (const n of needles) expect(text.includes(n), `${label} holds a secret`).toBe(false); };
    hay('AS requests', JSON.stringify(as.requests.slice(as.requests.findIndex(r => r.path === '/api/devices/recovery/chain'))));
    for (const [i, r] of replies.entries()) hay(`reply ${i}`, r.text);
    hay('log', logs.join('\n'));
    for (const dir of [fresh.gw.dir, old.gw.dir]) for (const f of allFiles(dir)) {
      // the old computer's own set-up showed the code once, in that answer; nothing it wrote holds it
      hay(f.path, f.text);
    }
    // and the zeroing happened for both secrets
    expect(zeroed).toContain(hexEncode(root.privateSeed));
    expect(zeroed).toContain(recoverySeedHex);
  });

  it('a body that is not JSON is refused with nothing of it in the answer or the log', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as);
    const compact = acct.code.replace(/-/g, '');
    for (const path of ['/auth/device/recover/start', '/auth/device/rotate-root/submit']) {
      const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const payload = `{"code": ${acct.code} "oldCode": ${acct.code}`; // not JSON
        const req = http.request({ host: '127.0.0.1', port: fresh.gw.port, method: 'POST', path, headers: { ...fresh.h, host: `127.0.0.1:${fresh.gw.port}`, origin: `http://127.0.0.1:${fresh.gw.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, res => {
          let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }));
        });
        req.on('error', reject); req.write(payload); req.end();
      });
      expect(raw.status, path).toBe(400);
      expect(raw.text.includes(compact.slice(4, 16)), path).toBe(false);
      expect(raw.text.includes('SV1')).toBe(false);
    }
    expect(logs.join('\n').includes(compact.slice(4, 16))).toBe(false);
    expect(logs.join('\n').includes('SV1-')).toBe(false);
    expect(as.requests.filter(x => x.path.startsWith('/api/devices/recovery/'))).toHaveLength(0);
  });

  it('refuses a code that is not a recovery code, and sends nothing to the Authority Server', async () => {
    const as = await newAs();
    const fresh = await boot(as);
    const before = as.requests.length;
    for (const code of ['', 'hello', 'SV1-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA', 12, null, 'x'.repeat(500)]) {
      const r = await fresh.post('/auth/device/recover/start', { code });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('recovery_code_invalid');
    }
    expect(as.requests.length).toBe(before);
    // nothing was kept
    expect((await fresh.get('/auth/device/status')).body).toMatchObject({ setUp: false });
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
  });

  it('a valid code that belongs to no account is refused, and the answer does not say more', async () => {
    const as = await newAs();
    const old = await boot(as);
    await setUp(as, old);
    const fresh = await boot(as);
    const other = (await generateRecoveryCode()).code;
    const r = await fresh.post('/auth/device/recover/start', { code: other });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('recovery_code_unknown');
    expect(recoveryRequests(as).map(x => x.path)).toEqual(['/api/devices/recovery/chain']);
  });

  it('does not believe the Authority Server: a chain the typed code does not control is refused', async () => {
    const as = await newAs();
    const old = await boot(as);
    await setUp(as, old);
    const other = (await generateRecoveryCode()).code;
    // a lying AS answers the account's chain for any code: the root key in force is not the typed code's
    as.lookupIgnoresRoot = true;
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: other });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('recovery_code_unknown');
    expect(recoveryRequests(as).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(0);
  });

  it('a chain changed in transit is refused (chain_invalid) and nothing is staged', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    as.lookupMutate = r => ({ ...r, entries: [{ ...(r.entries[0] as object), created_at: 1 }] });
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('chain_invalid');
    expect(recoveryRequests(as).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(0);
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
  });

  it('a chain whose head differs from what the Authority Server names is refused', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    as.lookupMutate = r => ({ ...r, head: { seq: 5, hash: `sha256:${'0'.repeat(64)}` } });
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('head_mismatch');
    expect(recoveryRequests(as).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(0);
  });

  it('a gateway that does not listen on 127.0.0.1 cannot receive the redirect: refused before anything is signed', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const gw = await bootGateway({ as, listenHost: '::1' });
    open.push(gw);
    const session = await call(gw.port, 'POST', '/auth/unlock', { body: { password: PW }, connectTo: '::1' });
    const h = sessionHeaders({ token: String(session.body.sessionToken), cookie: String(session.headers['set-cookie']?.[0]).match(/=([^;]+)/)![1] });
    const r = await call(gw.port, 'POST', '/auth/device/recover/start', { headers: h, body: { code: acct.code }, connectTo: '::1' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('connect_loopback_unsupported');
    expect(recoveryRequests(as)).toHaveLength(0);
  });

  it('a gateway that already has device keys is refused; a set-up and a recovery never run together', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const r = await old.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('already_set_up');

    // set-up pending blocks a recovery; a recovery pending blocks a set-up
    const f = await boot(as);
    expect((await f.post('/auth/device/setup/start')).status).toBe(200);
    const blocked = await f.post('/auth/device/recover/start', { code: acct.code });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('setup_pending');

    const g = await boot(as);
    expect((await g.post('/auth/device/recover/start', { code: acct.code })).status).toBe(200);
    const blocked2 = await g.post('/auth/device/setup/start');
    expect(blocked2.status).toBe(409);
    expect(blocked2.body.code).toBe('recovery_pending');
    // a second recovery on the same gateway is refused too
    const again = await g.post('/auth/device/recover/start', { code: acct.code });
    expect(again.body.code).toBe('recovery_pending');
  });

  it('two starts at once: one runs, the other is refused', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const f = await boot(as);
    const [a, b] = await Promise.all([f.post('/auth/device/recover/start', { code: acct.code }), f.post('/auth/device/recover/start', { code: acct.code })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(recoveryRequests(as).filter(r => r.path.endsWith('/handoffs'))).toHaveLength(1);
  });
});

describe('the browser hand-off', () => {
  async function started() {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as);
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(start.status).toBe(200);
    return { as, old, acct, fresh, start };
  }

  it('the callback needs the right state, once: a guessed, a replayed and an expired state change nothing', async () => {
    const { as, fresh, start } = await started();
    const u = new URL(String(start.body.authorizeUrl));
    const state = u.searchParams.get('state')!;
    const r = await as.authorizeHandoff({ handoff: u.searchParams.get('handoff')!, port: u.searchParams.get('port')!, state });
    const cb = new URL((r as { redirect: string }).redirect);
    const code = cb.searchParams.get('code')!;

    const wrong = await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}&state=${b64uEncode(new Uint8Array(32))}`);
    expect(wrong.status).toBe(400);
    expect(as.requests.filter(x => x.path.endsWith('/redeem'))).toHaveLength(0);
    for (const bad of ['', 'x', 'a'.repeat(200)]) expect((await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}&state=${bad}`)).status).toBe(400);
    expect((await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}`)).status).toBe(400);

    expect((await call(fresh.gw.port, 'GET', cb.pathname + cb.search)).status).toBe(200);
    // the same callback again: the state is spent
    expect((await call(fresh.gw.port, 'GET', cb.pathname + cb.search)).status).toBe(400);
    expect(as.requests.filter(x => x.path.endsWith('/redeem'))).toHaveLength(1);
  });

  it('a state that waited past its time is refused', async () => {
    const { as, fresh, start } = await started();
    const u = new URL(String(start.body.authorizeUrl));
    const r = await as.authorizeHandoff({ handoff: u.searchParams.get('handoff')!, port: u.searchParams.get('port')!, state: u.searchParams.get('state')! });
    const cb = new URL((r as { redirect: string }).redirect);
    fresh.gw.clock.t += 11 * 60;
    expect((await call(fresh.gw.port, 'GET', cb.pathname + cb.search)).status).toBe(400);
    expect(as.requests.filter(x => x.path.endsWith('/redeem'))).toHaveLength(0);
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`);
    expect(st.body).toMatchObject({ state: 'expired' });
  });

  it('only the page session that started it reads the outcome', async () => {
    const { fresh, start } = await started();
    const second = await call(fresh.gw.port, 'POST', '/auth/unlock', { body: { password: 'correct horse battery' } });
    expect(second.status).toBe(200);
    const other = sessionHeaders({ token: String(second.body.sessionToken), cookie: String(second.headers['set-cookie']?.[0]).match(/=([^;]+)/)![1] });
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`, other);
    expect(st.status).toBe(403);
    expect(st.body.code).toBe('connect_other_session');
  });

  it('nothing the redirect says is believed: finish reads the chain. No authorisation, nothing stored', async () => {
    const { as, fresh, start } = await started();
    // the person never pressed the button: a (forged) callback cannot make a chain appear
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('recovery_not_done');
    expect(new DeviceChainStore(fresh.gw.vault).read()).toBeNull();
    expect(as.chainEntries()).toHaveLength(1);
    expect(fresh.gw.vault.getSpCookie()).toBeNull();
  });

  it('a browser without an email-link session, a cross-site post, or a missing CSRF token appends nothing (the contract, as the stub models it)', async () => {
    const { as, fresh, start } = await started();
    for (const o of [{ emailLinkSession: false }, { crossSite: true }, { csrf: false }, { userId: 'someone-else' }]) {
      const b = await browser(as, fresh, start, o);
      expect('refused' in b).toBe(true);
    }
    expect(as.chainEntries()).toHaveLength(1);
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.body.code).toBe('recovery_not_done');
  });

  it('an Authority Server that names another entry at redeem is not believed; the chain decides', async () => {
    const { as, fresh, start } = await started();
    as.lieAboutRedeem = true;
    const b = await browser(as, fresh, start);
    expect('callback' in b && b.callback.status).toBe(200);
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`);
    expect(st.body).toMatchObject({ state: 'failed', code: 'head_mismatch' });
    // the chain DOES hold our entry (the AS lied only about the redeem): finish verifies it and completes
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(200);
    expect(fin.body.signedIn).toBe(true);
  });

  it('the chain moved after the entry was built: the append is refused, the gateway says so and keeps nothing', async () => {
    const { as, old, acct, fresh, start } = await started();
    // another fresh gateway recovers first
    const other = await boot(as);
    const s2 = await other.post('/auth/device/recover/start', { code: acct.code });
    expect((await browser(as, other, s2))).toHaveProperty('callback');
    expect((await other.post('/auth/device/recover/finish', { recoveryId: s2.body.recoveryId })).status).toBe(200);
    void old;
    // now the first one's entry no longer extends the chain
    const b = await browser(as, fresh, start);
    expect('callback' in b && b.callback.status).toBe(200);
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`);
    expect(st.body).toMatchObject({ state: 'failed', code: 'handoff_refused' });
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(409);
    expect(new DeviceChainStore(fresh.gw.vault).read()).toBeNull();
  });

  it('a stage answer that is not the contract is refused and nothing is kept', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    as.badStageAnswer = true;
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('as_answer_invalid');
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
    expect((await fresh.get('/auth/device/status')).body).toMatchObject({ setUp: false });
  });

  it('an unreachable Authority Server is refused with a neutral code and nothing is kept', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as);
    await as.close();
    open.splice(open.findIndex(x => x === as), 1);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.body.code).toBe('as_unreachable');
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
  });

  it('survives a restart: the started recovery comes back from its sealed slot and finish verifies the chain', async () => {
    const { as, fresh, start } = await started();
    await browser(as, fresh, start); // the person pressed the button; the gateway never heard back
    const dir = fresh.gw.dir;
    await fresh.gw.close();
    open.splice(open.findIndex(x => x === fresh.gw), 1);
    const again = await boot(as, { dir, fresh: false });
    expect((await again.get('/auth/device/status')).body).toMatchObject({ setUp: false });
    // the slot holds the signed entry and ids, no secret
    const slot = again.gw.vault.getSecretSlot<Record<string, unknown>>('deviceRecoveryPending')!;
    expect(Object.keys(slot).sort()).toEqual(['confirmCode', 'entry', 'entryHash', 'id', 'keyId', 'label', 'rootDid', 'v']);
    const fin = await again.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ signedIn: true, head: { seq: 1 } });
    expect(again.gw.vault.hasSecretSlot('deviceRecoveryPending') && again.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeFalsy();
  });

  it('a leftover pending slot after the chain was stored (a crash between the two writes) counts for nothing', async () => {
    const { as, fresh, start } = await started();
    const slot = fresh.gw.vault.getSecretSlot<Record<string, unknown>>('deviceRecoveryPending')!;
    expect((await fresh.get('/auth/device/status')).body.recovery).toMatchObject({ recoveryPending: true, kind: 'reset', handoff: 'waiting', confirmCode: start.body.confirmCode });
    expect(fresh.gw.vault.listCredentials()).not.toContain('deviceRecoveryPending');
    const b = await browser(as, fresh, start);
    expect('callback' in b).toBe(true);
    expect((await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId })).status).toBe(200);
    fresh.gw.vault.setSecretSlot('deviceRecoveryPending', slot); // the crash window: chain stored, slot not cleared
    const st = (await fresh.get('/auth/device/status')).body;
    expect(st).toMatchObject({ setUp: true, recovery: { recoveryPending: false } });
    expect((await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId })).status).toBe(404);
  });

  it('cancel drops a started recovery and its sealed slot; the same code can start again', async () => {
    const { acct, fresh, start } = await started();
    expect((await fresh.post('/auth/device/recover/cancel')).status).toBe(200);
    expect(fresh.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
    expect((await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId })).status).toBe(404);
    expect((await fresh.post('/auth/device/recover/start', { code: acct.code })).status).toBe(200);
  });

  it('finish with an id that is not the started one is refused', async () => {
    const { fresh } = await started();
    for (const id of ['x', '', 5, null]) expect((await fresh.post('/auth/device/recover/finish', { recoveryId: id })).status).toBe(404);
  });
});

describe('recovery with this computer\'s check key', () => {
  it('the new device carries its check key; the key goes into its slot only when the chain is stored', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as, { platform: fakeHost() });
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code, checkKey: true });
    expect(start.status).toBe(200);
    expect(fresh.gw.checkStore.has()).toBe(false);
    await browser(as, fresh, start);
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(200);
    const entries = as.chainEntries() as ChainEntry[];
    expect(entries[1].device!.check).toMatchObject({ type: 'platform' });
    expect(entries[1].checks.map(c => c.by)).toEqual([fin.body.deviceKeyId]);
    await verifyChain({ expectedRootDid: acct.rootDid, entries }); // hap-core verified the check too
    expect(fresh.gw.checkStore.has()).toBe(true);
    expect(fresh.gw.checkStore.read()!.publicKey).toBe((entries[1].device!.check as { pub: string }).pub);
  });

  it('a cancelled touch stops the recovery before anything is staged', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as, { platform: fakeHost({ FAKE_TOUCH: 'cancel' }) });
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code, checkKey: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('cancelled');
    expect(recoveryRequests(as).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(0);
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
    expect(fresh.gw.checkStore.has()).toBe(false);
  });

  it('a check key asked for where there is no helper is refused', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code, checkKey: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('helper_unavailable');
  });
});

describe('replacing the recovery code (rotate-root)', () => {
  async function granting() {
    const as = await newAs();
    const w = await boot(as, { platform: fakeHost() });
    const acct = await setUp(as, w, { checkKey: true });
    return { as, w, acct };
  }
  async function submit(w: Gw, oldCode: string, over: Record<string, unknown> = {}) {
    const prep = await w.post('/auth/device/rotate-root/start');
    expect(prep.status).toBe(200);
    const newCode = String(prep.body.recoveryCode);
    const sub = await w.post('/auth/device/rotate-root/submit', { rotateId: prep.body.rotateId, oldCode, newCode, ...over });
    return { prep, newCode, sub };
  }

  it('a new code signed by the old code and this computer\'s signature AND check; the identity stays; the stored head moves', async () => {
    const { as, w, acct } = await granting();
    const { newCode, sub } = await submit(w, acct.code);
    expect(sub.status).toBe(200);
    expect(sub.body.confirmCode).toMatch(/^\d{6}$/);
    expect(as.chainEntries()).toHaveLength(1); // staged, not appended
    const b = await browser(as, w, sub);
    expect('callback' in b && b.callback.status).toBe(200);
    const fin = await w.post('/auth/device/rotate-root/finish', { recoveryId: sub.body.recoveryId });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ ok: true, rootDid: acct.rootDid, head: { seq: 1 } });

    const entries = as.chainEntries() as ChainEntry[];
    const e = entries[1];
    expect(e).toMatchObject({ op: 'rotate-root', signer: 'root', root_did: acct.rootDid, device: null });
    expect(e.sigs.map(s => s.by).sort()).toEqual(['root', acct.keyId].sort());
    expect(e.checks.map(c => c.by)).toEqual([acct.keyId]);
    const state = await verifyChain({ expectedRootDid: acct.rootDid, entries });
    expect(state.root_pub).toBe(e.new_root);
    expect(Buffer.from((await rootKeyFromRecoveryCode(newCode)).publicKey).toString('base64url')).toBe(e.new_root);
    expect(sub.body.confirmCode).toBe(confirmCodeOf(await entryHash(e)));
    // the stored chain and pins moved; the identity did not
    expect(new DeviceChainStore(w.gw.vault).read()).toMatchObject({ rootDid: acct.rootDid, keyId: acct.keyId, head: { seq: 1, hash: await entryHash(e) } });
    // and this computer still signs in on the longer chain
    expect((await w.post('/auth/device/signin')).status).toBe(200);
  });

  it('after a rotation the NEW code resets from a fresh gateway and the OLD code is refused', async () => {
    const { as, w, acct } = await granting();
    const { newCode, sub } = await submit(w, acct.code);
    await browser(as, w, sub);
    expect((await w.post('/auth/device/rotate-root/finish', { recoveryId: sub.body.recoveryId })).status).toBe(200);

    const f1 = await boot(as);
    const oldTry = await f1.post('/auth/device/recover/start', { code: acct.code });
    expect(oldTry.status).toBe(404);
    expect(oldTry.body.code).toBe('recovery_code_unknown');
    expect(recoveryRequests(as).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(1); // only the rotation's

    const f2 = await boot(as);
    const start = await f2.post('/auth/device/recover/start', { code: newCode });
    expect(start.status).toBe(200);
    expect(start.body.rootDid).toBe(acct.rootDid);
    await browser(as, f2, start);
    const fin = await f2.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(200);
    expect((fin.body.head as { seq: number }).seq).toBe(2);
    await verifyChain({ expectedRootDid: acct.rootDid, entries: as.chainEntries() });
  });

  it('refused without a granting device: a computer with no check key cannot replace the code', async () => {
    const as = await newAs();
    const w = await boot(as);
    const acct = await setUp(as, w);
    const { sub } = await submit(w, acct.code);
    expect(sub.status).toBe(409);
    expect(sub.body.code).toBe('granting_device_required');
    expect(recoveryRequests(as)).toHaveLength(0);
  });

  it('refused when the helper that holds the check key is not there; nothing is signed or staged', async () => {
    const { as, w, acct } = await granting();
    const dir = w.gw.dir;
    await w.gw.close();
    open.splice(open.findIndex(x => x === w.gw), 1);
    const again = await boot(as, { dir, fresh: false }); // no platform helper this time
    expect((await again.post('/auth/device/signin')).status).toBe(200);
    const { sub } = await submit(again, acct.code);
    expect(sub.status).toBe(409);
    expect(sub.body.code).toBe('helper_unavailable');
    expect(recoveryRequests(as)).toHaveLength(0);
  });

  it('a cancelled touch stops it before anything is staged', async () => {
    const as = await newAs();
    const ok = await boot(as, { platform: fakeHost() });
    const acct = await setUp(as, ok, { checkKey: true });
    const dir = ok.gw.dir;
    await ok.gw.close();
    open.splice(open.findIndex(x => x === ok.gw), 1);
    const w = await boot(as, { dir, fresh: false, platform: fakeHost({ FAKE_TOUCH: 'cancel' }) });
    // the key blob in the vault is the one the first helper made: a fake helper in cancel mode still holds the same software key
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    const { sub } = await submit(w, acct.code);
    expect(sub.status).toBe(409);
    expect(sub.body.code).toBe('cancelled');
    expect(recoveryRequests(as)).toHaveLength(0);
  });

  it('the wrong old code, a mistyped copy of the new code, and a gateway that is not signed in are each refused before anything is staged', async () => {
    const { as, w, acct } = await granting();
    const other = (await generateRecoveryCode()).code;
    const wrongOld = await submit(w, other);
    expect(wrongOld.sub.status).toBe(409);
    expect(wrongOld.sub.body.code).toBe('recovery_code_wrong');

    const mistyped = await submit(w, acct.code, { newCode: (await generateRecoveryCode()).code });
    expect(mistyped.sub.status).toBe(409);
    expect(mistyped.sub.body.code).toBe('new_code_mismatch');

    const badOld = await submit(w, 'not a code');
    expect(badOld.sub.status).toBe(400);

    w.gw.vault.clearSpCookie();
    const signedOut = await submit(w, acct.code);
    expect(signedOut.sub.status).toBe(409);
    expect(signedOut.sub.body.code).toBe('not_signed_in');
    expect(recoveryRequests(as)).toHaveLength(0);
  });

  it('a new code that was not shown by this gateway, or is submitted twice, is refused', async () => {
    const { as, w, acct } = await granting();
    const prep = await w.post('/auth/device/rotate-root/start');
    const newCode = String(prep.body.recoveryCode);
    const unknown = await w.post('/auth/device/rotate-root/submit', { rotateId: 'AAAAAAAAAAAAAAAAAAAAAA', oldCode: acct.code, newCode });
    expect(unknown.status).toBe(404);
    const first = await w.post('/auth/device/rotate-root/submit', { rotateId: prep.body.rotateId, oldCode: acct.code, newCode });
    expect(first.status).toBe(200);
    await w.post('/auth/device/recover/cancel');
    const second = await w.post('/auth/device/rotate-root/submit', { rotateId: prep.body.rotateId, oldCode: acct.code, newCode });
    expect(second.status).toBe(404); // the new code is spent
    void as;
  });

  it('a new code that waited too long is refused', async () => {
    const { w, acct } = await granting();
    const prep = await w.post('/auth/device/rotate-root/start');
    w.gw.clock.t += 31 * 60;
    const r = await w.post('/auth/device/rotate-root/submit', { rotateId: prep.body.rotateId, oldCode: acct.code, newCode: String(prep.body.recoveryCode) });
    expect(r.status).toBe(410);
  });

  it('a rotation whose browser step was never taken does not block anything once its time is over', async () => {
    const { w, acct } = await granting();
    const { sub } = await submit(w, acct.code);
    expect(sub.status).toBe(200);
    expect((await w.post('/auth/device/rotate-root/start')).body.code).toBe('recovery_pending');
    w.gw.clock.t += 11 * 60;
    expect((await w.post('/auth/device/rotate-root/start')).status).toBe(200);
  });

  it('finish does not believe a redirect: no authorisation, the stored head does not move', async () => {
    const { as, w, acct } = await granting();
    const { sub } = await submit(w, acct.code);
    const fin = await w.post('/auth/device/rotate-root/finish', { recoveryId: sub.body.recoveryId });
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('recovery_not_done');
    expect(new DeviceChainStore(w.gw.vault).read()!.head.seq).toBe(0);
    expect(as.chainEntries()).toHaveLength(1);
  });

  it('the new code is shown once, in that answer only, and is in no request, log or file', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
    const { as, w, acct } = await granting();
    const { newCode, sub } = await submit(w, acct.code);
    await browser(as, w, sub);
    const fin = await w.post('/auth/device/rotate-root/finish', { recoveryId: sub.body.recoveryId });
    const newRoot = await rootKeyFromRecoveryCode(newCode);
    const oldRoot = await rootKeyFromRecoveryCode(acct.code);
    const needles = [newCode, newCode.replace(/-/g, ''), acct.code, acct.code.replace(/-/g, ''), hexEncode(newRoot.privateSeed), b64uEncode(newRoot.privateSeed), hexEncode(oldRoot.privateSeed), b64uEncode(oldRoot.privateSeed)];
    const hay = (label: string, text: string) => { for (const n of needles) expect(text.includes(n), `${label} holds a secret`).toBe(false); };
    hay('AS requests', JSON.stringify(as.requests.slice(as.requests.findIndex(r => r.path === '/api/devices/recovery/handoffs'))));
    hay('submit', sub.text);
    hay('finish', fin.text);
    hay('status', (await w.get('/auth/device/status')).text);
    hay('log', logs.join('\n'));
    for (const f of allFiles(w.gw.dir)) hay(f.path, f.text);
  });
});

describe('the alarm for a pending request for a new identity', () => {
  const events = (): { seen: BusEvent[]; stop: () => void } => {
    const seen: BusEvent[] = [];
    const stop = eventBus.subscribe(e => { if (e.type.startsWith('identity-reset')) seen.push(e); });
    return { seen, stop };
  };

  it('a sign-in answer that carries the request raises one alarm: an event, a banner state, one notification', async () => {
    const as = await newAs();
    const notes: Array<[string, string]> = [];
    const w = await boot(as, { notes });
    await setUp(as, w);
    const ev = events();
    expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toBeNull();

    const open1 = as.openReset();
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    const st = (await w.get('/auth/device/status')).body;
    expect(st.pendingIdentityReset).toMatchObject({ id: open1.id, effectiveAt: open1.effective_at });
    expect(ev.seen.map(e => e.type)).toEqual(['identity-reset-pending']);
    expect(ev.seen[0].payload).toBeUndefined(); // a doorbell: the page reads the banner state itself
    expect(notes).toHaveLength(1);

    // the next hourly sign-in says it again: no second alarm, no second notification
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    expect(ev.seen).toHaveLength(1);
    expect(notes).toHaveLength(1);
    ev.stop();
  });

  it('the chain answer alone is enough, and so is the session answer alone', async () => {
    for (const where of ['chain', 'session'] as const) {
      const as = await newAs();
      const w = await boot(as);
      await setUp(as, w);
      as.pendingWhere = where;
      const o = as.openReset();
      expect((await w.post('/auth/device/signin')).status).toBe(200);
      expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toMatchObject({ id: o.id });
    }
  });

  it('the alarm ends when the Authority Server stops saying it, and a lock forgets it until the next sign-in says it again', async () => {
    const as = await newAs();
    const w = await boot(as);
    await setUp(as, w);
    const o = as.openReset();
    await w.post('/auth/device/signin');
    const ev = events();
    as.pendingReset = null;
    await w.post('/auth/device/signin');
    expect(ev.seen.map(e => e.type)).toEqual(['identity-reset-cleared']);
    expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toBeNull();

    as.pendingReset = o;
    await w.post('/auth/device/signin');
    w.gw.vault.clearKey();
    const w2 = await boot(as, { dir: w.gw.dir, fresh: false });
    // a restart forgets the alarm; the sign-in after unlock raises it again
    expect((await w2.post('/auth/device/signin')).status).toBe(200);
    expect((await w2.get('/auth/device/status')).body.pendingIdentityReset).toMatchObject({ id: o.id });
    ev.stop();
  });

  it('a request that is there but not in the shape of the contract is no sign-in at all (never silently "none")', async () => {
    const as = await newAs();
    const w = await boot(as);
    await setUp(as, w);
    for (const raw of [null, 'yes', {}, { id: 'x', effective_at: 1 }, { id: 'AAAAAAAAAAAAAAAAAAAAAA', effective_at: 'soon' }, []]) {
      as.pendingRaw = raw;
      const r = await w.post('/auth/device/signin');
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('as_answer_invalid');
    }
    expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toBeNull();
  });

  it('the alarm is not a lock: the gateway stays open so that the person can cancel', async () => {
    const as = await newAs();
    const w = await boot(as);
    await setUp(as, w);
    as.openReset();
    await w.post('/auth/device/signin');
    expect(w.gw.vault.isUnlocked()).toBe(true);
    expect((await w.get('/auth/device/status')).status).toBe(200);
  });
});

describe('cancelling a request for a new identity', () => {
  it('signs suveren-identity-cancel with this computer\'s key and posts it with no session; the alarm ends', async () => {
    const as = await newAs();
    const w = await boot(as);
    const acct = await setUp(as, w);
    const o = as.openReset();
    await w.post('/auth/device/signin');
    const ev: string[] = [];
    const stop = eventBus.subscribe(e => { if (e.type.startsWith('identity-reset')) ev.push(e.type); });

    const r = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cancelled: true, requestId: o.id });
    expect(as.cancelled).toEqual([{ request_id: o.id, key_id: acct.keyId, check: false }]);
    expect(ev).toEqual(['identity-reset-cleared']);
    expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toBeNull();
    stop();
    // the cancel carries nothing but the signed object: no bearer, no cookie
    const post = as.requests.filter(x => x.path === '/api/identity/reset/cancel');
    expect(post).toHaveLength(1);
    expect(post[0].headers.authorization).toBeUndefined();
    expect(post[0].headers.cookie).toBeUndefined();
    expect(Object.keys(JSON.parse(post[0].body)).sort()).toEqual(['cancel', 'request_id', 'sig']);
  });

  it('with a check key in the chain the cancel carries this computer\'s check, and the Authority Server verifies it with hap-core', async () => {
    const as = await newAs();
    const w = await boot(as, { platform: fakeHost() });
    await setUp(as, w, { checkKey: true });
    const o = as.openReset();
    await w.post('/auth/device/signin');
    const r = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(r.status).toBe(200);
    expect(as.cancelled).toHaveLength(1);
    expect(as.cancelled[0].check).toBe(true);
  });

  sit('with the real helper (software keys) the check over the cancel gets its prompt text and verifies', async () => {
    const as = await newAs();
    const w = await boot(as, { platform: softHost() });
    await setUp(as, w, { checkKey: true });
    const o = as.openReset();
    await w.post('/auth/device/signin');
    const r = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(r.status).toBe(200);
    expect(as.cancelled[0].check).toBe(true);
  });

  it('a cancelled touch sends nothing: a cancel without its check is never posted', async () => {
    const as = await newAs();
    const first = await boot(as, { platform: fakeHost() });
    await setUp(as, first, { checkKey: true });
    const dir = first.gw.dir;
    await first.gw.close();
    open.splice(open.findIndex(x => x === first.gw), 1);
    const w = await boot(as, { dir, fresh: false, platform: fakeHost({ FAKE_TOUCH: 'cancel' }) });
    const o = as.openReset();
    await w.post('/auth/device/signin');
    const r = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('cancelled');
    expect(as.requests.filter(x => x.path === '/api/identity/reset/cancel')).toHaveLength(0);
    expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toMatchObject({ id: o.id });
  });

  it('a device with a check key in the chain but no helper here sends nothing', async () => {
    const as = await newAs();
    const first = await boot(as, { platform: fakeHost() });
    await setUp(as, first, { checkKey: true });
    const dir = first.gw.dir;
    await first.gw.close();
    open.splice(open.findIndex(x => x === first.gw), 1);
    const w = await boot(as, { dir, fresh: false });
    const o = as.openReset();
    await w.post('/auth/device/signin');
    const r = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('helper_unavailable');
    expect(as.requests.filter(x => x.path === '/api/identity/reset/cancel')).toHaveLength(0);
  });

  it('only the request the Authority Server told this computer about can be cancelled', async () => {
    const as = await newAs();
    const w = await boot(as);
    await setUp(as, w);
    const none = await w.post('/auth/device/identity-reset/cancel', { requestId: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('reset_unknown');
    const o = as.openReset();
    await w.post('/auth/device/signin');
    for (const id of ['AAAAAAAAAAAAAAAAAAAAAA', '', 7, null, o.id + 'x']) {
      expect((await w.post('/auth/device/identity-reset/cancel', { requestId: id })).status).toBe(404);
    }
    expect(as.requests.filter(x => x.path === '/api/identity/reset/cancel')).toHaveLength(0);
  });

  it('an Authority Server that answers anything but a cancelled request of that id is not believed: the alarm stays', async () => {
    for (const lie of [{ request: { id: 'AAAAAAAAAAAAAAAAAAAAAA', state: 'cancelled' } }, { request: { id: 'x', state: 'open' } }, {}, null]) {
      const as = await newAs();
      const w = await boot(as);
      await setUp(as, w);
      const o = as.openReset();
      await w.post('/auth/device/signin');
      as.cancelAnswer = lie && 'request' in lie && (lie.request as { id: string }).id !== 'x' ? { request: { ...(lie.request as object), id: 'AAAAAAAAAAAAAAAAAAAAAA' } } : lie;
      const r = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('as_answer_invalid');
      expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toMatchObject({ id: o.id });
    }
  });

  it('a refused cancel (a request that is gone, a removed computer) is reported with the Authority Server\'s code and the alarm stays', async () => {
    const as = await newAs();
    const w = await boot(as);
    const acct = await setUp(as, w);
    const o = as.openReset();
    await w.post('/auth/device/signin');
    // the request ended on the Authority Server's side between the sign-in and the cancel
    as.pendingReset = null;
    const gone = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(gone.status).toBe(409);
    expect(gone.body.asCode).toBe('REQUEST_UNKNOWN');
    expect((await w.get('/auth/device/status')).body.pendingIdentityReset).toMatchObject({ id: o.id });
    // this computer was removed: its device session is gone, and no cancel is signed
    as.pendingReset = o;
    as.removeDevice(acct.keyId);
    const before = as.requests.filter(x => x.path === '/api/identity/reset/cancel').length;
    const removed = await w.post('/auth/device/identity-reset/cancel', { requestId: o.id });
    expect(removed.status).toBe(409);
    expect(removed.body.code).toBe('not_signed_in');
    expect(as.requests.filter(x => x.path === '/api/identity/reset/cancel').length).toBe(before);
  });
});

describe('every route is behind the page session, and the switch off leaves none of it', () => {
  const ROUTES: Array<[string, string]> = [
    ['POST', '/auth/device/recover/start'], ['GET', '/auth/device/recover/status'], ['POST', '/auth/device/recover/finish'],
    ['POST', '/auth/device/recover/cancel'], ['POST', '/auth/device/rotate-root/start'], ['POST', '/auth/device/rotate-root/submit'],
    ['GET', '/auth/device/rotate-root/status'], ['POST', '/auth/device/rotate-root/finish'], ['POST', '/auth/device/identity-reset/cancel'],
  ];

  it('without the page session (no cookie, no header token, a cookie alone, a foreign Origin) nothing is reached', async () => {
    const as = await newAs();
    const w = await boot(as);
    const acct = await setUp(as, w);
    void acct;
    for (const [m, p] of ROUTES) {
      const bare = await call(w.gw.port, m, p, { body: m === 'POST' ? {} : undefined });
      expect(bare.status, `${m} ${p}`).toBe(401);
      const cookieOnly = await call(w.gw.port, m, p, { headers: { cookie: w.h.cookie }, body: m === 'POST' ? {} : undefined });
      expect(cookieOnly.status, `${m} ${p} cookie only`).toBe(401);
      const foreign = await call(w.gw.port, m, p, { headers: w.h, origin: 'http://evil.example', body: m === 'POST' ? {} : undefined });
      expect(foreign.status, `${m} ${p} foreign origin`).toBe(403);
      const wrongHost = await call(w.gw.port, m, p, { headers: w.h, host: 'evil.example', body: m === 'POST' ? {} : undefined });
      expect(wrongHost.status, `${m} ${p} foreign host`).toBe(403);
    }
    expect(recoveryRequests(as)).toHaveLength(0);
  });

  it('the recovery router checks the page session itself, whoever is mounted in front of it', async () => {
    const as = await newAs();
    const dir = tmpDir();
    const vault = new Vault(dir, { ...FAST, deviceKeys: true });
    await vault.createWithPassword(PW, 'u1');
    const sessions = new PageSessions();
    const deps = { sessions, listensOnLoopbackOnly: true };
    const store = new DeviceChainStore(vault);
    const client = new DeviceAsClient({ asUrl: as.url, pinning: () => asPinning(as.url, dir) });
    const checkAs = createAsKeyCheck(as.url, dir, checkAsKeyBeforeLogin, () => {});
    const signin = new DeviceSignin({ vault, store, client, checkAs, establish: async () => {} });
    const alarm = new IdentityResetAlarm({ emit: () => {} });
    const recovery = new DeviceRecovery({ vault, store, client, signin, checkAs, alarm, setupPending: () => false });
    const app = express();
    app.use('/auth', express.json(), createDeviceRecoveryRouter({ vault, pageSession: deps, recovery }));
    const server: Server = await new Promise(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
    open.push({ close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }) });
    const port = (server.address() as { port: number }).port;
    for (const [m, p] of ROUTES) {
      const r = await call(port, m, p, { body: m === 'POST' ? { code: 'x' } : undefined });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    expect(as.requests).toHaveLength(0);
  });

  it('a path written another way does not get round the guard', async () => {
    const as = await newAs();
    const w = await boot(as);
    await setUp(as, w);
    for (const p of ['/auth/device//recover/start', '/auth/device/recover/start/', '/auth/device/%72ecover/start', '/auth/DEVICE/recover/start', '/auth/device/recover/start;x=1']) {
      const r = await call(w.gw.port, 'POST', p, { body: {} });
      expect([401, 404, 400], p).toContain(r.status);
      expect(r.status === 200, p).toBe(false);
    }
  });

  it('the callback is reachable without a page session but does nothing without a started hand-off', async () => {
    const as = await newAs();
    const w = await boot(as);
    const r = await call(w.gw.port, 'GET', '/recover/callback?code=a&state=b');
    expect(r.status).toBe(400);
    const foreign = await call(w.gw.port, 'GET', '/recover/callback?code=a&state=b', { host: 'evil.example' });
    expect(foreign.status).toBe(403);
    expect(as.requests.filter(x => x.path.endsWith('/redeem'))).toHaveLength(0);
  });

  it('with SUVEREN_DEVICE_KEYS off none of these routes exists, and the callback is not mounted', async () => {
    const as = await newAs();
    const gw = await bootGateway({ as, enabled: false });
    open.push(gw);
    await gw.vault.deriveAndSetKey('hap_account_key');
    for (const [m, p] of [...ROUTES, ['GET', '/recover/callback?state=x&code=y']] as Array<[string, string]>) {
      const r = await call(gw.port, m, p, { headers: { 'x-api-key': 'hap_account_key' }, body: m === 'POST' ? {} : undefined });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect(as.requests).toHaveLength(0);
    // and nothing of the new state was ever written
    expect(readFileSync(join(gw.dir, 'vault.enc.json'), 'utf-8')).not.toContain('deviceRecoveryPending');
  });
});

describe('the contract module and its readers', () => {
  it('confirmation code: six digits, from the entry hash only', () => {
    const h = `sha256:${'ab'.repeat(32)}`;
    expect(confirmCodeOf(h)).toMatch(/^\d{6}$/);
    expect(confirmCodeOf(h)).toBe(confirmCodeOf(h));
    expect(confirmCodeOf(h)).not.toBe(confirmCodeOf(`sha256:${'ac'.repeat(32)}`));
  });

  it('the address names a handoff, a port and a state and nothing else, on the configured Authority Server', () => {
    const u = new URL(authorizeUrl('https://as.example', { handoffId: 'h'.repeat(20), port: 3401, state: 's'.repeat(43) }));
    expect(u.origin).toBe('https://as.example');
    expect([...u.searchParams.keys()].sort()).toEqual(['handoff', 'port', 'state']);
  });

  it('readers refuse every answer that is not the contract', () => {
    const now = 1_000_000;
    expect(readStageResponse({ handoff_id: 'a'.repeat(24), expires_at: now + 600 }, now)).toBeTruthy();
    for (const bad of [null, {}, { handoff_id: 'short', expires_at: now + 600 }, { handoff_id: 'a'.repeat(24), expires_at: now - 1 }, { handoff_id: 'a'.repeat(24), expires_at: now + 99_999 }, { handoff_id: 'a b'.repeat(10), expires_at: now + 600 }]) {
      expect(readStageResponse(bad, now)).toBeNull();
    }
    const hash = `sha256:${'0'.repeat(64)}`;
    expect(readRedeemResponse({ head: { seq: 1, hash }, entry_hash: hash })).toBeTruthy();
    for (const bad of [null, { head: { seq: 1, hash } }, { head: { seq: -1, hash }, entry_hash: hash }, { head: { seq: 1, hash: 'x' }, entry_hash: hash }]) expect(readRedeemResponse(bad)).toBeNull();
    expect(readLookupResponse({ root_did: 'did:key:z6Mk', entries: [{}], head: { seq: 0, hash } })).toBeTruthy();
    for (const bad of [null, { root_did: 'x', entries: [{}], head: { seq: 0, hash } }, { root_did: 'did:key:z', entries: [], head: { seq: 0, hash } }]) expect(readLookupResponse(bad)).toBeNull();
  });

  it('pending_identity_reset: absent is none, a well-formed member is the request, anything else is invalid', () => {
    expect(readPendingReset({})).toBeNull();
    expect(readPendingReset({ pending_identity_reset: { id: 'A'.repeat(22), effective_at: 5 } })).toEqual({ id: 'A'.repeat(22), effectiveAt: 5 });
    for (const bad of [null, undefined, 1, {}, { id: 1, effective_at: 1 }, { id: 'A'.repeat(22), effective_at: -1 }, { id: 'A'.repeat(22), effective_at: 1.5 }, { id: 'A'.repeat(22) + '!', effective_at: 1 }]) {
      expect(readPendingReset({ pending_identity_reset: bad })).toBe('invalid');
    }
    expect(readPendingReset(null)).toBeNull();
  });

  it('a hand-off state works once, only for the right text, and only before its end', () => {
    const h = new LoopbackHandoff(3401, 's', 1000);
    expect(h.take('nope', 0)).toBe(false);
    expect(h.take(h.stateText, 1000)).toBe(false); // at its end
    expect(h.take(h.stateText, 999)).toBe(true);
    expect(h.take(h.stateText, 999)).toBe(false); // spent
    expect(h.challenge).toHaveLength(43);
  });

  it('the alarm raises once per request and never throws out of a failing notification', () => {
    const emitted: string[] = [];
    const a = new IdentityResetAlarm({ emit: t => { emitted.push(t); }, notify: () => { throw new Error('no notifier'); }, now: () => 5 });
    a.observe({ id: 'A'.repeat(22), effectiveAt: 9 });
    a.observe({ id: 'A'.repeat(22), effectiveAt: 9 });
    a.observe({ id: 'B'.repeat(22), effectiveAt: 9 });
    expect(emitted).toEqual(['identity-reset-pending', 'identity-reset-pending']);
    a.cancelled('A'.repeat(22)); // not the current one: no change
    expect(a.get()?.id).toBe('B'.repeat(22));
    a.observe(null);
    expect(emitted.at(-1)).toBe('identity-reset-cleared');
    a.observe(null);
    expect(emitted.filter(e => e === 'identity-reset-cleared')).toHaveLength(1);
  });
});
