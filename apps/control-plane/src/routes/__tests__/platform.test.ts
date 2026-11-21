/**
 * Unlock by Touch ID and this computer's check key (device-keys plan step 5a), through the REAL routers,
 * vault, page sessions and the real native helper process. Only the Authority Server's network is a stand-in
 * (StubAs, over HTTP on port 0, verifying with hap-core).
 *
 * WHICH HELPER EACH TEST USES (no test shows a real Touch ID prompt; see packages/unlock-helper/DESIGN.md section 9):
 *   SOFT  the real Swift helper, debug build, `--backend software`: real process, real protocol, real wrap and
 *         signature code, P-256 keys without hardware, and never a touch. Skipped when the binary is not built.
 *   FAKE  packages/unlock-helper/test/fake-helper.mjs: only where a touch must be cancelled, slow or lying.
 *   NONE  a program or a location that is not a helper at all (a swapped binary, an unsupported computer).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChain, entryHash, type ChainEntry } from '@hap/core/device-keys';
import { UnlockHelperClient } from '@suveren/unlock-helper';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, sessionOf, tmpDir, FAST, PW, type Reply, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { PlatformHelper, locateHelper, sha256File, unlockKeyService, type HelperSpec, type Located } from '../../lib/platform-helper';
import { PlatformChecks, CheckKeyStore } from '../../lib/platform-checks';
import { ChangeConfirmations, CONFIRMATION_HEADER, canonicalJson } from '../../lib/change-confirmation';
import { Vault } from '../../lib/vault';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { PLATFORM_UNLOCK_OPENS_PAGE_SESSION } from '../platform';
import { unwrapKey, wrapKey, newKey } from '../../../../../packages/unlock-helper/test/fake-helper.mjs';

const PKG = '../../../../../packages/unlock-helper/';
// SUVEREN_TEST_HELPER: another debug build of the helper with a software backend (the Windows helper, windows/ in Go).
const SOFT = process.env.SUVEREN_TEST_HELPER ?? fileURLToPath(new URL(`${PKG}macos/.build/debug/suveren-unlock-helper`, import.meta.url));
const FAKE = fileURLToPath(new URL(`${PKG}test/fake-helper.mjs`, import.meta.url));
const haveSoft = (process.env.SUVEREN_TEST_HELPER !== undefined || process.platform === 'darwin') && existsSync(SOFT);
const soft = describe.skipIf(!haveSoft);
/** A test that needs the real Swift helper (debug build) skips where it was not built (Linux CI). */
const sit = it.skipIf(!haveSoft);

const hosts: PlatformHelper[] = [];
const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  for (const h of hosts.splice(0)) h.close();
  vi.restoreAllMocks();
});

const host = (spec: HelperSpec | Located): PlatformHelper => {
  const h = new PlatformHelper({ locate: () => ('spec' in spec || 'unavailable' in spec ? spec : { spec }), idleMs: 30, touchTimeoutMs: 20_000 });
  hosts.push(h);
  return h;
};
/** The real helper, software keys. */
const softHost = () => host({ command: SOFT, args: ['serve', '--backend', 'software', '--allow-any-caller'], files: [] });
/** The fake helper, with a behaviour switch (FAKE_TOUCH=cancel|slow|locked, FAKE_WRONG_SIGNATURE=1). */
const fakeHost = (env: Record<string, string> = {}) => host({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, files: [] });
const noHelper = (code: 'unsupported_arch' | 'unsupported_platform' | 'helper_not_installed' = 'unsupported_arch') => host({ unavailable: code });

async function world(o: { platform?: PlatformHelper; enabled?: boolean; dir?: string; fresh?: boolean; as?: StubAs } = {}) {
  const as = o.as ?? await new StubAs().listen();
  if (!o.as) open.push(as);
  const gw = await bootGateway({ as, ...(o.platform ? { platform: o.platform } : {}), enabled: o.enabled, dir: o.dir, fresh: o.fresh });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}, headers = h) => call(gw.port, 'POST', path, { headers, body });
  const get = (path: string, headers = h) => call(gw.port, 'GET', path, { headers });
  return { as, gw, session, h, post, get };
}
type World = Awaited<ReturnType<typeof world>>;

/** The same data folder after a restart: a new process (new Vault, new sessions), locked. */
async function restart(w: { gw: GatewayRig; as: StubAs }, platform?: PlatformHelper) {
  await w.gw.close();
  open.splice(open.findIndex(x => x === w.gw), 1);
  const gw = await bootGateway({ as: w.as, dir: w.gw.dir, fresh: false, ...(platform ? { platform } : {}) });
  open.push(gw);
  return gw;
}

const vaultFile = (dir: string): string => readFileSync(join(dir, 'vault.enc.json'), 'utf-8');
const platformAad = (accountId: string) => `suveren-vault-key-platform-wrap-v1|${accountId}`;

