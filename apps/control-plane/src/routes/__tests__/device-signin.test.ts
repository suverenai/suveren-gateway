/**
 * Sign-in by device key (device-keys plan 4.1, step 6) through the real routers:
 * after set-up the gateway talks to the Authority Server with a bearer token and
 * never the account key; the token is renewed by itself; a restart signs in again
 * after unlock; and what the Authority Server answers is verified with hap-core.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rootKeyFromRecoveryCode, buildEntry, buildDeviceRecord, signEntry, entryHash, ed25519PublicKey, b64uEncode,
  type ChainEntry,
} from '@hap/core/device-keys';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { CHECK_EVERY_MS } from '../../lib/device-signin';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });

const until = async (fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};

/** A gateway that set up device keys against a stub Authority Server, with the stub on the same clock. */
async function setUpWorld() {
  const clock = { t: Math.floor(Date.now() / 1000) };
  const as = await new StubAs({ now: () => clock.t }).listen();
  open.push(as);
  const gw = await bootGateway({ as, clock });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const get = (path: string) => call(gw.port, 'GET', path, { headers: h });
  const start = await post('/auth/device/setup/start');
  const fin = await post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status).toBe(200);
  const recoveryCode = String(start.body.recoveryCode);
  const rootDid = String(start.body.rootDid);
  const keyId = String(start.body.deviceKeyId);
  /** The root key adds a second computer (what a later step does from the recovery sheet). */
  const rootAdds = async (label: string, seq: number): Promise<ChainEntry> => {
    const entries = as.chainEntries() as ChainEntry[];
    const root = await rootKeyFromRecoveryCode(recoveryCode);
    const priv = randomBytes(32);
    const pub = await ed25519PublicKey(priv);
    const device = await buildDeviceRecord({ sign_pub: b64uEncode(pub), read_pub: b64uEncode(randomBytes(32)), kind: 'gateway', label, keystore: 'software' }, pub);
    const e = buildEntry({ root_did: rootDid, seq, prev: await entryHash(entries[seq - 1]), op: 'add', created_at: clock.t, signer: 'root', device });
    e.sigs.push(await signEntry(e, 'root', root.privateSeed), await signEntry(e, device.key_id, priv));
    return e;
  };
  const rootRemoves = async (target: string, seq: number): Promise<ChainEntry> => {
    const entries = as.chainEntries() as ChainEntry[];
    const root = await rootKeyFromRecoveryCode(recoveryCode);
    const e = buildEntry({ root_did: rootDid, seq, prev: await entryHash(entries[seq - 1]), op: 'remove', created_at: clock.t, signer: 'root', target });
    e.sigs.push(await signEntry(e, 'root', root.privateSeed));
    return e;
  };
  return { as, gw, clock, session, h, post, get, rootDid, keyId, recoveryCode, rootAdds, rootRemoves, store: new DeviceChainStore(gw.vault) };
}

const sessionCalls = (as: StubAs) => as.requests.filter(r => r.method === 'POST' && r.path === '/api/devices/session').length;

