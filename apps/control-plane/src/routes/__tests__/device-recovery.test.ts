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
import { createHash } from 'node:crypto';
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
import { CheckKeyStore } from '../../lib/platform-checks';
import { eventBus, type BusEvent } from '../../lib/event-bus';
import { confirmCodeOf, readStageResponse, readRedeemResponse, readLookupResponse, pageUrl } from '../../lib/device-recovery-contract';
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
// SUVEREN_TEST_HELPER: another debug build of the helper with a software backend (the Windows helper, windows/ in Go).
const SOFT = process.env.SUVEREN_TEST_HELPER ?? fileURLToPath(new URL(`${PKG}macos/.build/debug/suveren-unlock-helper`, import.meta.url));
const FAKE = fileURLToPath(new URL(`${PKG}test/fake-helper.mjs`, import.meta.url));
const haveSoft = (process.env.SUVEREN_TEST_HELPER !== undefined || process.platform === 'darwin') && existsSync(SOFT);
const sit = it.skipIf(!haveSoft);

const open: Array<{ close: () => Promise<void> }> = [];
const hosts: PlatformHelper[] = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  for (const h of hosts.splice(0)) h.close();
  vi.restoreAllMocks();
});

const host = (spec: HelperSpec): PlatformHelper => {
  const h = new PlatformHelper({ platform: 'darwin',  locate: () => ({ spec }), idleMs: 30, touchTimeoutMs: 20_000 });
  hosts.push(h);
  return h;
};
const fakeHost = (env: Record<string, string> = {}) => host({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, files: [] });
const softHost = () => host({ command: SOFT, args: ['serve', '--backend', 'software', '--allow-any-caller'], files: [] });

let bootCount = 0;

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
  // Two gateways that sign a lookup in the same second with the same key would send the same bytes, and the
  // Authority Server answers a signed request once: each gets a clock of its own, a second apart.
  gw.clock.t += ++bootCount;
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

interface BrowserOpts {
  /** Press the button without having used the emailed link (no cookie at all). */
  noLink?: boolean;
  /** Send this cookie value as `hap-recovery` (the session of ANOTHER recovery). */
  cookie?: string;
  /** Send a dashboard session, an API key and a device token instead of the recovery cookie. */
  otherCredentials?: boolean;
  crossSite?: boolean;
  wrongCsrf?: boolean;
  /** The email whose link is used. Default: the newest. */
  email?: number;
}

type Pressed = { refused: string; status: number } | { redirect: string; cookie: string };

const formBody = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const codeOf = async (r: Response): Promise<string> => {
  const hdr = r.headers.get('x-code');
  if (hdr) return hdr;
  return String(((await r.json()) as { errors: Array<{ code: string }> }).errors[0].code);
};

/**
 * The browser's part, over real HTTP against the stand-in Authority Server, in the order the real one needs: open the
 * address the gateway gave (it says "check your email"), open the EMAILED link in the same browser and press its button
 * (sets the `hap-recovery` cookie, bound to that one handoff), reload the address (now it shows the form), press Confirm.
 * The gateway sees none of this.
 */