/** Everything a response or a log line must never carry: the vault key (any encoding) and the platform header's secrets. */
function secretsOf(w: World): string[] {
  const hex = w.gw.vault.getVaultKeyHex();
  const raw = Buffer.from(hex, 'hex');
  const out = [hex, raw.toString('base64'), raw.toString('base64url')];
  const p = w.gw.vault.readPlatformHeader();
  if (p) out.push(p.keyBlob, p.wrapped);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
soft('unlock by Touch ID: the second wrap of the vault key (SOFT helper)', () => {
  it('turns on after a password unlock, opens the vault after a restart with no password, and the password still works', async () => {
    const w = await world({ platform: softHost() });
    w.gw.vault.setCredential('gmail', { token: 'secret-token-1' });
    const keyHex = w.gw.vault.getVaultKeyHex();
    expect((await w.get('/auth/platform/status')).body).toMatchObject({ ok: true, unlockEnabled: false });
    const cap = await w.get('/auth/platform/capabilities');
    expect(cap.body).toMatchObject({ ok: true, available: true, secureHardware: true, unlockEnabled: false, checkKey: false });

    const en = await w.post('/auth/platform/enable', { password: PW });
    expect(en.status).toBe(200);
    expect(en.body).toMatchObject({ ok: true, policy: 'user-presence' });
    const file = JSON.parse(vaultFile(w.gw.dir));
    expect(file.password).toBeTruthy();                       // the password wrap is untouched
    expect(file.platform).toMatchObject({ v: 1, policy: 'user-presence', accountId: 'u1' });
    for (const secret of [keyHex, Buffer.from(keyHex, 'hex').toString('base64'), Buffer.from(keyHex, 'hex').toString('base64url')]) {
      expect(vaultFile(w.gw.dir)).not.toContain(secret);    // the vault key is in no file in the clear
    }

    // a restart: locked; Touch ID opens it
    const gw2 = await restart(w, softHost());
    expect(gw2.vault.isUnlocked()).toBe(false);
    expect((await call(gw2.port, 'GET', '/auth/platform/status')).body).toMatchObject({ unlockEnabled: true });
    const un = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(un.status).toBe(200);
    // the vault is open (the agents continue) AND the page has its session (PLATFORM_UNLOCK_OPENS_PAGE_SESSION, DEC-92)
    expect(un.body).toMatchObject({ ok: true, unlocked: true, sessionOpened: true });
    expect(un.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);
    expect(un.body.sessionToken).toBeTruthy();
    expect(gw2.vault.isUnlocked()).toBe(true);
    expect(gw2.vault.getVaultKeyHex()).toBe(keyHex);
    expect(gw2.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    expect(gw2.vault.unsealedByProvider()).toBe('platform');

    // and after another restart the password opens it as before
    await gw2.close();
    open.splice(open.indexOf(gw2), 1);
    const gw3 = await bootGateway({ as: w.as, dir: w.gw.dir, fresh: false });   // no helper in this process at all
    open.push(gw3);
    expect((await gw3.unlock()).token).toBeTruthy();
    expect(gw3.vault.getVaultKeyHex()).toBe(keyHex);
    expect(gw3.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('is on a page-session route: without the session, with a foreign Origin, or while locked it is refused and nothing is written', async () => {
    const w = await world({ platform: softHost() });
    const before = vaultFile(w.gw.dir);
    expect((await call(w.gw.port, 'POST', '/auth/platform/enable', { body: {} })).status).toBe(401);
    expect((await call(w.gw.port, 'POST', '/auth/platform/enable', { headers: w.h, body: {}, origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(w.gw.port, 'POST', '/auth/platform/enable', { headers: { cookie: w.h.cookie }, body: {} })).status).toBe(401);   // cookie without the header token
    expect((await call(w.gw.port, 'GET', '/auth/platform/capabilities')).status).toBe(401);
    expect((await call(w.gw.port, 'POST', '/auth/confirm/check', { body: { request_id: 'x' } })).status).toBe(401);
    expect(vaultFile(w.gw.dir)).toBe(before);
    // the vault itself refuses too, whatever the route: locked
    w.gw.vault.clearKey();
    await expect(w.gw.vault.enablePlatformUnlock(PW)).rejects.toMatchObject({ code: 'locked' });
    expect(vaultFile(w.gw.dir)).toBe(before);
  });

  it('turning it off removes the wrap and leaves the password and every credential; the unlock route then refuses', async () => {
    const w = await world({ platform: softHost() });
    w.gw.vault.setCredential('gmail', { token: 't' });
    await w.post('/auth/platform/enable', { password: PW });
    expect(w.gw.vault.hasPlatformUnlock()).toBe(true);
    expect((await w.post('/auth/platform/enable', { password: PW })).body).toMatchObject({ code: 'already_enabled' });
    const dis = await w.post('/auth/platform/disable', { password: PW });
    expect(dis.status).toBe(200);
    const file = JSON.parse(vaultFile(w.gw.dir));
    expect(file.platform).toBeUndefined();
    expect(file.password).toBeTruthy();
    expect((await w.post('/auth/platform/disable', { password: PW })).body).toMatchObject({ code: 'not_enabled' });
    const gw2 = await restart(w, softHost());
    expect((await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} })).body).toMatchObject({ code: 'not_enabled' });
    expect(gw2.vault.isUnlocked()).toBe(false);
    await gw2.unlock();
    expect(gw2.vault.getCredential('gmail')).toEqual({ token: 't' });
  });

  it('a wrap that opens to the wrong key is refused and the vault stays locked (stale wrap after a re-key, a wrap from another vault)', async () => {
    const w = await world({ platform: softHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const file = JSON.parse(vaultFile(w.gw.dir));
    // another vault key wrapped for the SAME wrap key (what a stale wrap would hold)
    const stale = wrapKey(Buffer.from(file.platform.publicKey, 'base64url'), randomBytes(32), platformAad('u1')).toString('base64url');
    file.platform.wrapped = stale;
    writeFileSync(join(w.gw.dir, 'vault.enc.json'), JSON.stringify(file));
    const gw2 = await restart(w, softHost());
    const r = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'wrap_mismatch' });
    expect(gw2.vault.isUnlocked()).toBe(false);
    expect((await gw2.unlock()).token).toBeTruthy();    // the password is untouched
  });

  it('a header moved to another account or with another key blob does not open the vault', async () => {
    const w = await world({ platform: softHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const original = JSON.parse(vaultFile(w.gw.dir));
    let cur = { gw: w.gw, as: w.as };
    for (const edit of [
      (f: any) => { f.platform.accountId = 'u2'; },
      (f: any) => { f.platform.keyBlob = newKey().blob; },
      (f: any) => { f.platform.wrapped = f.platform.wrapped.slice(0, -4) + 'AAAA'; },
      (f: any) => { f.platform.wrapped = 'AAAA'; },
      (f: any) => { f.platform.keyBlob = 'not base64!'; },
    ]) {
      const f = JSON.parse(JSON.stringify(original));
      edit(f);
      writeFileSync(join(cur.gw.dir, 'vault.enc.json'), JSON.stringify(f));
      const gw = await restart(cur, softHost());
      const r = await call(gw.port, 'POST', '/auth/unlock/platform', { body: {} });
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(409);
      expect(gw.vault.isUnlocked()).toBe(false);
      cur = { gw, as: w.as };
    }
  });

  it('a damaged vault file is never turned into an empty one by turning it on or off', async () => {
    const w = await world({ platform: softHost() });
    writeFileSync(join(w.gw.dir, 'vault.enc.json'), '{ not json');
    await expect(w.gw.vault.enablePlatformUnlock(PW)).rejects.toBeTruthy();
    expect(vaultFile(w.gw.dir)).toBe('{ not json');
    await expect(w.gw.vault.disablePlatformUnlock(PW)).rejects.toBeTruthy();
    expect(vaultFile(w.gw.dir)).toBe('{ not json');
  });
});

describe('unlock by Touch ID: a touch that does not happen (FAKE helper)', () => {
  it('cancelling the touch while turning it on writes nothing', async () => {
    const w = await world({ platform: fakeHost({ FAKE_TOUCH: 'cancel' }) });
    const before = vaultFile(w.gw.dir);
    const r = await w.post('/auth/platform/enable', { password: PW });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'cancelled' });
    expect(vaultFile(w.gw.dir)).toBe(before);          // byte for byte
    expect(w.gw.vault.hasPlatformUnlock()).toBe(false);
  });

  it('cancelling the unlock leaves the vault locked and the password working; spamming the prompt never locks the password out', async () => {
    const w = await world({ platform: fakeHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const gw2 = await restart(w, fakeHost({ FAKE_TOUCH: 'cancel' }));
    for (let i = 0; i < 5; i++) {
      const r = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
      expect(r.body).toMatchObject({ code: 'cancelled' });
    }
    const limited = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(limited.status).toBe(429);
    expect(gw2.vault.isUnlocked()).toBe(false);
    expect((await gw2.unlock()).token).toBeTruthy();   // the password has its own limiter
  });

  it('Touch ID locked, a key that no longer works: each leaves the password path open and says why', async () => {
    const w = await world({ platform: fakeHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const gw2 = await restart(w, fakeHost({ FAKE_TOUCH: 'locked' }));
    expect((await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} })).body).toMatchObject({ code: 'biometry_locked' });
    expect(gw2.vault.isUnlocked()).toBe(false);
    // no helper at all on this computer (copied to an Intel Mac, say)
    const gw3 = await restart({ gw: gw2, as: w.as }, noHelper('unsupported_arch'));
    const r = await call(gw3.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'helper_unavailable', reason: 'unsupported_arch' });
    expect((await gw3.unlock()).token).toBeTruthy();
  });
});

describe('unlock by Touch ID: races (FAKE helper, slow touch)', () => {
  const busyOf = (w: World) => (w.gw.vault as unknown as { platformBusy: boolean }).platformBusy;
  const until = async (f: () => boolean) => { const end = Date.now() + 5000; while (!f() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); expect(f()).toBe(true); };

  it('two turn-ons at once: one succeeds, the other is refused as busy; a turn-off during a turn-on is refused', async () => {
    const w = await world({ platform: fakeHost({ FAKE_TOUCH: 'slow' }) });
    const a = w.post('/auth/platform/enable', { password: PW });
    await until(() => busyOf(w));
    const b = await w.post('/auth/platform/enable', { password: PW });
    const c = await w.post('/auth/platform/disable', { password: PW });
    expect(b.body).toMatchObject({ code: 'busy' });
    expect(c.body).toMatchObject({ code: 'busy' });
    expect((await a).status).toBe(200);
    expect(w.gw.vault.hasPlatformUnlock()).toBe(true);
  });

  it('a lock during the touch: the answer is dropped and nothing is written', async () => {
    const w = await world({ platform: fakeHost({ FAKE_TOUCH: 'slow' }) });
    const before = vaultFile(w.gw.dir);
    const a = w.post('/auth/platform/enable', { password: PW });
    await until(() => busyOf(w));
    w.gw.vault.lockExpired();
    const r = await a;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'vault_changed' });
    expect(vaultFile(w.gw.dir)).toBe(before);
  });

  it('a lock and a new unlock during the touch (the vault key in memory is a new one): refused, nothing is written', async () => {
    const w = await world({ platform: fakeHost({ FAKE_TOUCH: 'slow' }) });
    const before = vaultFile(w.gw.dir);
    const a = w.post('/auth/platform/enable', { password: PW });
    await until(() => busyOf(w));
    w.gw.vault.clearKey();
    expect(await w.gw.vault.unlockWithPassword(PW)).toBe(true);
    const r = await a;
    expect(r.body).toMatchObject({ code: 'vault_changed' });
    expect(vaultFile(w.gw.dir)).toBe(before);
  });

  it('a wipe during the unlock touch drops the answer: the vault is not opened', async () => {
    const w = await world({ platform: fakeHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const gw2 = await restart(w, fakeHost({ FAKE_TOUCH: 'slow' }));
    const a = call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    await until(() => (gw2.vault as unknown as { platformBusy: boolean }).platformBusy);
    gw2.vault.wipe();                     // what the login's wipe-and-claim does
    const r = await a;
    expect(r.status).toBe(409);
    expect(gw2.vault.isUnlocked()).toBe(false);
  });
});

describe('a re-key wraps the new vault key for the helper without a touch (FAKE helper that never answers a touch)', () => {
  // A vault opened by the account key, which already holds a second wrap, is moved to a password: the only re-key.
  // (With a password set, the move cannot happen again, so in practice this is the state only a damaged or
  // hand-edited vault can be in. The code path is the one a later key rotation would use.)
  async function setup(svcHost: PlatformHelper | null) {
    const dir = tmpDir();
    const vault = new Vault(dir, { ...FAST, deviceKeys: true });
    await vault.deriveAndSetKey('hap_account_key');
    const oldKey = Buffer.from(vault.getVaultKeyHex(), 'hex');
    const maker = fakeHost();
    const svc = unlockKeyService(maker);
    const info = await svc.createWrapKey();
    const wrapped = await svc.wrap({ publicKey: info.publicKey, vaultKey: oldKey, aad: platformAad('u1') });
    const file = JSON.parse(vaultFile(dir));
    file.platform = { v: 1, backend: info.backend, policy: info.policy, keyBlob: info.keyBlob, publicKey: info.publicKey, wrapped, accountId: 'u1' };
    writeFileSync(join(dir, 'vault.enc.json'), JSON.stringify(file));
    vault.setPlatformService(svcHost ? unlockKeyService(svcHost) : null);
    return { dir, vault, oldKey, info, wrapped };
  }

  it('with the helper: the new wrap opens to the NEW key, and no touch was asked', async () => {
    const s = await setup(fakeHost({ FAKE_TOUCH: 'never' }));   // an unwrap would hang: none may happen
    const moved = await s.vault.setPassword('another long password', 'u1');
    expect(moved.outcome).toBe('done');
    const after = JSON.parse(vaultFile(s.dir));
    expect(after.platform.wrapped).not.toBe(s.wrapped);
    const newKey = Buffer.from(s.vault.getVaultKeyHex(), 'hex');
    expect(newKey.equals(s.oldKey)).toBe(false);
    expect(unwrapKey(s.info.keyBlob, Buffer.from(after.platform.wrapped, 'base64url'), platformAad('u1')).equals(newKey)).toBe(true);
    expect(after.password).toBeTruthy();
  });

  it('without a helper to wrap with: the stale wrap is dropped, never left to open the old key', async () => {
    const s = await setup(null);
    await s.vault.setPassword('another long password', 'u1');
    expect(JSON.parse(vaultFile(s.dir)).platform).toBeUndefined();
  });
});

describe('a vault that never turned it on is untouched by step 5a', () => {
  it('writes no platform header by any existing path, and refuses the platform unlock with a code', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, { ...FAST, deviceKeys: true });
    await vault.createWithPassword(PW, 'u1');
    const keys = () => Object.keys(JSON.parse(vaultFile(dir))).sort();
    const before = keys();
    expect(await vault.changePassword(PW, 'a different long password')).toBe(true);
    vault.clearKey();
    expect(await vault.unlockWithPassword('a different long password')).toBe(true);
    vault.setSecretSlot('x', { a: 1 });
    expect(keys().filter(k => k !== 'slots')).toEqual(before.filter(k => k !== 'slots'));
    expect(JSON.parse(vaultFile(dir)).platform).toBeUndefined();
    expect(vault.hasPlatformUnlock()).toBe(false);
    vault.clearKey();
    await expect(vault.unlockWithPlatform()).rejects.toMatchObject({ code: 'no_helper' });
    vault.setPlatformService(unlockKeyService(fakeHost()));
    await expect(vault.unlockWithPlatform()).rejects.toMatchObject({ code: 'not_enabled' });
    expect(vault.isUnlocked()).toBe(false);
  });

  it('two unlock touches at once: the second is refused as busy', async () => {
    const w = await world({ platform: fakeHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const gw2 = await restart(w, fakeHost({ FAKE_TOUCH: 'slow' }));
    const [a, b] = await Promise.all([
      call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} }),
      call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.code, b.body.code]).toContain('busy');
    expect(gw2.vault.isUnlocked()).toBe(true);
  });
});

describe('the helper itself: found, hashed, started', () => {
  it('a helper binary swapped on disk is not started, whether it is swapped before or just after the first look', async () => {
    const dir = tmpDir();
    const marker = join(dir, 'ran');
    const script = join(dir, 'helper.sh');
    const body = `#!/bin/sh\ntouch '${marker}'\n`;
    writeFileSync(script, body);
    chmodSync(script, 0o755);
    const good = sha256File(script);

    // 1. swapped before: never started
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n# swapped\n`);
    const h1 = host({ command: script, args: [], files: [{ path: script, sha256: good }] });
    expect(await h1.status()).toMatchObject({ available: false, reason: 'helper_modified' });
    expect(existsSync(marker)).toBe(false);
    // the files are named in the gateway's own list: a missing one is "not installed", not "fine"
    const h1b = host({ command: script, args: [], files: [{ path: join(dir, 'gone'), sha256: good }] });
    expect(await h1b.status()).toMatchObject({ available: false, reason: 'helper_not_installed' });

    // 2. swapped between the first look and the start: seen after the helper answered, and the helper is dropped
    writeFileSync(script, body);
    const spec: HelperSpec = { command: process.execPath, args: [FAKE], files: [{ path: script, sha256: good }] };
    const h2 = new PlatformHelper({
      locate: () => ({ spec }),
      startClient: async (s) => {
        writeFileSync(script, `${body}# swapped in the gap\n`);
        return UnlockHelperClient.start({ command: s.command, args: s.args });
      },
    });
    hosts.push(h2);
    expect(await h2.status()).toMatchObject({ available: false, reason: 'helper_modified' });
    await expect(h2.use(async () => 'never')).rejects.toMatchObject({ code: 'helper_modified' });
  });

  it('is found only on a Mac with Apple silicon, with the hashes of the gateway\'s own list; anything else says why', () => {
    const root = tmpDir();
    const here = join(root, 'dist', 'control-plane');
    const app = join(root, 'helper', 'Suveren.app');
    mkdirSync(here, { recursive: true });
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    const exe = join(app, 'Contents', 'MacOS', 'suveren-unlock-helper');
    writeFileSync(exe, 'binary');
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
    const manifest = { v: 1, files: {
      'Contents/MacOS/suveren-unlock-helper': createHash('sha256').update('binary').digest('hex'),
      'Contents/Info.plist': createHash('sha256').update('<plist/>').digest('hex'),
    } };
    const base = { here, scriptPath: join(here, 'index.mjs'), execPath: process.execPath, env: {} };
    writeFileSync(join(here, 'index.mjs'), '');
    expect(locateHelper({ ...base, platform: 'linux', arch: 'arm64' })).toEqual({ unavailable: 'unsupported_platform' });
    expect(locateHelper({ ...base, platform: 'win32', arch: 'ia32' })).toEqual({ unavailable: 'unsupported_arch' });
    expect(locateHelper({ ...base, platform: 'win32', arch: 'x64' })).toEqual({ unavailable: 'helper_not_installed' });   // no helper/windows-x64 here
    expect(locateHelper({ ...base, platform: 'darwin', arch: 'x64' })).toEqual({ unavailable: 'unsupported_arch' });
    expect(locateHelper({ ...base, platform: 'darwin', arch: 'arm64' })).toEqual({ unavailable: 'helper_not_installed' });   // no list yet
    writeFileSync(join(here, 'helper-manifest.json'), JSON.stringify(manifest));
    const ok = locateHelper({ ...base, platform: 'darwin', arch: 'arm64' });
    // (separator-neutral: this case pretends to be a Mac, and on a Windows host `join` writes \\)
    expect('spec' in ok && ok.spec.files.map(f => f.path.slice(app.length + 1).replaceAll('\\', '/')).sort()).toEqual(['Contents/Info.plist', 'Contents/MacOS/suveren-unlock-helper']);
    if ('spec' in ok) {
      expect(ok.spec.command).toBe(exe);
      expect(ok.spec.args).toEqual(['serve']);
      // who may call the helper: this program, and the folder its entry script is in (resolved)
      expect(JSON.parse(ok.spec.callers!.body)).toMatchObject({ v: 1, callers: [{ scriptPrefix: expect.stringContaining('control-plane') }] });
    }
    // a list that is damaged or has no executable is "modified", never "fine"
    writeFileSync(join(here, 'helper-manifest.json'), JSON.stringify({ v: 1, files: { 'Contents/Info.plist': manifest.files['Contents/Info.plist'] } }));
    expect(locateHelper({ ...base, platform: 'darwin', arch: 'arm64' })).toEqual({ unavailable: 'helper_modified' });
    writeFileSync(join(here, 'helper-manifest.json'), '{ nope');
    expect(locateHelper({ ...base, platform: 'darwin', arch: 'arm64' })).toEqual({ unavailable: 'helper_modified' });
  });

  it('on 64-bit Windows it is found in helper/windows-<arch>, with the hashes of the gateway\'s own list', () => {
    for (const arch of ['x64', 'arm64']) {
      const root = tmpDir();
      const here = join(root, 'dist', 'control-plane');
      const folder = join(root, 'helper', `windows-${arch}`);
      mkdirSync(here, { recursive: true });
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'suveren-unlock-helper.exe'), 'exe');
      writeFileSync(join(here, 'index.mjs'), '');
      const base = { here, scriptPath: join(here, 'index.mjs'), execPath: process.execPath, env: {}, platform: 'win32' as const, arch };
      expect(locateHelper(base)).toEqual({ unavailable: 'helper_not_installed' });   // no list yet
      // the Mac's list does not count for Windows, and a list without the .exe is "modified"
      writeFileSync(join(here, 'helper-manifest.json'), JSON.stringify({ v: 1, files: { 'suveren-unlock-helper.exe': createHash('sha256').update('exe').digest('hex') } }));
      expect(locateHelper(base)).toEqual({ unavailable: 'helper_not_installed' });
      const list = join(here, `helper-manifest-windows-${arch}.json`);
      writeFileSync(list, JSON.stringify({ v: 1, files: { 'Contents/MacOS/suveren-unlock-helper': createHash('sha256').update('exe').digest('hex') } }));
      expect(locateHelper(base)).toEqual({ unavailable: 'helper_modified' });
      writeFileSync(list, JSON.stringify({ v: 1, files: { 'suveren-unlock-helper.exe': createHash('sha256').update('exe').digest('hex') } }));
      const ok = locateHelper(base);
      expect('spec' in ok).toBe(true);
      if ('spec' in ok) {
        expect(ok.spec.command).toBe(join(folder, 'suveren-unlock-helper.exe'));
        expect(ok.spec.args).toEqual(['serve']);
        expect(ok.spec.files).toEqual([{ path: join(folder, 'suveren-unlock-helper.exe'), sha256: createHash('sha256').update('exe').digest('hex') }]);
        // the Windows helper reads its list of callers beside its own .exe
        expect(ok.spec.callers!.path).toBe(join(folder, 'allowed-callers.json'));
        expect(JSON.parse(ok.spec.callers!.body)).toMatchObject({ v: 1, callers: [{ scriptPrefix: expect.stringContaining('control-plane') }] });
      }
    }
  });

  it('a computer with no usable helper reports it, and everything else works with the password as before', async () => {
    const w = await world({ platform: noHelper('unsupported_arch') });
    const cap = await w.get('/auth/platform/capabilities');
    expect(cap.body).toMatchObject({ ok: true, available: false, reason: 'unsupported_arch', unlockEnabled: false, checkKey: false });
    const en = await w.post('/auth/platform/enable', { password: PW });
    expect(en.status).toBe(409);
    expect(en.body).toMatchObject({ code: 'helper_unavailable', reason: 'unsupported_arch' });
    expect(w.gw.vault.hasPlatformUnlock()).toBe(false);
    // set-up without a check key is the step-6 set-up, unchanged
    const start = await w.post('/auth/device/setup/start');
    expect(start.status).toBe(200);
    // a check key was asked for and cannot be made: refused, not silently skipped
    await w.post('/auth/device/setup/cancel');
    const asked = await w.post('/auth/device/setup/start', { checkKey: true });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'helper_unavailable' });
    // the password confirms a connector-login change, as before
    w.gw.vault.setCredential('gmail', { token: 'secret-token-1' });
    const req = await w.post('/auth/confirm/request', { kind: 'remove', name: 'gmail', change: { route: 'credentials', op: 'delete' } });
    const id = (req.body.request as { request_id: string }).request_id;
    expect((await w.post('/auth/confirm', { request_id: id, password: PW })).status).toBe(200);
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: { ...w.h, [CONFIRMATION_HEADER]: id } })).status).toBe(200);
  });

  it('with the switch off none of it exists', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, enabled: false, platform: softHost() });
    open.push(gw);
    for (const [m, p] of [['GET', '/auth/platform/status'], ['GET', '/auth/platform/capabilities'], ['POST', '/auth/unlock/platform'], ['POST', '/auth/platform/enable'], ['POST', '/auth/platform/disable'], ['POST', '/auth/confirm/check']] as const) {
      expect((await call(gw.port, m, p, { body: m === 'POST' ? {} : undefined })).status, `${m} ${p}`).toBe(404);
    }
    expect(gw.vault.hasPlatformUnlock()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/** A stored chain record, so a check key in the slot is not an orphan (lib/platform-checks.ts). */
function storeChain(w: World): void {
  new DeviceChainStore(w.gw.vault).create({
    v: 1, rootDid: 'did:key:z6MkTest', keyId: 'A'.repeat(43), head: { seq: 0, hash: `sha256:${'0'.repeat(64)}` },
    asUrl: w.as.url, label: 'This computer', setUpAt: 1,
  });
}
async function withCheckKey(platform: PlatformHelper, dir?: string) {
  const w = await world({ platform, dir });
  storeChain(w);
  const key = await new PlatformChecks(platform).createKey();
  w.gw.checkStore.write(key);
  w.gw.vault.setCredential('gmail', { token: 'secret-token-1' });
  return { w, key };
}
const DEL = { route: 'credentials', op: 'delete' };
const PUT = (fields: Record<string, string>) => ({ route: 'credentials', op: 'put-merge', fields });
const withConf = (h: Record<string, string>, id: string) => ({ ...h, [CONFIRMATION_HEADER]: id });
async function request(w: World, kind: string, change: unknown, headers = w.h) {
  const r = await w.post('/auth/confirm/request', { kind, name: 'gmail', change }, headers);
  return (r.body.request as { request_id: string }).request_id;
}

soft('a connector-login change on a computer with a check key (SOFT helper: the real change request, the real signature)', () => {
  it('needs the check key\'s signature over the change request; the password is no longer accepted; once, for that change only', async () => {
    const { w } = await withCheckKey(softHost());
    const untouched = () => expect(w.gw.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    // the password path
    const pwId = await request(w, 'remove', DEL);
    const viaPassword = await w.post('/auth/confirm', { request_id: pwId, password: PW });
    expect(viaPassword.status).toBe(409);
    expect(viaPassword.body).toMatchObject({ code: 'check_key_required' });
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, pwId) })).status).toBe(403);
    untouched();

    // the check key's path: the real Swift helper accepts exactly the object the gateway builds, and signs it
    const unconfirmed = await request(w, 'remove', DEL);
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, unconfirmed) })).status).toBe(403);   // never confirmed
    const id = await request(w, 'remove', DEL);
    const conf = await w.post('/auth/confirm/check', { request_id: id });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body).toMatchObject({ ok: true, confirmation: id });
    // for another change, another kind or another login: refused (and the request is spent by that try)
    expect((await call(w.gw.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(w.h, id), body: { token: 'x' } })).status).toBe(403);
    untouched();
    const id2 = await request(w, 'remove', DEL);
    await w.post('/auth/confirm/check', { request_id: id2 });
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, id2) })).status).toBe(200);
    expect(w.gw.vault.getCredential('gmail')).toBeNull();
    w.gw.vault.setCredential('gmail', { token: 'again' });
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, id2) })).status).toBe(403);   // spent
  });

  it('a replace is confirmed by the same path, for exactly the fields that were asked', async () => {
    const { w } = await withCheckKey(softHost());
    const id = await request(w, 'replace', PUT({ token: 'new' }));
    expect((await w.post('/auth/confirm/check', { request_id: id })).status).toBe(200);
    expect((await call(w.gw.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(w.h, id), body: { token: 'other' } })).status).toBe(403);
    const id2 = await request(w, 'replace', PUT({ token: 'new' }));
    await w.post('/auth/confirm/check', { request_id: id2 });
    expect((await call(w.gw.port, 'PUT', '/vault/credentials/gmail', { headers: withConf(w.h, id2), body: { token: 'new' } })).status).toBe(200);
  });

  it('a password confirmation given BEFORE the check key existed carries no change out afterwards', async () => {
    const w = await world({ platform: softHost() });
    w.gw.vault.setCredential('gmail', { token: 'secret-token-1' });
    storeChain(w);
    const id = await request(w, 'remove', DEL);
    expect((await w.post('/auth/confirm', { request_id: id, password: PW })).status).toBe(200);   // no check key yet
    w.gw.checkStore.write(await new PlatformChecks(softHost()).createKey());
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, id) })).status).toBe(403);
    expect(w.gw.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('a request of another page session, an unknown one, and a malformed one are refused without a prompt', async () => {
    const { w } = await withCheckKey(softHost());
    const other = sessionHeaders(await w.gw.unlock());
    const id = await request(w, 'remove', DEL);
    expect((await w.post('/auth/confirm/check', { request_id: id }, other)).status).toBe(404);
    expect((await w.post('/auth/confirm/check', { request_id: 'AAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(404);
    for (const bad of [undefined, '', 5, 'x'.repeat(65), { a: 1 }]) {
      expect((await w.post('/auth/confirm/check', { request_id: bad })).status).toBe(400);
    }
    // the right session still can
    expect((await w.post('/auth/confirm/check', { request_id: id })).status).toBe(200);
  });

  sit('the helper shows the text of the object: what the prompt would say for each kind', async () => {
    const host1 = softHost();
    const checks = new PlatformChecks(host1);
    const key = await checks.createKey();
    const req = (kind: string) => new TextEncoder().encode(canonicalJson({ request_id: 'r', kind, name: 'gmail', change_hash: 'h', gateway_key_id: null, expires_at: 1 }));
    expect((await checks.sign(key, req('replace'))).reason).toBe('replace the login of "gmail"');
    expect((await checks.sign(key, req('remove'))).reason).toBe('remove the login of "gmail"');
  });
});

describe('a connector-login change: a touch that does not happen or lies (FAKE helper)', () => {
  it('cancelling leaves the request open to try again; nothing changes', async () => {
    const { w } = await withCheckKey(fakeHost({ FAKE_TOUCH: 'cancel' }));
    const id = await request(w, 'remove', DEL);
    const r = await w.post('/auth/confirm/check', { request_id: id });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'cancelled' });
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, id) })).status).toBe(403);
    expect(w.gw.vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
    // the password is still not a way around it
    expect((await w.post('/auth/confirm', { request_id: id, password: PW })).status).toBe(409);
  });

  it('a helper that signs something else, or with another key, is not a confirmation', async () => {
    const { w } = await withCheckKey(fakeHost({ FAKE_WRONG_SIGNATURE: '1' }));
    const id = await request(w, 'remove', DEL);
    const r = await w.post('/auth/confirm/check', { request_id: id });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'check_invalid' });
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, id) })).status).toBe(403);
    // another key's slot: the key blob in the store is not the one the signature is checked against
    const { w: w2 } = await withCheckKey(fakeHost());
    const stored = w2.gw.checkStore.read()!;
    w2.gw.checkStore.write({ ...stored, publicKey: Buffer.from(newKey().pub).toString('base64url') });
    const id2 = await request(w2, 'remove', DEL);
    expect((await w2.post('/auth/confirm/check', { request_id: id2 })).status).toBe(502);
  });

  it('only one prompt at a time: a second request while one is on screen is refused, not queued', async () => {
    const { w } = await withCheckKey(fakeHost({ FAKE_TOUCH: 'slow' }));
    const a = await request(w, 'remove', DEL);
    const b = await request(w, 'remove', DEL);
    const first = w.post('/auth/confirm/check', { request_id: a });
    await new Promise(r => setTimeout(r, 120));
    const second = await w.post('/auth/confirm/check', { request_id: b });
    expect(second.body).toMatchObject({ code: 'busy' });
    expect((await first).status).toBe(200);
  });

  it('an unreadable check-key slot counts as "has a check key": the password is not a confirmation then (fails closed)', async () => {
    const { w } = await withCheckKey(fakeHost());
    w.gw.vault.setSecretSlot('deviceCheckKey', { garbage: true });
    expect(w.gw.checkStore.has()).toBe(true);
    const id = await request(w, 'remove', DEL);
    expect((await w.post('/auth/confirm', { request_id: id, password: PW })).status).toBe(409);
    expect((await w.post('/auth/confirm/check', { request_id: id })).status).toBe(500);
  });
});

