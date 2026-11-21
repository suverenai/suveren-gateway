/**
 * Review fixes for device-keys step 6, through the real routers, vault, page
 * sessions and the real session lock. Only the network to the Authority Server
 * (StubAs) and the MCP server's address (recorders) are stand-ins.
 *
 *  1. the device token's end never locks the vault
 *  2. a sign-in in flight across a lock and an unlock does not leave a half signed-in gateway
 *  3. a set-up whose genesis the AS stored, with local state lost, can be resumed
 *  5. a stored chain belongs to its Authority Server
 *  6. Connect on a gateway that listens on ::1
 *  7. the switch-off path does not load hap-core's device-keys module
 *  8. no key made at sign-in, an unreadable vault has its own code at /login
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { createSessionLock } from '../../lib/session-lock';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); vi.restoreAllMocks(); });

const until = async (fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timed out waiting');
};

async function world(opts: { listenHost?: string } = {}) {
  const clock = { t: Math.floor(Date.now() / 1000) };
  const as = await new StubAs({ now: () => clock.t }).listen();
  open.push(as);
  const gw = await bootGateway({ as, clock, ...opts });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const c = { connectTo: opts.listenHost };
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body, ...c });
  const get = (path: string) => call(gw.port, 'GET', path, { headers: h, ...c });
  return { as, gw, clock, h, post, get };
}
type World = Awaited<ReturnType<typeof world>>;

async function setUp(w: World) {
  const start = await w.post('/auth/device/setup/start');
  const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
  expect(fin.status).toBe(200);
  await w.gw.settled(); // the sign-in's background re-wrap: what a test counts afterwards is its own
  return start;
}

/** The session lock exactly as index.ts builds it, around the rig's vault and sign-in. */
function realLock(gw: GatewayRig) {
  const notified: string[] = [];
  const lock = createSessionLock({
    vault: gw.vault, port: gw.port,
    notifyFn: (t: string) => { notified.push(t); },
    unconfigureSessionFn: async () => {},
    emit: (() => true) as never,
    onDeviceSessionEnded: () => gw.signin!.sessionLost(),
  });
  return { lock, notified };
}

describe('1. the device token ending never locks the vault', () => {
  it('the token is not recorded as the session end, so the expiry scheduler has nothing to fire', async () => {
    const w = await world();
    await setUp(w);
    expect(w.gw.vault.getSessionExpiresAt()).toBeNull();
  });

  it('an outage around the renewal and a sleep past the token: the credential is dropped (calls fail visibly), the vault stays unlocked, and it signs in again when the AS is back', async () => {
    const w = await world();
    await setUp(w);
    const first = w.gw.vault.getSpCookie()!;
    // the Authority Server fails every chain fetch (an outage); the computer sleeps past the token's end
    w.as.failChainGets = 1000;
    w.clock.t += 3700;
    const discardsBefore = w.gw.discards.count;
    await w.gw.timers.fire(() => w.gw.discards.count > discardsBefore);
    expect(w.gw.vault.isUnlocked()).toBe(true);
    expect(w.gw.vault.getSpCookie()).toBeNull(); // no stale token to fall back on
    expect((await w.get('/auth/device/status')).body.signedIn).toBe(false);
    // it keeps trying, with growing waits, as long as the vault is unlocked
    for (let i = 0; i < 6; i++) {
      w.clock.t += 400;
      const n = w.as.requests.length;
      await w.gw.timers.fire(() => w.as.requests.length > n);
      expect(w.gw.vault.isUnlocked()).toBe(true);
      expect(w.gw.timers.pending.filter(t => t.live)).toHaveLength(1);
    }
    // the Authority Server is back
    w.as.failChainGets = 0;
    w.clock.t += 400;
    await w.gw.timers.fire(() => w.gw.vault.getSpCookie() !== null);
    expect(w.gw.vault.getSpCookie()).toMatch(/^Bearer /);
    expect(w.gw.vault.getSpCookie()).not.toBe(first);
    expect(w.gw.vault.isUnlocked()).toBe(true);
    expect((await w.get('/auth/device/status')).body.signedIn).toBe(true);
  });

  it('a 401 from the Authority Server (the real session lock) signs in again and does not lock', async () => {
    const w = await world();
    await setUp(w);
    const first = w.gw.vault.getSpCookie()!;
    const { lock, notified } = realLock(w.gw);
    lock();
    expect(w.gw.vault.isUnlocked()).toBe(true);
    await until(() => w.gw.vault.getSpCookie() !== null && w.gw.vault.getSpCookie() !== first);
    expect(w.gw.discards.count).toBeGreaterThanOrEqual(1);
    expect(notified).toEqual([]);
    expect(w.gw.vault.isUnlocked()).toBe(true);
  });

  it('a 401 on a COOKIE session still locks, exactly as before', async () => {
    const w = await world();
    w.gw.vault.setSpCookie('hap-session=abc');
    const { lock, notified } = realLock(w.gw);
    lock();
    expect(w.gw.vault.isUnlocked()).toBe(false);
    expect(notified.length).toBe(1);
  });

  it('explicit locks still lock: the page session ending ends the page session, a logout locks the vault', async () => {
    const w = await world();
    await setUp(w);
    const r = await call(w.gw.port, 'POST', '/auth/logout', { headers: w.h, body: {} });
    expect(r.status).toBe(200);
    expect(w.gw.vault.isUnlocked()).toBe(false);
  });
});