async function pressButton(as: StubAs, started: Reply | string, o: BrowserOpts = {}): Promise<Pressed> {
  const pageAddress = typeof started === 'string' ? started : String(started.body.pageUrl);
  const mail = as.emails[o.email ?? as.emails.length - 1];
  expect(mail, 'the Authority Server emailed a link').toBeTruthy();
  const pu = new URL(pageAddress);
  expect(pu.origin).toBe(as.url);
  expect([...pu.searchParams.keys()].sort()).toEqual(['handoff', 'port', 'state']);
  // 1. before the link: the page shows nothing of the entry
  const before = await fetch(pageAddress, { redirect: 'manual' });
  expect([401, 410]).toContain(before.status); // 410: this recovery was replaced
  expect(before.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await before.text()).not.toContain('class="code"');

  let cookie = o.cookie ?? '';
  if (!o.noLink && !o.cookie && !o.otherCredentials) {
    // 2. the link: a GET shows a button and uses nothing up; the POST uses it up and sets the cookie
    const look = await fetch(mail.link, { redirect: 'manual' });
    expect(look.status).toBe(200);
    const token = new URL(mail.link).searchParams.get('token')!;
    const post = await fetch(`${as.url}/api/devices/recovery/link`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ token }) });
    if (post.status !== 200) return { refused: await codeOf(post), status: post.status };
    cookie = /(?:__Host-)?hap-recovery=([^;]+)/.exec(post.headers.get('set-cookie') ?? '')![1];
  }
  // 3. reload the address: now it shows the form (with the CSRF token) in this browser
  let csrf = 'x';
  if (cookie) {
    const page = await fetch(pageAddress, { redirect: 'manual', headers: { cookie: `hap-recovery=${cookie}` } });
    if (page.status === 200) csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1];
  }
  const res = await fetch(`${as.url}/api/devices/recovery/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie: `hap-recovery=${cookie}` } : {}),
      ...(o.otherCredentials ? { cookie: 'hap-session=abc', authorization: 'Bearer abc', 'x-api-key': 'hap_abc' } : {}),
      ...(o.crossSite ? { 'sec-fetch-site': 'cross-site' } : {}),
    },
    body: formBody({ handoff: mail.handoff, port: pu.searchParams.get('port')!, state: pu.searchParams.get('state')!, csrf: o.wrongCsrf ? 'nope' : csrf }),
  });
  if (res.status === 302) return { redirect: res.headers.get('location')!, cookie };
  return { refused: await codeOf(res), status: res.status };
}

/** `pressButton`, then the redirect is followed to the gateway's loopback address. */
async function browser(as: StubAs, w: Gw, started: Reply, o: BrowserOpts = {}): Promise<{ refused: string } | { redirect: string; callback: Reply }> {
  const r = await pressButton(as, started, o);
  if ('refused' in r) return r;
  const cb = new URL(r.redirect);
  expect(cb.hostname).toBe('127.0.0.1');
  expect(Number(cb.port)).toBe(w.gw.port);
  const keys = [...cb.searchParams.keys()].sort();
  expect(keys[1]).toBe('state');
  expect(['code', 'error']).toContain(keys[0]); // no port and no handoff id in the redirect
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

/** The same data folder after a restart: a new process (new Vault, new sessions), signed in to the page again. */
async function restart(as: StubAs, w: Gw, o: { platform?: PlatformHelper } = {}): Promise<Gw> {
  const dir = w.gw.dir;
  await w.gw.close();
  open.splice(open.findIndex(x => x === w.gw), 1);
  return boot(as, { dir, fresh: false, ...o });
}

/** A POST with a body exactly as given (not JSON.stringify'd), for the malformed-body cases. */
function rawPost(w: Gw, path: string, payload: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: w.gw.port, method: 'POST', path, headers: { ...w.h, host: `127.0.0.1:${w.gw.port}`, origin: `http://127.0.0.1:${w.gw.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
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
    // the only requests that carry the recovery cookie are the browser's own (the page and the form post), never the gateway's
    for (const r of as.requests) {
      if (!['/api/devices/recovery/authorize', '/recover'].includes(r.path.split('?')[0])) expect(r.headers.cookie, r.path).toBeUndefined();
      expect(r.headers['x-api-key']).toBeUndefined();
    }
    // the answer tells the person what to do, without a way round the mailed link
    expect(start.body).toMatchObject({ checkEmail: true, sameBrowser: true });
    expect([...new URL(String(start.body.pageUrl)).searchParams.keys()].sort()).toEqual(['handoff', 'port', 'state']);
    expect(as.emails).toHaveLength(1);
    // the hand-off posts carry no credential at all: the entry, the challenge, the port and the state's hash are the whole of them
    const stageBody = JSON.parse(as.requests.find(r => r.path === '/api/devices/recovery/handoffs')!.body);
    expect(Object.keys(stageBody).sort()).toEqual(['code_challenge', 'entry', 'port', 'state_hash']);
    expect(stageBody.port).toBe(fresh.gw.port);
    for (const r of recoveryRequests(as)) expect(r.headers.authorization).toBeUndefined();
    // the redirect the browser follows carries `code` and `state`, nothing of the account
    expect(recoveryRequests(as).map(r => r.path)).toEqual(['/api/devices/recovery/chain', '/api/devices/recovery/handoffs', '/api/devices/recovery/link', '/api/devices/recovery/authorize', '/api/devices/recovery/redeem']);
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

  it('a body that is not JSON is refused with nothing of it in the answer or the log, on EVERY /auth route that takes a secret', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as, { platform: fakeHost() });
    const compact = acct.code.replace(/-/g, '');
    const paths = ['/auth/device/recover/start', '/auth/device/rotate-root/submit', '/auth/platform/check-key/reset', '/auth/platform/enable', '/auth/unlock', '/auth/device/setup/finish'];
    for (const path of paths) {
      const raw = await rawPost(fresh, path, `{"password": "hunter2-secret", "recoveryCode": ${acct.code} "code": ${acct.code}`); // not JSON
      expect(raw.status, path).toBe(400);
      expect(raw.text.includes(compact.slice(4, 16)), path).toBe(false);
      expect(raw.text.includes('SV1'), path).toBe(false);
      expect(raw.text.includes('hunter2'), path).toBe(false);
    }
    expect(logs.join('\n').includes(compact.slice(4, 16))).toBe(false);
    expect(logs.join('\n').includes('SV1-')).toBe(false);
    expect(logs.join('\n').includes('hunter2')).toBe(false);
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

  it('a recovery start that is still running counts as pending: a set-up cannot start under it, and the other way round', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const f = await boot(as, { platform: fakeHost({ FAKE_TOUCH: 'slow' }) });
    const rec = f.post('/auth/device/recover/start', { code: acct.code, checkKey: true });
    // wait until the start is running (not for a fixed time: a loaded machine is slower)
    for (let i = 0; i < 100 && !((await f.get('/auth/device/status')).body.recovery as { recoveryPending?: boolean } | undefined)?.recoveryPending; i++) await sleep(20);
    expect((await f.get('/auth/device/status')).body.recovery).toMatchObject({ recoveryPending: true });
    const setup = await f.post('/auth/device/setup/start');
    expect(setup.status).toBe(409);
    expect(setup.body.code).toBe('recovery_pending');
    expect((await rec).status).toBe(200);

    const g = await boot(as, { platform: fakeHost({ FAKE_TOUCH: 'slow' }) });
    const su = g.post('/auth/device/setup/start', { checkKey: true });
    await sleep(250);
    const blocked = await g.post('/auth/device/recover/start', { code: acct.code });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('setup_pending');
    expect((await su).status).toBe(200);
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

  it('the callback needs the state this gateway made, once: a guessed and a replayed one change nothing', async () => {
    const { as, fresh, start } = await started();
    const r = await pressButton(as, start);
    const cb = new URL((r as { redirect: string }).redirect);
    const code = cb.searchParams.get('code')!;
    const state = cb.searchParams.get('state')!;

    const wrong = await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}&state=${b64uEncode(new Uint8Array(32))}`);
    expect(wrong.status).toBe(400);
    expect(as.requests.filter(x => x.path.endsWith('/redeem'))).toHaveLength(0);
    for (const bad of ['', 'x', 'a'.repeat(200)]) expect((await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}&state=${bad}`)).status).toBe(400);
    expect((await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}`)).status).toBe(400);
    expect((await call(fresh.gw.port, 'GET', `/recover/callback?code=${code}&handoff=${state}`)).status).toBe(400);

    expect((await call(fresh.gw.port, 'GET', cb.pathname + cb.search)).status).toBe(200);
    expect((await call(fresh.gw.port, 'GET', cb.pathname + cb.search)).status).toBe(400); // spent
    expect(as.requests.filter(x => x.path.endsWith('/redeem'))).toHaveLength(1);
    // the redeem carries the code and the verifier; the state went only to the page and the stage (as a hash)
    const redeem = JSON.parse(as.requests.find(x => x.path.endsWith('/redeem'))!.body);
    expect(Object.keys(redeem).sort()).toEqual(['code', 'code_verifier']);
    const stage = JSON.parse(as.requests.find(x => x.path.endsWith('/handoffs'))!.body);
    expect(stage.state_hash).toBe(createHash('sha256').update(state, 'utf8').digest('base64url'));
    expect(JSON.stringify(as.requests.filter(x => x.method === 'POST' && !x.path.endsWith('/authorize')).map(x => x.body)).includes(state)).toBe(false);
  });

  it('a hand-off that waited past its time is refused', async () => {
    const { as, fresh, start } = await started();
    const r = await pressButton(as, start);
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

  it('only the mailed link\'s cookie authorises: no link, another recovery\'s cookie, a dashboard session, an API key, a device token, a cross-site post or a missing CSRF token append nothing', async () => {
    for (const [name, o, code] of [
      ['no link', { noLink: true }, 'EMAIL_LINK_SESSION_REQUIRED'],
      ['other credentials', { otherCredentials: true }, 'EMAIL_LINK_SESSION_REQUIRED'],
      ['another recovery\'s cookie', { cookie: 'AAAA' }, 'EMAIL_LINK_SESSION_REQUIRED'],
      ['cross-site', { crossSite: true }, 'CROSS_SITE'],
      ['wrong csrf', { wrongCsrf: true }, 'CSRF_INVALID'],
    ] as Array<[string, BrowserOpts, string]>) {
      const { as, fresh, start } = await started();
      const b = await browser(as, fresh, start, o);
      expect(b, name).toMatchObject({ refused: code });
      expect(as.chainEntries(), name).toHaveLength(1);
      expect((await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId })).body.code, name).toBe('recovery_not_done');
    }
  });

  it('the cookie of an OLDER recovery is refused for the newer one (HANDOFF_OTHER, a page, not a redirect)', async () => {
    const { as, acct, fresh, start } = await started();
    const token = new URL(as.emails[0].link).searchParams.get('token')!;
    const post = await fetch(`${as.url}/api/devices/recovery/link`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ token }) });
    const oldCookie = /(?:__Host-)?hap-recovery=([^;]+)/.exec(post.headers.get('set-cookie') ?? '')![1];
    as.expireHandoffs();
    const other = await boot(as);
    const s2 = await other.post('/auth/device/recover/start', { code: acct.code });
    expect(s2.status).toBe(200);
    expect(await browser(as, other, s2, { cookie: oldCookie, email: 1 })).toMatchObject({ refused: 'HANDOFF_OTHER' });
    expect(as.chainEntries()).toHaveLength(1);
    void fresh; void start;
  });

  it('the emailed link: a GET shows a button and spends nothing, the POST works once, and a refusal there is its own code', async () => {
    const { as } = await started();
    const mail = as.emails[0];
    for (let i = 0; i < 3; i++) expect((await fetch(mail.link, { redirect: 'manual' })).status).toBe(200); // a mail scanner opening it
    const token = new URL(mail.link).searchParams.get('token')!;
    const post = () => fetch(`${as.url}/api/devices/recovery/link`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ token }) });
    expect((await post()).status).toBe(200);
    const again = await post();
    expect(again.status).toBe(410);
    expect(await codeOf(again)).toBe('LINK_INVALID');
  });

  it('one open hand-off per account: a new start replaces the old, whose link then no longer works', async () => {
    const { as, acct, fresh, start } = await started();
    const other = await boot(as);
    const s2 = await other.post('/auth/device/recover/start', { code: acct.code });
    expect(s2.status).toBe(200);
    const stale = await browser(as, fresh, start, { email: 0 });
    // the old link no longer works at all
    expect(stale).toMatchObject({ refused: 'LINK_INVALID' });
    expect(as.chainEntries()).toHaveLength(1);
    expect((await browser(as, other, s2, { email: 1 }))).toHaveProperty('callback');
    expect((await other.post('/auth/device/recover/finish', { recoveryId: s2.body.recoveryId })).status).toBe(200);
  });

  it('an unsendable email is its own refusal and nothing is kept', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    as.mailFails = true;
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('mail_failed');
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
  });

  it('a lookup is answered once: every call builds a fresh one (its time only rises), and a recorded one replayed gets NO_CHAIN', async () => {
    const { as, acct, fresh } = await started();
    await fresh.post('/auth/device/recover/cancel');
    expect((await fresh.post('/auth/device/recover/start', { code: acct.code })).status).toBe(200); // same second, same key
    await fresh.post('/auth/device/recover/cancel');
    expect((await fresh.post('/auth/device/recover/start', { code: acct.code })).status).toBe(200);
    const lookups = as.requests.filter(r => r.path === '/api/devices/recovery/chain').map(r => JSON.parse(r.body));
    expect(lookups).toHaveLength(3);
    for (const l of lookups) expect(Object.keys(l.lookup).sort()).toEqual(['aud', 'issued_at', 'root_pub', 'typ', 'v']);
    expect(lookups[1].lookup.issued_at).toBeGreaterThan(lookups[0].lookup.issued_at);
    expect(lookups[2].lookup.issued_at).toBeGreaterThan(lookups[1].lookup.issued_at);
    const replay = await fetch(`${as.url}/api/devices/recovery/chain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lookups[0]) });
    expect(replay.status).toBe(404);
  });

  it('a reset closes an open request for a new identity: the next sign-in says so and the alarm ends', async () => {
    const { as, old, fresh, start } = await started();
    as.openReset();
    await old.post('/auth/device/signin');
    expect((await old.get('/auth/device/status')).body.pendingIdentityReset).toBeTruthy();
    await browser(as, fresh, start);
    expect((await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId })).status).toBe(200);
    expect((await fresh.get('/auth/device/status')).body.pendingIdentityReset).toBeNull();
    expect(as.pendingReset).toBeNull();
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

  it('the chain moved after the entry was built: the append is refused, the redirect says why, the gateway keeps nothing', async () => {
    const { as, acct, fresh, start } = await started();
    const other = await boot(as);
    const s2 = await other.post('/auth/device/recover/start', { code: acct.code }); // replaces the first hand-off
    expect((await browser(as, other, s2, { email: 1 }))).toHaveProperty('callback');
    expect((await other.post('/auth/device/recover/finish', { recoveryId: s2.body.recoveryId })).status).toBe(200);
    // the first person's link was replaced: it does not even open
    expect(await browser(as, fresh, start, { email: 0 })).toMatchObject({ refused: 'LINK_INVALID' });
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`);
    expect(st.body).toMatchObject({ state: 'waiting' });
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(409);
    expect(new DeviceChainStore(fresh.gw.vault).read()).toBeNull();
  });

  it('a refused append comes back as ?error=<code>: the gateway reports it, and nothing is stored', async () => {
    const { as, acct, fresh, start } = await started();
    // the first person has used the link and has the page open
    const token = new URL(as.emails[0].link).searchParams.get('token')!;
    const post = await fetch(`${as.url}/api/devices/recovery/link`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ token }) });
    const cookie1 = /(?:__Host-)?hap-recovery=([^;]+)/.exec(post.headers.get('set-cookie') ?? '')![1];
    // another recovery moves the chain meanwhile
    const other = await boot(as);
    const s2 = await other.post('/auth/device/recover/start', { code: acct.code });
    expect((await browser(as, other, s2, { email: 1 }))).toHaveProperty('callback');
    expect((await other.post('/auth/device/recover/finish', { recoveryId: s2.body.recoveryId })).status).toBe(200);
    as.revive(as.emails[0].handoff);
    const b = await browser(as, fresh, start, { cookie: cookie1, email: 0 });
    expect('callback' in b && b.callback.status).toBe(200);
    const st = await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`);
    expect(st.body).toMatchObject({ state: 'failed', code: 'handoff_refused', asCode: 'CHAIN_HEAD_MOVED' });
    const fin = await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    expect(fin.status).toBe(409);
    expect(new DeviceChainStore(fresh.gw.vault).read()).toBeNull();
  });

  it('a suspended account or an unknown root DID at stage is the one 404 NO_CHAIN; the gateway keeps nothing', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    as.suspended = true;
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('recovery_code_unknown');
    expect(fresh.gw.vault.hasSecretSlot('deviceRecoveryPending')).toBe(false);
  });

  it('an account suspended after the stage comes back as ?error=ACCOUNT_SUSPENDED: reported, nothing stored', async () => {
    const { as, fresh, start } = await started();
    as.suspended = true;
    const b = await browser(as, fresh, start);
    expect('callback' in b && b.callback.status).toBe(200);
    expect((await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`)).body).toMatchObject({ state: 'failed', asCode: 'ACCOUNT_SUSPENDED' });
    expect(new DeviceChainStore(fresh.gw.vault).read()).toBeNull();
  });

  it('an open request for a new identity is shown at the start (the lookup says so), and a lookup that sends it as null is refused', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const o = as.openReset();
    const fresh = await boot(as);
    const r = await fresh.post('/auth/device/recover/start', { code: acct.code });
    expect(r.status).toBe(200);
    expect(r.body.pendingIdentityReset).toEqual({ id: o.id, effectiveAt: o.effective_at });
    await fresh.post('/auth/device/recover/cancel');
    as.lookupMutate = x => ({ ...x, pending_identity_reset: null });
    const g = await boot(as);
    const bad = await g.post('/auth/device/recover/start', { code: acct.code });
    expect(bad.status).toBe(502);
    expect(bad.body.code).toBe('as_answer_invalid');
  });

  it('the gateway never posts a root-signed entry to /api/devices/chain, and the Authority Server refuses one that is sent there', async () => {
    const { as, acct, fresh, start } = await started();
    await browser(as, fresh, start);
    await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId });
    const posts = as.requests.filter(r => r.method === 'POST' && r.path === '/api/devices/chain').map(r => JSON.parse(r.body).entry.op);
    expect(posts).toEqual(['genesis']); // the old computer's set-up, nothing of recovery
    const rootSigned = (as.chainEntries() as ChainEntry[])[1];
    const r = await fetch(`${as.url}/api/devices/chain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: rootSigned }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { errors: Array<{ code: string }> }).errors[0].code).toBe('ROOT_ENTRY_VIA_HANDOFF');
    void acct;
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
    expect(Object.keys(slot).sort()).toEqual(['confirmCode', 'entry', 'entryHash', 'expiresAt', 'id', 'keyId', 'kind', 'label', 'rootDid', 'v']);
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

  it('cancel drops a started recovery that the Authority Server does not hold, and its sealed slot; the same code can start again', async () => {
    const { as, acct, fresh, start } = await started();
    const c = await fresh.post('/auth/device/recover/cancel');
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ cancelled: true });
    expect(fresh.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
    expect((await fresh.post('/auth/device/recover/finish', { recoveryId: start.body.recoveryId })).status).toBe(404);
    as.expireHandoffs();
    expect((await fresh.post('/auth/device/recover/start', { code: acct.code })).status).toBe(200);
  });

  it('cancel AFTER the person pressed the button completes the recovery instead of stranding this computer (check key kept)', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as, { platform: fakeHost() });
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code, checkKey: true });
    expect(start.status).toBe(200);
    expect('callback' in await browser(as, fresh, start)).toBe(true);
    expect((await fresh.get(`/auth/device/recover/status?recoveryId=${start.body.recoveryId}`)).body.state).toBe('authorised');
    const c = await fresh.post('/auth/device/recover/cancel');
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ completed: { rootDid: acct.rootDid, signedIn: true, head: { seq: 1 } } });
    expect(new DeviceChainStore(fresh.gw.vault).exists()).toBe(true);
    expect(fresh.gw.checkStore.has()).toBe(true);
    expect(fresh.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
  });

  it('cancel does not drop what it cannot check: an Authority Server that is down leaves the recovery as it was', async () => {
    const { as, fresh, start } = await started();
    await browser(as, fresh, start);
    await as.close();
    open.splice(open.findIndex(x => x === as), 1);
    const c = await fresh.post('/auth/device/recover/cancel');
    expect(c.status).toBe(502);
    expect(['as_unreachable', 'as_unverified']).toContain(c.body.code);
    expect(fresh.gw.vault.getSecretSlot('deviceRecoveryPending')).not.toBeNull();
  });

  it('a computer that is already the active device of the chain takes it over instead of being refused (a cancel that dropped an appended entry)', async () => {
    const { as, acct, fresh, start } = await started();
    await browser(as, fresh, start);
    // the pending state is gone (it was dropped, or the vault slot was lost), the Authority Server holds our entry
    fresh.gw.vault.setSecretSlot('deviceRecoveryPending', null);
    const gw2 = await restart(as, fresh);
    const again = await gw2.post('/auth/device/recover/start', { code: acct.code });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ adopted: true, rootDid: acct.rootDid, signedIn: true, head: { seq: 1 } });
    expect(new DeviceChainStore(gw2.gw.vault).read()).toMatchObject({ rootDid: acct.rootDid, head: { seq: 1 } });
    expect(as.chainEntries()).toHaveLength(2); // nothing appended a second time
  });

  it('a takeover is refused where the chain names a check key this computer cannot show', async () => {
    const as = await newAs();
    const old = await boot(as);
    const acct = await setUp(as, old);
    const fresh = await boot(as, { platform: fakeHost() });
    const start = await fresh.post('/auth/device/recover/start', { code: acct.code, checkKey: true });
    await browser(as, fresh, start);
    fresh.gw.vault.setSecretSlot('deviceRecoveryPending', null); // the key blob was only in that slot
    const gw2 = await restart(as, fresh, { platform: fakeHost() });
    const again = await gw2.post('/auth/device/recover/start', { code: acct.code });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('check_unavailable');
    expect(new DeviceChainStore(gw2.gw.vault).exists()).toBe(false);
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

describe('turning on Touch ID for approvals on a computer set up without it (a root-signed set)', () => {
  async function withoutCheckKey() {
    const as = await newAs();
    const w = await boot(as, { platform: fakeHost() });
    const acct = await setUp(as, w, { checkKey: false });
    return { as, w, acct };
  }

  it('the recovery code signs a set naming THIS computer and a new platform key; the key checks it; after the email link the key is stored and the chain names it', async () => {
    const { as, w, acct } = await withoutCheckKey();
    expect(new CheckKeyStore(w.gw.vault).has()).toBe(false);
    const sub = await w.post('/auth/device/check-key/submit', { code: acct.code });
    expect(sub.status).toBe(200);
    expect(sub.body.confirmCode).toMatch(/^\d{6}$/);
    expect(JSON.stringify(sub.body)).not.toContain(acct.code);
    expect(as.chainEntries()).toHaveLength(1); // staged, not appended
    expect(new CheckKeyStore(w.gw.vault).has()).toBe(false); // nothing stored before the chain holds it
    const b = await browser(as, w, sub);
    expect('callback' in b && b.callback.status).toBe(200);
    const fin = await w.post('/auth/device/check-key/finish', { recoveryId: sub.body.recoveryId });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ ok: true, rootDid: acct.rootDid, head: { seq: 1 }, checkKey: true });

    const entries = as.chainEntries() as ChainEntry[];
    const e = entries[1];
    expect(e).toMatchObject({ op: 'set', signer: 'root', target: acct.keyId, device: null });
    expect(e.check).toMatchObject({ type: 'platform' });
    expect(e.sigs.map(s => s.by)).toEqual(['root']);
    expect(e.checks.map(c => c.by)).toEqual([acct.keyId]);
    const state = await verifyChain({ expectedRootDid: acct.rootDid, entries });
    expect(state.devices[acct.keyId].check).toEqual(e.check);
    expect(sub.body.confirmCode).toBe(confirmCodeOf(await entryHash(e)));
    const stored = new CheckKeyStore(w.gw.vault).read();
    expect(stored && e.check && stored.publicKey).toBeTruthy();
    expect(new DeviceChainStore(w.gw.vault).read()).toMatchObject({ head: { seq: 1, hash: await entryHash(e) } });
    expect((await w.post('/auth/device/signin')).status).toBe(200);
  });

  it('refused without a usable result: a wrong code, a computer that already has its key, no helper, a cancelled touch; nothing is staged', async () => {
    const { as, w, acct } = await withoutCheckKey();
    const other = (await generateRecoveryCode()).code;
    const wrong = await w.post('/auth/device/check-key/submit', { code: other });
    expect([wrong.status, wrong.body.code]).toEqual([409, 'recovery_code_wrong']);
    const g = await newAs();
    const has = await boot(g, { platform: fakeHost() });
    const hasAcct = await setUp(g, has, { checkKey: true });
    const present = await has.post('/auth/device/check-key/submit', { code: hasAcct.code });
    expect([present.status, present.body.code]).toEqual([409, 'check_key_present']);
    const c = await newAs();
    const cw = await boot(c, { platform: fakeHost({ FAKE_TOUCH: 'cancel' }) });
    const cAcct = await setUp(c, cw, { checkKey: false });
    const cancelled = await cw.post('/auth/device/check-key/submit', { code: cAcct.code });
    expect([cancelled.status, cancelled.body.code]).toEqual([409, 'cancelled']);
    expect(recoveryRequests(c).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(0);
    expect(recoveryRequests(as).filter(x => x.path.endsWith('/handoffs'))).toHaveLength(0);
  });

  it('L3: a stage the Authority Server refuses keeps no key anywhere; a cancel after staging drops it from the vault', async () => {
    const { as, w, acct } = await withoutCheckKey();
    as.mailFails = true;
    const failed = await w.post('/auth/device/check-key/submit', { code: acct.code });
    expect([failed.status, failed.body.code]).toEqual([502, 'mail_failed']);
    expect(w.gw.vault.hasSecretSlot('deviceRecoveryPending') && w.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeFalsy();
    expect(new CheckKeyStore(w.gw.vault).has()).toBe(false);
    as.mailFails = false;
    const sub = await w.post('/auth/device/check-key/submit', { code: acct.code });
    expect(sub.status).toBe(200);
    const slot = w.gw.vault.getSecretSlot<Record<string, unknown>>('deviceRecoveryPending')!;
    expect(slot.kind).toBe('set');
    expect(slot.checkKey).toBeTruthy(); // kept sealed while the email link is open, so a restart can finish
    expect((await w.post('/auth/device/recover/cancel')).status).toBe(200);
    expect(w.gw.vault.hasSecretSlot('deviceRecoveryPending') && w.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeFalsy();
    expect(new CheckKeyStore(w.gw.vault).has()).toBe(false);
  });

  it('finish before the email link is confirmed stores nothing and says the chain does not hold it yet', async () => {
    const { w, acct } = await withoutCheckKey();
    const sub = await w.post('/auth/device/check-key/submit', { code: acct.code });
    const fin = await w.post('/auth/device/check-key/finish', { recoveryId: sub.body.recoveryId });
    expect([fin.status, fin.body.code]).toEqual([409, 'recovery_not_done']);
    expect(new CheckKeyStore(w.gw.vault).has()).toBe(false);
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
    const si = await again.post('/auth/device/signin');
    expect(si.status, JSON.stringify(si.body)).toBe(200);
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

  it('a new code whose key another account holds is refused at stage with its own code, and a second new code works', async () => {
    const { as, w, acct } = await granting();
    const prep = await w.post('/auth/device/rotate-root/start');
    const taken = Buffer.from((await rootKeyFromRecoveryCode(String(prep.body.recoveryCode))).publicKey).toString('base64url');
    as.takenRootKeys.add(taken);
    const r = await w.post('/auth/device/rotate-root/submit', { rotateId: prep.body.rotateId, oldCode: acct.code, newCode: prep.body.recoveryCode });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('root_key_taken');
    expect(w.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
    const { sub } = await submit(w, acct.code);
    expect(sub.status).toBe(200);
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

  it('a rotation survives a restart in its sealed slot (no secret in it) and finish reports done from the chain', async () => {
    const { as, w, acct } = await granting();
    const { newCode, sub } = await submit(w, acct.code);
    await pressButton(as, sub); // the Authority Server appended; the redirect never reached this gateway
    const slot = w.gw.vault.getSecretSlot<Record<string, unknown>>('deviceRecoveryPending')!;
    expect(slot).toMatchObject({ kind: 'rotate', id: sub.body.recoveryId });
    expect(JSON.stringify(slot).includes(newCode.replace(/-/g, '').slice(4, 16))).toBe(false);
    expect(JSON.stringify(slot).includes(acct.code.replace(/-/g, '').slice(4, 16))).toBe(false);
    const w2 = await restart(as, w, { platform: fakeHost() });
    expect((await w2.get('/auth/device/status')).body.recovery).toMatchObject({ recoveryPending: true, kind: 'rotate' });
    expect((await w2.post('/auth/device/rotate-root/start')).body.code).toBe('recovery_pending');
    const fin = await w2.post('/auth/device/rotate-root/finish', { recoveryId: sub.body.recoveryId });
    expect(fin.status).toBe(200);
    expect((fin.body.head as { seq: number }).seq).toBe(1);
    expect(new DeviceChainStore(w2.gw.vault).read()!.head.seq).toBe(1);
    expect(w2.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
  });

  it('a rotation that the Authority Server does not hold is reported as not done after a restart, and cancel drops it', async () => {
    const { as, w, acct } = await granting();
    const { sub } = await submit(w, acct.code);
    const w2 = await restart(as, w, { platform: fakeHost() });
    const fin = await w2.post('/auth/device/rotate-root/finish', { recoveryId: sub.body.recoveryId });
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('recovery_not_done');
    expect(new DeviceChainStore(w2.gw.vault).read()!.head.seq).toBe(0);
    expect((await w2.post('/auth/device/recover/cancel')).body).toMatchObject({ cancelled: true });
    expect(w2.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
  });

  it('a lock while the Authority Server is answering the stage ends the rotation cleanly: nothing is kept', async () => {
    const { as, w, acct } = await granting();
    const prep = await w.post('/auth/device/rotate-root/start');
    as.stageDelayMs = 400;
    const pending = w.post('/auth/device/rotate-root/submit', { rotateId: prep.body.rotateId, oldCode: acct.code, newCode: prep.body.recoveryCode });
    await sleep(200);
    w.gw.vault.clearKey();
    const r = await pending;
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('locked');
    const w2 = await restart(as, w, { platform: fakeHost() });
    expect(w2.gw.vault.getSecretSlot('deviceRecoveryPending')).toBeNull();
    expect((await w2.get('/auth/device/status')).body.recovery).toMatchObject({ recoveryPending: false });
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
    for (const raw of ['yes', {}, { id: 'x', effective_at: 1 }, { id: 'AAAAAAAAAAAAAAAAAAAAAA', effective_at: 'soon' }, []]) {
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

  it('the address names the handoff, the port and the state and nothing else, on the configured Authority Server', () => {
    const u = new URL(pageUrl('https://as.example', { handoffId: 'h'.repeat(20), port: 3401, state: 's'.repeat(43) }));
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
    expect(readPendingReset({ pending_identity_reset: null })).toBeNull(); // omitted is the contract; null is read as none too
    expect(readPendingReset({ pending_identity_reset: { id: 'A'.repeat(22), effective_at: 5 } })).toEqual({ id: 'A'.repeat(22), effectiveAt: 5 });
    for (const bad of [undefined, 1, {}, { id: 1, effective_at: 1 }, { id: 'A'.repeat(22), effective_at: -1 }, { id: 'A'.repeat(22), effective_at: 1.5 }, { id: 'A'.repeat(22) + '!', effective_at: 1 }]) {
      expect(readPendingReset({ pending_identity_reset: bad })).toBe('invalid');
    }
    expect(readPendingReset(null)).toBeNull();
  });

  it('a hand-off state works once, only for the right text, and only before its end', () => {
    const h = new LoopbackHandoff(3401, 's', 1000);
    expect(h.take('nope', 0)).toBe(false);
    expect(h.take('A'.repeat(43), 0)).toBe(false);
    expect(h.take(h.stateText, 1000)).toBe(false); // at its end
    expect(h.take(h.stateText, 999)).toBe(true);
    expect(h.take(h.stateText, 999)).toBe(false); // spent
    expect(h.challenge).toHaveLength(43);
    // what the Authority Server keeps: base64url(sha256(utf8(state text)))
    expect(h.stateHash).toBe(createHash('sha256').update(h.stateText, 'utf8').digest('base64url'));
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