describe('ChangeConfirmations with a check key (unit)', () => {
  it('a request that expired is not open to the check, and a password confirmation never passes where a check key is required', () => {
    let now = 1_000;
    let required = false;
    const c = new ChangeConfirmations({ now: () => now, checkRequired: () => required });
    const req = c.request('s1', 'remove', 'gmail', DEL);
    expect(c.openRequest('s1', req.request_id)).toEqual(req);
    expect(c.openRequest('s2', req.request_id)).toBeNull();
    now += 300_001;
    expect(c.openRequest('s1', req.request_id)).toBeNull();
    expect(c.confirm('s1', req.request_id, 'check')).toBe(false);

    now = 1_000;
    const a = c.request('s1', 'remove', 'gmail', DEL);
    c.confirm('s1', a.request_id, 'password');
    required = true;
    expect(c.consume('s1', a.request_id, 'remove', 'gmail', DEL)).toBe(false);
    required = true;
    const b = c.request('s1', 'remove', 'gmail', DEL);
    c.confirm('s1', b.request_id, 'check');
    expect(c.consume('s1', b.request_id, 'remove', 'gmail', DEL)).toBe(true);
    required = false;
    const d = c.request('s1', 'remove', 'gmail', DEL);
    c.confirm('s1', d.request_id, 'password');
    expect(c.consume('s1', d.request_id, 'remove', 'gmail', DEL)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
soft('this computer\'s check key in the first chain entry (SOFT helper; the Authority Server stub verifies with hap-core)', () => {
  it('set-up with a check key: the genesis carries device.check and the device\'s check over its own hash, and the real verifier accepts the chain', async () => {
    const w = await world({ platform: softHost() });
    const start = await w.post('/auth/device/setup/start', { checkKey: true });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    // not a granting device yet: nothing is in the check slot before the chain is stored
    expect(w.gw.checkStore.has()).toBe(false);
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    const entries = w.as.chainEntries() as ChainEntry[];
    expect(entries[0].device!.check).toMatchObject({ type: 'platform' });
    expect(entries[0].checks).toHaveLength(1);
    expect(entries[0].checks[0].by).toBe(start.body.deviceKeyId);
    expect(entries[0].sigs.map(s => s.by).sort()).toEqual(['root', start.body.deviceKeyId].sort());
    const state = await verifyChain({ expectedRootDid: String(start.body.rootDid), entries });
    expect(state.devices[String(start.body.deviceKeyId)].check).toEqual(entries[0].device!.check);
    expect(fin.body.head).toEqual({ seq: 0, hash: await entryHash(entries[0]) });
    // now this computer has a check key: the key's public half is the chain's, the blob is sealed, the password is no confirmation
    const stored = w.gw.checkStore.read()!;
    expect((entries[0].device!.check as { pub: string }).pub).toBe(stored.publicKey);
    expect(w.gw.checkStore.has()).toBe(true);
    expect(vaultFile(w.gw.dir)).not.toContain(stored.keyBlob);        // sealed in a slot, not in the clear
    expect(new DeviceChainStore(w.gw.vault).read()).toMatchObject({ head: { seq: 0 } });
    const cap = await w.get('/auth/platform/capabilities');
    expect(cap.body).toMatchObject({ checkKey: true });
    expect(JSON.stringify(cap.body)).not.toContain(stored.keyBlob);
  });

  it('a set-up without the request is the step-6 set-up: no check key anywhere, and the password still confirms', async () => {
    const w = await world({ platform: softHost() });
    const start = await w.post('/auth/device/setup/start', {});
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(200);
    const entries = w.as.chainEntries() as ChainEntry[];
    expect(entries[0].device!.check).toBeNull();
    expect(entries[0].checks).toEqual([]);
    expect(w.gw.checkStore.has()).toBe(false);
  });

  it('a lock or restart between start and finish keeps the check key with the started set-up', async () => {
    const w = await world({ platform: softHost() });
    const start = await w.post('/auth/device/setup/start', { checkKey: true });
    const gw2 = await restart(w, softHost());
    const s2 = sessionHeaders(await gw2.unlock());
    const fin = await call(gw2.port, 'POST', '/auth/device/setup/finish', { headers: s2, body: { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() } });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(gw2.checkStore.has()).toBe(true);
    const entries = w.as.chainEntries() as ChainEntry[];
    expect((entries[0].device!.check as { pub: string }).pub).toBe(gw2.checkStore.read()!.publicKey);
  });

});

describe('this computer\'s check key at set-up: a touch that does not happen or lies (FAKE helper)', () => {
  it('cancelling the touch ends the set-up before anything is kept or sent', async () => {
    const w = await world({ platform: fakeHost({ FAKE_TOUCH: 'cancel' }) });
    const r = await w.post('/auth/device/setup/start', { checkKey: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'cancelled' });
    expect(r.text).not.toContain('recoveryCode');
    expect((await w.get('/auth/device/status')).body).toMatchObject({ setUp: false, setupPending: false });
    expect(w.as.chainEntries()).toHaveLength(0);
    expect(w.gw.checkStore.has()).toBe(false);
    // and the person can start again
    expect((await w.post('/auth/device/setup/start', {})).status).toBe(200);
  });

  it('a helper that signs another object than the entry is refused: no recovery code is handed out', async () => {
    const w = await world({ platform: fakeHost({ FAKE_WRONG_SIGNATURE: '1' }) });
    const r = await w.post('/auth/device/setup/start', { checkKey: true });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'check_invalid' });
    expect(r.text).not.toContain('recoveryCode');
    expect((await w.get('/auth/device/status')).body).toMatchObject({ setupPending: false });
  });

  it('a malformed request for a check key is refused', async () => {
    const w = await world({ platform: fakeHost() });
    for (const bad of ['yes', 1, {}, []]) expect((await w.post('/auth/device/setup/start', { checkKey: bad })).status).toBe(400);
  });
});

soft('no secret leaves: responses and logs carry no vault key, wrap or key blob (SOFT helper)', () => {
  it('through turn-on, unlock, a confirmation, a refusal and a turn-off', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
    const { w, key } = await withCheckKey(softHost());
    const replies: Reply[] = [];
    replies.push(await w.get('/auth/platform/capabilities'));
    replies.push(await w.post('/auth/platform/enable', { password: PW }));
    replies.push(await w.post('/auth/platform/enable', { password: PW }));
    const id = await request(w, 'remove', DEL);
    replies.push(await w.post('/auth/confirm', { request_id: id, password: PW }));
    replies.push(await w.post('/auth/confirm/check', { request_id: id }));
    replies.push(await w.get('/auth/platform/status'));
    const secrets = [...secretsOf(w), key.keyBlob];
    const gw2 = await restart(w, softHost());
    replies.push(await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} }));
    replies.push(await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} }));
    replies.push(await w.post('/auth/platform/disable', { password: PW }).catch(() => ({ text: '' }) as Reply));
    const all = [...replies.map(r => r.text + JSON.stringify(r.headers)), ...logs].join('\n');
    for (const s of secrets) expect(all, 'a secret leaked').not.toContain(s);
    expect(secrets.length).toBeGreaterThanOrEqual(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Review round: items 2 to 7 and 9 of the coordinator's list.

describe('item 2 / DEC-92: Touch ID opens the vault and the page (constant PLATFORM_UNLOCK_OPENS_PAGE_SESSION)', () => {
  it('the constant is true (DEC-92)', () => {
    expect(PLATFORM_UNLOCK_OPENS_PAGE_SESSION).toBe(true);
  });

  it('with the constant false (tests only): a touch opens the vault and every page route still needs the password; an unlocked vault refuses a second touch (item 7)', async () => {
    const w = await world({ platform: fakeHost() });
    w.gw.vault.setCredential('gmail', { token: 't' });
    await w.post('/auth/platform/enable', { password: PW });
    await w.gw.close();
    open.splice(open.indexOf(w.gw), 1);
    const gw2 = await bootGateway({ as: w.as, dir: w.gw.dir, fresh: false, platform: fakeHost(), opensPageSession: false });
    open.push(gw2);
    const un = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(un.body).toMatchObject({ ok: true, unlocked: true, sessionOpened: false });
    expect(gw2.vault.isUnlocked()).toBe(true);
    expect(gw2.vault.getCredential('gmail')).toEqual({ token: 't' });
    // no cookie, no token: the page's routes refuse
    expect((await call(gw2.port, 'GET', '/api/x')).status).toBe(401);
    expect((await call(gw2.port, 'GET', '/auth/platform/capabilities')).status).toBe(401);
    // a second touch on the unlocked vault is not a way to a session
    const again = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'already_unlocked' });
    expect(again.headers['set-cookie']).toBeUndefined();
    // the password opens the session
    const session = await gw2.unlock();
    expect((await call(gw2.port, 'GET', '/api/x', { headers: sessionHeaders(session) })).status).toBe(200);
  });

  it('by default (the constant true): the touch opens a session, and on an unlocked vault a touch verifies the key and opens one', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, platform: fakeHost() });
    open.push(gw);
    const s = sessionHeaders(await gw.unlock());
    await call(gw.port, 'POST', '/auth/platform/enable', { headers: s, body: { password: PW } });
    const gw2 = await restart({ gw, as }, fakeHost());
    // (the rig was booted with the default for the restart: set it on the new one through a fresh boot)
    await gw2.close();
    open.splice(open.indexOf(gw2), 1);
    const gw3 = await bootGateway({ as, dir: gw.dir, fresh: false, platform: fakeHost() });
    open.push(gw3);
    const un = await call(gw3.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(un.body).toMatchObject({ ok: true, unlocked: true, sessionOpened: true });
    expect(un.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);
    expect(un.body.sessionToken).toBeTruthy();
    const again = await call(gw3.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ sessionOpened: true });
    // a touch that opens another key does not
    const file = JSON.parse(vaultFile(gw3.dir));
    file.platform.wrapped = wrapKey(Buffer.from(file.platform.publicKey, 'base64url'), randomBytes(32), platformAad('u1')).toString('base64url');
    writeFileSync(join(gw3.dir, 'vault.enc.json'), JSON.stringify(file));
    const bad = await call(gw3.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(bad.status).toBe(409);
    expect(bad.headers['set-cookie']).toBeUndefined();
  });
});