describe('2. a sign-in in flight across a lock and an unlock', () => {
  it('the unlock signs in as a first sign-in: the vault key goes to the MCP server, the person is known, the sweep runs', async () => {
    const w = await world();
    await setUp(w);
    expect(w.gw.vault.getSessionUser()).not.toBeNull();
    // pause the Authority Server's device challenge, so the renewal waits in flight
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const anyAs = w.as as unknown as { challenge: (...a: unknown[]) => void };
    const orig = anyAs.challenge.bind(w.as);
    let paused = false;
    anyAs.challenge = (...a: unknown[]) => { paused = true; void gate.then(() => orig(...a)); };
    const configuredBefore = w.gw.configured.length;
    const sweepsBefore = w.gw.sweeps.count;
    w.clock.t += 3300;
    const t = w.gw.timers.pending.find(x => x.live)!; t.live = false; t.fn(); // the renewal begins
    await until(() => paused);
    // the vault locks, then the person unlocks again, while the renewal still waits
    w.gw.vault.clearKey();
    anyAs.challenge = orig; // the unlock's own sign-in is answered at once
    await w.gw.unlock();
    await until(() => w.gw.sweeps.count > sweepsBefore);
    const sessionPosts = () => w.as.requests.filter(r => r.method === 'POST' && r.path === '/api/devices/session').length;
    const postsAfterUnlock = sessionPosts();
    const configuredAfterUnlock = w.gw.configured.length;
    release(); // the old renewal now gets its answer
    await new Promise(r => setTimeout(r, 300));
    // the cancelled renewal goes no further: no session opened, nothing handed to the MCP server
    expect(sessionPosts()).toBe(postsAfterUnlock);
    expect(w.gw.configured.length).toBe(configuredAfterUnlock);

    const last = w.gw.configured.slice(configuredBefore);
    expect(last.some(c => !!c.keyHex), 'the vault key reached the MCP server').toBe(true);
    expect(w.gw.vault.getSessionUser()).not.toBeNull();
    expect(w.gw.sweeps.count).toBe(sweepsBefore + 1);
    expect(w.gw.vault.getSpCookie()).toMatch(/^Bearer /);
    // nothing from the cancelled renewal was handed over: every configure after the unlock is the unlock's own
    expect(last.every(c => c.credential === w.gw.vault.getSpCookie() || !!c.keyHex || c.credential.startsWith('Bearer '))).toBe(true);
    expect(w.gw.configured.at(-1)!.credential).toBe(w.gw.vault.getSpCookie());
  });

  it('a sign-in that finishes after a lock hands nothing over and closes its session', async () => {
    const w = await world();
    await setUp(w);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const anyAs = w.as as unknown as { challenge: (...a: unknown[]) => void };
    const orig = anyAs.challenge.bind(w.as);
    let paused = false;
    anyAs.challenge = (...a: unknown[]) => { paused = true; void gate.then(() => orig(...a)); };
    const configured = w.gw.configured.length;
    w.clock.t += 3300;
    const t = w.gw.timers.pending.find(x => x.live)!; t.live = false; t.fn();
    await until(() => paused);
    w.gw.vault.clearKey();
    release();
    await new Promise(r => setTimeout(r, 300));
    expect(w.gw.configured.length).toBe(configured);
    expect(w.gw.vault.getSpCookie()).toBeNull();
    expect(w.gw.vault.isUnlocked()).toBe(false);
    expect(w.gw.timers.pending.filter(x => x.live)).toHaveLength(0);
  });
});