describe('the first sign-in', () => {
  it('opens a one-hour bearer session by challenge and a signed sign-in, and renews it before it ends', async () => {
    const w = await setUpWorld();
    const first = w.gw.vault.getSpCookie()!;
    expect(first).toMatch(/^Bearer /);
    const challenge = w.as.requests.find(r => r.path === '/api/devices/challenge')!;
    expect(JSON.parse(challenge.body)).toEqual({ key_id: w.keyId });
    const sent = JSON.parse(w.as.requests.find(r => r.path === '/api/devices/session')!.body) as { signin: Record<string, unknown>; sig: string };
    expect(sent.signin).toMatchObject({ typ: 'suveren-device-signin', v: 1, aud: w.as.pubkeyHex, root_did: w.rootDid, key_id: w.keyId, chain_seq: 0 });
    expect(sent.signin.issued_at).toBe(w.clock.t);

    // the clock is looked at every 30 seconds (a sleep must not hide a due renewal); nothing is due yet
    const live = w.gw.timers.pending.filter(t => t.live);
    expect(live).toHaveLength(1);
    expect(live[0].ms).toBe(CHECK_EVERY_MS);
    const tokens = w.as.requests.length;
    await w.gw.timers.fire();
    expect(w.as.requests.length).toBe(tokens);
    expect(w.gw.timers.pending.filter(t => t.live)).toHaveLength(1);

    // five minutes before the token ends, the next look renews it
    w.clock.t += 3600 - 300;
    await w.gw.timers.fire(() => w.gw.vault.getSpCookie() !== first);
    const second = w.gw.vault.getSpCookie()!;
    expect(second).toMatch(/^Bearer /);
    expect(second).not.toBe(first);
    // the MCP server got the new token and no vault key again; the sweep did not run twice
    expect(w.gw.configured.at(-1)).toEqual({ credential: second, keyHex: undefined });
    expect(w.gw.sweeps.count).toBe(1);
    // the new nonce, not the old one
    const nonces = w.as.requests.filter(r => r.path === '/api/devices/session').map(r => (JSON.parse(r.body) as { signin: { nonce: string } }).signin.nonce);
    expect(new Set(nonces).size).toBe(2);
    // and the next renewal is armed
    expect(w.gw.timers.pending.filter(t => t.live)).toHaveLength(1);
    expect((await w.get('/auth/device/status')).body.signedIn).toBe(true);
  });

  it('a renewal that cannot reach the Authority Server is tried again; a refusal that cannot pass is not', async () => {
    const w = await setUpWorld();
    w.clock.t += 3300;
    w.as.failChainGets = 1; // the chain fetch of the renewal answers 500
    await w.gw.timers.fire(() => w.gw.timers.pending.filter(t => t.live).length === 1);
    const retry = w.gw.timers.pending.filter(t => t.live);
    expect(retry).toHaveLength(1);
    expect(retry[0].ms).toBe(30_000);
    w.clock.t += 30;
    await w.gw.timers.fire(() => sessionCalls(w.as) >= 3 && w.gw.timers.pending.filter(t => t.live).length === 1);
    expect(sessionCalls(w.as)).toBe(3);
    expect(w.gw.vault.getSpCookie()).toMatch(/^Bearer /);
    // a removed device is refused, and still tried again (slowly): nothing here ever locks the vault
    w.as.removeDevice(w.keyId);
    w.clock.t += 3300;
    const sessionsBefore = sessionCalls(w.as);
    await w.gw.timers.fire(() => sessionCalls(w.as) > sessionsBefore);
    expect(w.gw.timers.pending.filter(t => t.live)).toHaveLength(1);
    expect(w.gw.vault.isUnlocked()).toBe(true);
  });

  it('locking the vault stops the renewal', async () => {
    const w = await setUpWorld();
    expect(w.gw.timers.pending.filter(t => t.live)).toHaveLength(1);
    w.gw.vault.clearKey();
    expect(w.gw.timers.pending.filter(t => t.live)).toHaveLength(0);
    expect(w.gw.vault.getSpCookie()).toBeNull();
  });

  it('two sign-ins at the same moment share one session request', async () => {
    const w = await setUpWorld();
    const before = sessionCalls(w.as);
    const [a, b] = await Promise.all([w.post('/auth/device/signin'), w.post('/auth/device/signin')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sessionCalls(w.as) - before).toBe(1);
  });
});

describe('a restart', () => {
  it('signs in again by device key after unlock, with no account key anywhere', async () => {
    const w = await setUpWorld();
    const before = w.gw.vault.getSpCookie();
    const dir = w.gw.dir;
    await w.gw.close();
    const second: GatewayRig = await bootGateway({ as: w.as, dir, fresh: false, clock: w.clock });
    open.push(second);
    expect(second.vault.isUnlocked()).toBe(false);
    expect(second.vault.getSpCookie()).toBeNull();
    const requestsBefore = w.as.requests.length;
    const s = await second.unlock();
    await until(() => second.vault.getSpCookie() !== null);
    const after = second.vault.getSpCookie()!;
    expect(after).toMatch(/^Bearer /);
    expect(after).not.toBe(before);
    expect(second.configured.at(-1)).toMatchObject({ credential: after });
    expect(second.configured.at(-1)!.keyHex).toMatch(/^[0-9a-f]{64}$/);
    const st = await call(second.port, 'GET', '/auth/device/status', { headers: sessionHeaders(s) });
    expect(st.body).toMatchObject({ setUp: true, signedIn: true });
    for (const r of w.as.requests.slice(requestsBefore)) {
      expect(r.headers['x-api-key']).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
      expect(r.path).not.toMatch(/^\/api\/auth\//);
    }
  });

  it('a gateway that never set up does not call the Authority Server after unlock', async () => {
    const clock = { t: Math.floor(Date.now() / 1000) };
    const as = await new StubAs({ now: () => clock.t }).listen();
    open.push(as);
    const gw = await bootGateway({ as, clock });
    open.push(gw);
    await gw.unlock();
    await new Promise(r => setTimeout(r, 150));
    expect(as.requests).toHaveLength(0);
    expect(gw.vault.getSpCookie()).toBeNull();
    const s = await gw.unlock();
    expect((await call(gw.port, 'POST', '/auth/device/signin', { headers: sessionHeaders(s), body: {} })).body.code).toBe('not_set_up');
  });

  it('a gateway with a password and no chain still signs in with the account key: /login goes on to the Authority Server', async () => {
    const clock = { t: Math.floor(Date.now() / 1000) };
    const as = await new StubAs({ now: () => clock.t }).listen();
    open.push(as);
    const gw = await bootGateway({ as, clock });
    open.push(gw);
    const s = await gw.unlock();
    const r = await call(gw.port, 'POST', '/auth/login', { headers: { ...sessionHeaders(s), 'x-api-key': 'hap_account_key' }, body: {} });
    expect(r.status).not.toBe(409);
    const session = as.requests.find(x => x.path === '/api/auth/session');
    expect(session?.headers['x-api-key']).toBe('hap_account_key');
  });

  it('the account key no longer signs this gateway in: /login is refused before anything is sent', async () => {
    const w = await setUpWorld();
    const before = w.as.requests.length;
    const r = await call(w.gw.port, 'POST', '/auth/login', { headers: { ...w.h, 'x-api-key': 'hap_account_key' }, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('use_device_signin');
    expect(w.as.requests.length).toBe(before);
    // same with the variants of the path
    for (const p of ['/auth/login/', '/AUTH/LOGIN']) {
      expect((await call(w.gw.port, 'POST', p, { headers: { ...w.h, 'x-api-key': 'hap_account_key' }, body: {} })).status, p).toBe(409);
    }
  });
});

describe('the answer of the Authority Server is verified', () => {
  it('another key as `aud` is refused and no sign-in is sent', async () => {
    const w = await setUpWorld();
    const before = sessionCalls(w.as);
    w.as.audOverride = 'ab'.repeat(32);
    const r = await w.post('/auth/device/signin');
    expect(r.body).toMatchObject({ code: 'aud_mismatch' });
    expect(sessionCalls(w.as)).toBe(before);
  });

  it('a clock far from the Authority Server\'s is refused by it (STALE) and shown as such', async () => {
    const w = await setUpWorld();
    w.gw.clock.t += 1000; // the gateway's clock only; the stub keeps its own
    // the stub shares `clock`; move ITS clock back by giving it a separate one
    (w.as as unknown as { now: () => number }).now = () => w.clock.t - 1000;
    const r = await w.post('/auth/device/signin');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'signin_refused', asCode: 'STALE' });
  });

  it('a token that is not a token (a header break) is refused and never stored', async () => {
    const w = await setUpWorld();
    const before = w.gw.vault.getSpCookie();
    w.as.badToken = true;
    const r = await w.post('/auth/device/signin');
    expect(r.body.code).toBe('as_answer_invalid');
    expect(w.gw.vault.getSpCookie()).toBe(before);
  });

  it('a session for another person\'s DID is refused', async () => {
    const w = await setUpWorld();
    const before = w.gw.configured.length;
    w.as.wrongUserDid = true;
    expect((await w.post('/auth/device/signin')).body.code).toBe('as_answer_invalid');
    expect(w.gw.configured.length).toBe(before);
    // the session that was opened is closed again
    expect(w.as.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/devices/session' });
  });

  it('a head that is not the head of the chain it serves is refused', async () => {
    const w = await setUpWorld();
    w.as.headOverride = { seq: 0, hash: `sha256:${'1'.repeat(64)}` };
    const r = await w.post('/auth/device/signin');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('head_mismatch');
    expect(w.as.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/devices/session' });
  });

  it('a session that names another head than the chain it serves is refused', async () => {
    const w = await setUpWorld();
    w.as.sessionHeadOverride = { seq: 0, hash: `sha256:${'2'.repeat(64)}` };
    expect((await w.post('/auth/device/signin')).body.code).toBe('head_mismatch');
    expect(w.as.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/devices/session' });
  });

  it('a redirect is never followed: the token does not travel to another host', async () => {
    const w = await setUpWorld();
    const elsewhere = createServer((req, res) => { hits.push({ path: req.url ?? '', authorization: req.headers.authorization }); res.writeHead(200); res.end('{}'); });
    const hits: Array<{ path: string; authorization?: string }> = [];
    await new Promise<void>(r => elsewhere.listen(0, '127.0.0.1', r));
    open.push({ close: () => new Promise<void>(r => { elsewhere.closeAllConnections?.(); elsewhere.close(() => r()); }) });
    w.as.redirectChainTo = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/steal`;
    const r = await w.post('/auth/device/signin');
    expect(r.body.code).toBe('as_unreachable');
    expect(hits).toEqual([]);
  });

  it('an Authority Server that is not the one this gateway paired with gets no sign-in', async () => {
    const w = await setUpWorld();
    const before = w.as.requests.length;
    // the pairing on file names another signing key for this address
    writeFileSync(join(w.gw.dir, 'as-pairing.json'), JSON.stringify({ asUrl: w.as.url, publicKeyHex: 'cd'.repeat(32), pairedAt: 'x' }));
    const r = await w.post('/auth/device/signin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('as_key_mismatch');
    expect(w.as.requests.slice(before).some(x => x.path.startsWith('/api/devices/'))).toBe(false);
  });

  it('a key in the vault that is not the key of the stored chain signs nothing', async () => {
    const w = await setUpWorld();
    w.gw.vault.setSecretSlot('deviceSigningKey', { privateKey: b64uEncode(randomBytes(32)), publicKey: b64uEncode(randomBytes(32)) });
    const r = await w.post('/auth/device/signin');
    expect(r.body.code).toBe('key_mismatch');
    expect(sessionCalls(w.as)).toBe(1);
  });

  it('a chain that grew is verified from the genesis and the stored head moves forward', async () => {
    const w = await setUpWorld();
    await w.as.appendEntry(await w.rootAdds('Second Mac', 1));
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    expect(w.store.read()?.head.seq).toBe(1);
    expect(w.store.read()?.head.hash).toBe(await entryHash((w.as.chainEntries() as ChainEntry[])[1]));
    // and the next sign-in names the new head
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    const last = JSON.parse(w.as.requests.filter(r => r.path === '/api/devices/session').at(-1)!.body) as { signin: { chain_seq: number } };
    expect(last.signin.chain_seq).toBe(1);
  });

  it('a chain that is shorter than the verified one is a rollback: the sign-in is refused and the head stays', async () => {
    const w = await setUpWorld();
    await w.as.appendEntry(await w.rootAdds('Second Mac', 1));
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    const established = w.gw.configured.length;
    w.as.truncateStateBy = 1;
    const r = await w.post('/auth/device/signin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('chain_rollback');
    expect(w.gw.alarms).toContain('chain_rollback');
    expect(w.store.read()?.head.seq).toBe(1);
    expect(w.gw.configured.length).toBe(established);
  });

  it('a chain served shorter than the verified one is a rollback too, and the opened session is closed', async () => {
    const w = await setUpWorld();
    await w.as.appendEntry(await w.rootAdds('Second Mac', 1));
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    w.as.truncateServedBy = 1;
    const r = await w.post('/auth/device/signin');
    expect(r.body.code).toBe('chain_rollback');
    expect(w.as.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/devices/session' });
    expect(w.store.read()?.head.seq).toBe(1);
  });

  it('another chain with the same genesis is a fork: refused, head unchanged', async () => {
    const w = await setUpWorld();
    await w.as.appendEntry(await w.rootAdds('Second Mac', 1));
    expect((await w.post('/auth/device/signin')).status).toBe(200);
    const genesis = (w.as.chainEntries() as ChainEntry[])[0];
    await w.as.setEntries([genesis, await w.rootAdds('Somebody else', 1)]);
    const r = await w.post('/auth/device/signin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('chain_fork');
    expect(w.gw.alarms).toContain('chain_fork');
    expect(w.store.read()?.head.hash).not.toBe(await entryHash((w.as.chainEntries() as ChainEntry[])[1]));
  });

  it('this computer removed from the chain: refused by the Authority Server, and refused again if a lying one lets it through', async () => {
    const w = await setUpWorld();
    await w.as.appendEntry(await w.rootAdds('Second Mac', 1));
    await w.as.appendEntry(await w.rootRemoves(w.keyId, 2));
    expect((await w.post('/auth/device/signin')).body).toMatchObject({ code: 'signin_refused', asCode: 'NOT_ACTIVE' });
    // a lying Authority Server issues the session anyway: the verified chain shows this computer removed
    w.as.skipSigninChecks = true;
    const r = await w.post('/auth/device/signin');
    expect(r.body.code).toBe('device_removed');
    expect(w.gw.alarms).toContain('device_removed');
    expect(w.as.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/devices/session' });
  });
});

describe('logout and the proxy', () => {
  it('logout ends a device session where it was opened, and locks', async () => {
    const w = await setUpWorld();
    const cred = w.gw.vault.getSpCookie()!;
    const r = await call(w.gw.port, 'POST', '/auth/logout', { headers: w.h, body: {} });
    expect(r.status).toBe(200);
    const del = w.as.requests.find(x => x.method === 'DELETE' && x.path === '/api/devices/session')!;
    expect(del.headers.authorization).toBe(cred);
    expect(del.headers.cookie).toBeUndefined();
    expect(w.as.requests.some(x => x.path === '/api/auth/logout')).toBe(false);
    expect(w.gw.vault.isUnlocked()).toBe(false);
  });
});