describe('DEC-92: a session opened by a touch has the limits of a password session', () => {
  it('it is a page session like any other: the page routes accept it, and ending all sessions (lock, sleep, user switch, restart) ends it', async () => {
    const w = await world({ platform: fakeHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const gw2 = await restart(w, fakeHost());
    const un = await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(un.body).toMatchObject({ sessionOpened: true });
    const s = sessionHeaders(sessionOf(un));
    expect((await call(gw2.port, 'GET', '/api/x', { headers: s })).status).toBe(200);
    gw2.sessions.endAll();
    const after = await call(gw2.port, 'GET', '/api/x', { headers: s });
    expect(after.status).toBe(401);
  });

  it('the password stays the fallback: with Touch ID on, the unlock password still opens a session after a restart', async () => {
    const w = await world({ platform: fakeHost() });
    await w.post('/auth/platform/enable', { password: PW });
    const gw2 = await restart(w, fakeHost());
    const session = await gw2.unlock();
    expect((await call(gw2.port, 'GET', '/api/x', { headers: sessionHeaders(session) })).status).toBe(200);
  });
});

describe('item 3: turning Touch ID unlock on or off asks for the unlock password and a fresh check with its own prompt text', () => {
  sit('without a check key: the password, and nothing is written for a wrong or missing one', async () => {
    const w = await world({ platform: softHost() });
    const before = vaultFile(w.gw.dir);
    expect((await w.post('/auth/platform/enable', { password: 'not the password' })).status).toBe(401);
    expect((await w.post('/auth/platform/enable', {})).status).toBe(400);
    expect((await w.post('/auth/platform/enable', { password: '' })).status).toBe(400);
    expect(vaultFile(w.gw.dir)).toBe(before);
    expect((await w.post('/auth/platform/enable', { password: PW })).status).toBe(200);
    const on = vaultFile(w.gw.dir);
    expect((await w.post('/auth/platform/disable', { password: 'not the password' })).status).toBe(401);
    expect(vaultFile(w.gw.dir)).toBe(on);
    expect(w.gw.vault.hasPlatformUnlock()).toBe(true);
  });

  sit('with a check key: the check comes first, and its prompt text says "turn on" and "turn off Touch ID unlock for Suveren" (SOFT helper shows the text it built)', async () => {
    const { w } = await withCheckKey(softHost());
    const shown: string[] = [];
    const real = PlatformChecks.prototype.sign;
    vi.spyOn(PlatformChecks.prototype, 'sign').mockImplementation(async function (this: PlatformChecks, ...a: Parameters<PlatformChecks['sign']>) {
      const r = await real.apply(this, a);
      shown.push(r.reason);
      return r;
    });
    expect((await w.post('/auth/platform/enable', { password: PW })).status).toBe(200);
    expect((await w.post('/auth/platform/disable', { password: PW })).status).toBe(200);
    expect(shown).toEqual(['turn on Touch ID unlock for Suveren', 'turn off Touch ID unlock for Suveren']);
  });

  it('a cancelled check turns nothing on and nothing off; the password alone is not enough where a check key exists', async () => {
    const { w } = await withCheckKey(fakeHost({ FAKE_TOUCH: 'cancel' }));
    const before = vaultFile(w.gw.dir);
    const r = await w.post('/auth/platform/enable', { password: PW });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'cancelled' });
    expect(vaultFile(w.gw.dir)).toBe(before);
    // turned on earlier (with a working key), then a cancelled check on the way off: still on, key unchanged
    const w2 = (await withCheckKey(fakeHost())).w;
    await w2.post('/auth/platform/enable', { password: PW });
    const keyBefore = w2.gw.vault.getVaultKeyHex();
    // swap to a host whose touch is cancelled: the vault object keeps its service, so make the check fail by lying about the key
    const stored = w2.gw.checkStore.read()!;
    w2.gw.checkStore.write({ ...stored, publicKey: Buffer.from(newKey().pub).toString('base64url') });
    const d = await w2.post('/auth/platform/disable', { password: PW });
    expect(d.status).toBe(502);
    expect(w2.gw.vault.hasPlatformUnlock()).toBe(true);
    expect(w2.gw.vault.getVaultKeyHex()).toBe(keyBefore);
  });

  it('an unreadable check-key slot refuses turning it on (never skips the check)', async () => {
    const { w } = await withCheckKey(fakeHost());
    w.gw.vault.setSecretSlot('deviceCheckKey', { garbage: true });
    const r = await w.post('/auth/platform/enable', { password: PW });
    expect(r.status).toBeGreaterThanOrEqual(409);
    expect(w.gw.vault.hasPlatformUnlock()).toBe(false);
  });
});