describe('2b. a lock while the session is being handed over', () => {
  it('nothing of it stays: the credential is discarded and the session is closed', async () => {
    const w = await world();
    await setUp(w);
    let release!: () => void;
    w.gw.configureGate.wait = new Promise<void>(r => { release = r; });
    const discards = w.gw.discards.count;
    w.clock.t += 3300;
    const t = w.gw.timers.pending.find(x => x.live)!; t.live = false; t.fn();
    await until(() => w.gw.configured.length >= 2);
    w.gw.vault.clearKey(); // the lock lands while the MCP hand-over is waiting
    w.gw.configureGate.wait = null;
    release();
    await until(() => w.gw.discards.count > discards);
    expect(w.as.requests.some(r => r.method === 'DELETE' && r.path === '/api/devices/session')).toBe(true);
    expect(w.gw.vault.getSpCookie()).toBeNull();
    expect(w.gw.vault.isUnlocked()).toBe(false);
  });
});

describe('3. a set-up whose genesis the Authority Server stored, with local state lost', () => {
  /** What an interrupted `finish` leaves: the AS holds this computer's genesis, this gateway never stored the chain. */
  async function interrupted(w: World) {
    const start = await w.post('/auth/device/setup/start');
    const pending = w.gw.vault.getSecretSlot<{ entry: unknown }>('deviceSetupPending')!;
    const posted = await fetch(`${w.as.url}/api/devices/chain`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: pending.entry, enrolment_code: w.as.issueEnrolmentCode() }),
    });
    expect(posted.status).toBe(201);
    return start;
  }

  it('after a lock: finish with no code finds the chain by this computer\'s own genesis and adopts it', async () => {
    const w = await world();
    const start = await interrupted(w);
    w.gw.vault.clearKey();
    const h = sessionHeaders(await w.gw.unlock());
    const fin = await call(w.gw.port, 'POST', '/auth/device/setup/finish', { headers: h, body: { setupId: start.body.setupId } });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ signedIn: true, rootDid: start.body.rootDid });
    expect(new DeviceChainStore(w.gw.vault).read()?.keyId).toBe(start.body.deviceKeyId);
    expect(w.gw.vault.getSecretSlot('deviceSetupPending')).toBeNull();
  });

  it('after a restart: a new process over the same folder resumes, with a used-up code or with none', async () => {
    const w = await world();
    const start = await interrupted(w);
    const dir = w.gw.dir;
    await w.gw.close();
    const again = await bootGateway({ as: w.as, dir, fresh: false });
    open.push(again);
    const h = sessionHeaders(await again.unlock());
    expect((await call(again.port, 'GET', '/auth/device/status', { headers: h })).body.setupPending).toBe(true);
    const used = w.as.issueEnrolmentCode();
    (w.as as unknown as { codes: Map<string, { used: boolean }> }).codes.get(used)!.used = true;
    const fin = await call(again.port, 'POST', '/auth/device/setup/finish', { headers: h, body: { setupId: start.body.setupId, enrolmentCode: used } });
    expect(fin.status).toBe(200);
    expect(fin.body.signedIn).toBe(true);
  });

  it('another computer\'s chain on the account is never adopted: with no code, the answer is a missing code', async () => {
    const w = await world();
    await setUp(w);
    const gw2 = await bootGateway({ as: w.as });
    open.push(gw2);
    const h2 = sessionHeaders(await gw2.unlock());
    const st = await call(gw2.port, 'POST', '/auth/device/setup/start', { headers: h2, body: {} });
    const fin = await call(gw2.port, 'POST', '/auth/device/setup/finish', { headers: h2, body: { setupId: st.body.setupId } });
    expect(fin.status).toBe(400);
    expect(fin.body.code).toBe('enrolment_code_missing');
    expect(new DeviceChainStore(gw2.vault).exists()).toBe(false);
    expect(gw2.vault.getSpCookie()).toBeNull();
  });

  it('with the Authority Server holding nothing of ours, no code is simply a missing code', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId });
    expect(fin.body.code).toBe('enrolment_code_missing');
    expect(new DeviceChainStore(w.gw.vault).exists()).toBe(false);
  });
});