describe('item 4: turning it off re-keys the vault key (and says what that does and does not do)', () => {
  const mcpClient = () => {
    const calls: Array<{ op: string; oldKeyHex?: string; newKeyHex?: string }> = [];
    let sealed: 'old' | 'new' = 'old';
    let failRekey = false;
    return {
      calls,
      fail: (v: boolean) => { failRekey = v; },
      client: {
        async state(oldKeyHex: string, newKeyHex: string) { calls.push({ op: 'state', oldKeyHex, newKeyHex }); return { sealedWith: sealed }; },
        async rekey(oldKeyHex: string, newKeyHex: string) { calls.push({ op: 'rekey', oldKeyHex, newKeyHex }); if (failRekey) throw new Error('mcp away'); sealed = 'new'; },
      },
    };
  };
  const decryptsWith = (keyHex: string, blob: { iv: string; ciphertext: string; tag: string }): boolean => {
    try {
      const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(blob.iv, 'hex'));
      d.setAuthTag(Buffer.from(blob.tag, 'hex'));
      Buffer.concat([d.update(Buffer.from(blob.ciphertext, 'hex')), d.final()]);
      return true;
    } catch { return false; }
  };

  sit('a new vault key seals the stores, the MCP server is moved through its re-key, and a credential entered later never opens with the old key', async () => {
    const mcp = mcpClient();
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, platform: softHost(), mcp: mcp.client });
    open.push(gw);
    const w = { as, gw } as World;
    const h = sessionHeaders(await gw.unlock());
    gw.vault.setCredential('gmail', { token: 'before' });
    await call(gw.port, 'POST', '/auth/platform/enable', { headers: h, body: { password: PW } });
    const oldHex = gw.vault.getVaultKeyHex();
    const oldCopy = vaultFile(gw.dir);                                  // a copy of the file taken while it was on
    const r = await call(gw.port, 'POST', '/auth/platform/disable', { headers: h, body: { password: PW } });
    expect(r.status).toBe(200);
    const newHex = gw.vault.getVaultKeyHex();
    expect(newHex).not.toBe(oldHex);
    expect(mcp.calls.find(c => c.op === 'rekey')).toMatchObject({ oldKeyHex: oldHex, newKeyHex: newHex });
    // the file: no platform header, no pending marker left, the credential readable with the NEW key only
    const file = JSON.parse(vaultFile(gw.dir));
    expect(file.platform).toBeUndefined();
    expect(file.password.pending).toBeUndefined();
    expect(gw.vault.getCredential('gmail')).toEqual({ token: 'before' });
    expect(decryptsWith(oldHex, file.credentials.gmail)).toBe(false);
    expect(decryptsWith(newHex, file.credentials.gmail)).toBe(true);
    gw.vault.setCredential('late', { token: 'after' });
    expect(decryptsWith(oldHex, JSON.parse(vaultFile(gw.dir)).credentials.late)).toBe(false);
    // the password opens it after a restart; the touch is gone
    const gw2 = await restart(w, softHost());
    expect((await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} })).body).toMatchObject({ code: 'not_enabled' });
    await gw2.unlock();
    expect(gw2.vault.getVaultKeyHex()).toBe(newHex);
    // What it does NOT do: the old copy still holds its own key blob and opens what was in it, with a touch.
    const dir3 = tmpDir();
    writeFileSync(join(dir3, 'vault.enc.json'), oldCopy);
    const v3 = new Vault(dir3, { ...FAST, deviceKeys: true });
    v3.setPlatformService(unlockKeyService(softHost()));
    await v3.unlockWithPlatform();
    expect(v3.getVaultKeyHex()).toBe(oldHex);
    expect(v3.getCredential('gmail')).toEqual({ token: 'before' });
    expect(v3.getCredential('late')).toBeNull();
  });

  sit('an MCP server that cannot be moved leaves the marker, answers 202, and the next password unlock finishes it', async () => {
    const mcp = mcpClient();
    mcp.fail(true);
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, platform: softHost(), mcp: mcp.client });
    open.push(gw);
    const h = sessionHeaders(await gw.unlock());
    await call(gw.port, 'POST', '/auth/platform/enable', { headers: h, body: { password: PW } });
    const r = await call(gw.port, 'POST', '/auth/platform/disable', { headers: h, body: { password: PW } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ rekeyPending: true });
    expect(gw.vault.hasPendingRekey()).toBe(true);
    expect(JSON.parse(vaultFile(gw.dir)).password.pending).toBeTruthy();
    expect(JSON.parse(vaultFile(gw.dir)).platform).toBeUndefined();
    mcp.fail(false);
    expect((await gw.vault.reconcileRekey(mcp.client)).outcome).toBe('done');
    expect(gw.vault.hasPendingRekey()).toBe(false);
  });

  sit('a lock during the password hash leaves the vault locked and recoverable by the password (the file says "new key, old pending")', async () => {
    const w = await world({ platform: softHost() });
    w.gw.vault.setCredential('gmail', { token: 'x' });
    await w.post('/auth/platform/enable', { password: PW });
    const p = w.post('/auth/platform/disable', { password: PW });
    await new Promise(r => setTimeout(r, 1));
    w.gw.vault.clearKey();
    const r = await p;
    // either it finished before the lock or it was refused as changed: never a half state that the password cannot open
    expect([200, 202, 401, 409]).toContain(r.status);
    const gw2 = await restart(w);
    const s = await gw2.unlock();
    expect(s.token).toBeTruthy();
    expect(gw2.vault.getCredential('gmail')).toEqual({ token: 'x' });
  });
});

describe('item 5: the change request names the login, inside the signed object and in change_hash', () => {
  sit('the request has `name` (six members), the helper\'s prompt text names it, and a confirmation for another name is refused', async () => {
    const { w } = await withCheckKey(softHost());
    const shown: string[] = [];
    const real = PlatformChecks.prototype.sign;
    vi.spyOn(PlatformChecks.prototype, 'sign').mockImplementation(async function (this: PlatformChecks, ...a: Parameters<PlatformChecks['sign']>) {
      const r = await real.apply(this, a);
      shown.push(r.reason);
      return r;
    });
    const rq = await w.post('/auth/confirm/request', { kind: 'replace', name: 'gmail', change: PUT({ token: 'n' }) });
    const request = rq.body.request as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['change_hash', 'expires_at', 'gateway_key_id', 'kind', 'name', 'request_id']);
    expect(request.name).toBe('gmail');
    expect((await w.post('/auth/confirm/check', { request_id: request.request_id })).status).toBe(200);
    expect(shown).toEqual(['replace the login of "gmail"']);
    // change_hash binds the name: the same change for another login does not fit this confirmation
    w.gw.vault.setCredential('crm', { token: 'c' });
    expect((await call(w.gw.port, 'PUT', '/vault/credentials/crm', { headers: withConf(w.h, String(request.request_id)), body: { token: 'n' } })).status).toBe(403);
    expect(w.gw.vault.getCredential('crm')).toEqual({ token: 'c' });
  });
});