describe('5. a stored chain belongs to its Authority Server', () => {
  it('another configured address: a clear code, and nothing is sent', async () => {
    const w = await world();
    await setUp(w);
    const store = new DeviceChainStore(w.gw.vault);
    w.gw.vault.setSecretSlot('deviceChain', { ...store.read()!, asUrl: 'https://another-as.example' });
    const before = w.as.requests.length;
    const r = await w.post('/auth/device/signin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('as_url_mismatch');
    expect(w.as.requests.length).toBe(before);
  });
});

describe('6. Connect on a gateway that listens on ::1', () => {
  it('Connect is refused with its own code; the pasted code path still sets up', async () => {
    let w: World;
    w = await world({ listenHost: '::1' });
    const start = await w.post('/auth/device/setup/start');
    const c = await w.post('/auth/device/setup/connect', { setupId: start.body.setupId });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('connect_loopback_unsupported');
    expect(c.text).not.toContain('authorizeUrl');
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(200);
  });
});

describe('8. small things', () => {
  it('sign-in never makes a device key: a vault without one answers key_missing and still has none', async () => {
    const w = await world();
    await setUp(w);
    w.gw.vault.setSecretSlot('deviceSigningKey', null);
    const sessions = w.as.requests.filter(r => r.path === '/api/devices/session').length;
    const r = await w.post('/auth/device/signin');
    expect(r.body.code).toBe('key_missing');
    expect(w.gw.vault.getSecretSlot('deviceSigningKey')).toBeNull();
    expect(w.as.requests.filter(x => x.path === '/api/devices/session').length).toBe(sessions);
  });

  it('/login on a vault that cannot be read says so with its own code, not use_device_signin', async () => {
    const w = await world();
    await setUp(w);
    writeFileSync(join(w.gw.dir, 'vault.enc.json'), '{ not json');
    const r = await call(w.gw.port, 'POST', '/auth/login', { headers: { ...w.h, 'x-api-key': 'hap_account_key' }, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('vault_unreadable');
  });

  it('/login on a locked gateway that has a chain still says use_device_signin', async () => {
    const w = await world();
    await setUp(w);
    w.gw.vault.clearKey();
    const r = await call(w.gw.port, 'POST', '/auth/login', { headers: { 'x-api-key': 'hap_account_key' }, body: {} });
    expect(r.body.code).toBe('use_device_signin');
  });

  it('the root key seed is zeroed after start, whether start worked or failed', async () => {
    const dk = await import('@hap/core/device-keys');
    const seeds: Uint8Array[] = [];
    const real = dk.deriveRootKey;
    const spy = vi.spyOn(dk, 'deriveRootKey').mockImplementation(async s => { const k = await real(s); seeds.push(k.privateSeed); return k; });
    expect(spy.getMockImplementation()).toBeDefined();
    const w = await world();
    await w.post('/auth/device/setup/start');
    expect(seeds).toHaveLength(1);
    expect(seeds[0].every(b => b === 0)).toBe(true);
    // a failure after the key was made
    await w.post('/auth/device/setup/cancel');
    vi.spyOn(w.gw.vault, 'hasPendingRekey').mockReturnValueOnce(false).mockReturnValue(true);
    const r = await w.post('/auth/device/setup/start');
    expect(r.status).toBe(409);
    expect(seeds).toHaveLength(2);
    expect(seeds[1].every(b => b === 0)).toBe(true);
  });
});

describe('7. the switch-off path does not load hap-core\'s device-keys module', () => {
  it('the control plane\'s modules load, the switch-off mount runs and the reading key works with the module unavailable', async () => {
    vi.resetModules();
    vi.doMock('@hap/core/device-keys', () => { throw new Error('device-keys was loaded'); });
    try {
      const express = (await import('express')).default;
      const { Vault } = await import('../../lib/vault');
      const keys = await import('../../lib/e2e-key-manager');
      const { mountDeviceKeyRoutes } = await import('../device-keys-mount');
      const { PageSessions } = await import('../../lib/page-session');
      const { UnlockLimiter } = await import('../../lib/unlock-limiter');
      const { ChangeConfirmations } = await import('../../lib/change-confirmation');
      await import('../device-setup');
      await import('../../lib/device-setup');
      await import('../../lib/device-signin');
      await import('../auth');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const vault = new Vault(mkdtempSync(join(tmpdir(), 'lazy-')), { scrypt: { N: 1024, r: 8, p: 1 } });
      await vault.deriveAndSetKey('hap_account_key');
      const app = express();
      const m = mountDeviceKeyRoutes(app, {
        enabled: false, vault, pageSession: { sessions: new PageSessions(), listensOnLoopbackOnly: true },
        limiter: new UnlockLimiter(), confirmations: new ChangeConfirmations(), hasCheckKey: () => false, internalSecret: () => 's',
      });
      expect(m.hasDeviceChain).toBeUndefined();
      // the reading key (what every gateway uses) never touches the module
      expect((await keys.loadOrGenerateKeyPair(vault)).publicKey).toHaveLength(32);
      expect(await keys.getPublicKey(vault)).not.toBeNull();
      // and the signing key, which needs it, fails here (so the mock really is in the way)
      await expect(keys.loadOrGenerateDeviceSigningKey(vault)).rejects.toThrow();
    } finally {
      vi.doUnmock('@hap/core/device-keys');
      vi.resetModules();
    }
  });
});