describe('item 6: the way out of a fingerprint change, and an orphaned check key', () => {
  async function setUpWithCheckKey() {
    const w = await world({ platform: fakeHost() });
    const start = await w.post('/auth/device/setup/start', { checkKey: true });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    w.gw.vault.setCredential('gmail', { token: 'secret-token-1' });
    return { w, code: String(start.body.recoveryCode), rootDid: String(start.body.rootDid) };
  }
  /** What a fingerprint change does: the helper can no longer load the key (here: a blob it cannot read). */
  const invalidate = (w: World) => w.gw.checkStore.write({ ...w.gw.checkStore.read()!, keyBlob: 'AAAA' });

  it('password + recovery code clear a check key the helper reported invalid; the password then confirms again; it is logged, with no secret', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const { w, code, rootDid } = await setUpWithCheckKey();
    const reset = (body: object) => w.post('/auth/platform/check-key/reset', body);
    // a working key is never dropped this way
    expect((await reset({ password: PW, recoveryCode: code })).body).toMatchObject({ code: 'key_not_reported_invalid' });
    invalidate(w);
    const id = await request(w, 'remove', DEL);
    const used = await w.post('/auth/confirm/check', { request_id: id });
    expect(used.status).toBe(409);
    expect(used.body).toMatchObject({ code: 'key_invalid' });
    // the password is still no confirmation, and nothing opens the change
    expect((await w.post('/auth/confirm', { request_id: id, password: PW })).status).toBe(409);
    // wrong password, wrong recovery code, another account's code: refused, nothing cleared
    expect((await reset({ password: 'nope nope nope', recoveryCode: code })).status).toBe(401);
    const other = await (await import('@hap/core/device-keys')).generateRecoveryCode();
    expect((await reset({ password: PW, recoveryCode: other.code })).body).toMatchObject({ code: 'wrong_recovery_code' });
    expect(w.gw.checkStore.has()).toBe(true);
    // the right ones
    const ok = await reset({ password: PW, recoveryCode: code });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ cleared: true, chainStillNamesCheckKey: true, replacement: 'needs_email_link' });
    expect(w.gw.checkStore.has()).toBe(false);
    expect(logs.join('\n')).toContain('check key of this computer was cleared');
    expect(logs.join('\n')).not.toContain(code);
    expect(ok.text).not.toContain(code);
    expect(ok.text).not.toContain(rootDid);
    // the password path works again for a connector-login change
    const id2 = await request(w, 'remove', DEL);
    expect((await w.post('/auth/confirm', { request_id: id2, password: PW })).status).toBe(200);
    expect((await call(w.gw.port, 'DELETE', '/vault/credentials/gmail', { headers: withConf(w.h, id2) })).status).toBe(200);
    // and a second reset has nothing to clear
    expect((await reset({ password: PW, recoveryCode: code })).body).toMatchObject({ code: 'no_check_key' });
  });

  it('a check-key slot with no chain behind it is an orphan: it locks nobody out, and a cancelled set-up clears it', async () => {
    const w = await world({ platform: fakeHost() });
    const key = await new PlatformChecks(fakeHost()).createKey();
    w.gw.checkStore.write(key);                         // what a crash between the two writes of `complete` leaves
    expect(w.gw.vault.hasSecretSlot('deviceCheckKey')).toBe(true);
    expect(w.gw.checkStore.has()).toBe(false);
    expect(w.gw.checkStore.read()).toBeNull();
    w.gw.vault.setCredential('gmail', { token: 't' });
    const id = await request(w, 'remove', DEL);
    expect((await w.post('/auth/confirm', { request_id: id, password: PW })).status).toBe(200);
    // cancel clears the slot
    await w.post('/auth/device/setup/start', {});
    await w.post('/auth/device/setup/cancel');
    expect(w.gw.vault.getSecretSlot('deviceCheckKey')).toBeNull();
  });

  it('a chain that cannot be stored takes the check key slot back (the crash window inside complete)', async () => {
    const w = await world({ platform: fakeHost() });
    const start = await w.post('/auth/device/setup/start', { checkKey: true });
    vi.spyOn(DeviceChainStore.prototype, 'create').mockImplementation(() => { throw new Error('disk full'); });
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(500);
    expect(w.gw.vault.getSecretSlot('deviceCheckKey')).toBeNull();
    expect(w.gw.checkStore.has()).toBe(false);
  });
});

describe('item 9: the vault key is wrapped in Node; the helper never receives it', () => {
  it('wrapping works with no helper at all, and the helper process is not even started for it', async () => {
    const h = noHelper('unsupported_arch');
    const svc = unlockKeyService(h);
    const k = newKey();
    const vk = randomBytes(32);
    const wrapped = await svc.wrap({ publicKey: Buffer.from(k.pub).toString('base64url'), vaultKey: vk, aad: 'a' });
    expect(unwrapKey(k.blob, Buffer.from(wrapped, 'base64url'), 'a').equals(vk)).toBe(true);
    expect(await h.status()).toMatchObject({ available: false });
  });

  sit('what the control plane sends to a real helper never contains the vault key (every request line of an enable and an unlock)', async () => {
    const lines: string[] = [];
    const spec: HelperSpec = { command: SOFT, args: ['serve', '--backend', 'software', '--allow-any-caller'], files: [] };
    const h = new PlatformHelper({
      locate: () => ({ spec }),
      startClient: async (s) => {
        const c = await UnlockHelperClient.start({ command: s.command, args: s.args });
        const child = (c as unknown as { child: { stdin: { write: (d: string) => boolean } } }).child;
        const orig = child.stdin.write.bind(child.stdin);
        child.stdin.write = (d: string) => { lines.push(String(d)); return orig(d); };
        return c;
      },
    });
    hosts.push(h);
    const w = await world({ platform: h });
    await w.post('/auth/platform/enable', { password: PW });
    const keyHex = w.gw.vault.getVaultKeyHex();
    const gw2 = await restart(w, h);
    await call(gw2.port, 'POST', '/auth/unlock/platform', { body: {} });
    expect(gw2.vault.getVaultKeyHex()).toBe(keyHex);
    const sent = lines.join('');
    expect(sent).toContain('"op":"unwrap"');
    expect(sent).not.toContain('"op":"wrap"');
    const raw = Buffer.from(keyHex, 'hex');
    for (const needle of [keyHex, raw.toString('base64'), raw.toString('base64url')]) expect(sent).not.toContain(needle);
  });
});
