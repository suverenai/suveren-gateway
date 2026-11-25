import { describe, it, expect } from 'vitest';
import { IDLE_LIMIT, CHECK_LIMIT, BACKGROUND_LIMIT } from './session';
import { FakeAs, FakePasskeys, PeerComputer, addWithRoot, registerPhone, removeWithRoot, testRuntime, type TestRuntime } from './test-kit';
import { b64uEncode, buildSignin, rootKeyFromRecoveryCode, signedBytes } from '@hap/core/device-keys';

async function paired() {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  const reg = await registerPhone(rt, as);
  codes.set(rt, reg.recoveryCode);
  return { as, rt, reg, recoveryCode: reg.recoveryCode };
}

/** The root key of the account a phone registered (the test kept the recovery code the phone showed). */
const codes = new WeakMap<TestRuntime, string>();
async function rootOf(rt: TestRuntime) {
  return rootKeyFromRecoveryCode(codes.get(rt) as string);
}

describe('the phone\'s session (plan 4.1, 6.2, 8; DEC-47)', () => {
  it('opens with a sign-in and a check, fetches the chain, verifies it, and finds this phone in it', async () => {
    const { as, rt } = await paired();
    const r = await rt.session.open();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.user).toMatchObject({ id: 'user-1', email: 'anna@example.com', did: as.rootDid });
    expect(r.session.chain.head.seq).toBe(0);
    expect(rt.session.bearer()).toBe(r.session.token);
    // Registration touched once for the entry; the sign-in is a second, separate touch over the sign-in object.
    expect((rt.check as FakePasskeys).proved).toHaveLength(2);
  });

  it('the token is in memory only: not in the store, not in any stored value', async () => {
    const { rt } = await paired();
    const r = await rt.session.open();
    if (!r.ok) throw new Error('open');
    for (const k of rt.kv.keys()) expect(JSON.stringify(await rt.kv.get(k) ?? null)).not.toContain(r.session.token);
  });

  it('a phone session is refused by the server without the check: the check is what opens it', async () => {
    const { as, rt } = await paired();
    const account = await rt.accounts.read();
    // A sign-in with the device key alone, and no check, as a stolen key in a script would send.
    const ch = await as.call('POST', '/api/devices/challenge', { body: { key_id: account!.key_id } });
    const { nonce, aud } = ch.body as { nonce: string; aud: string };
    const signin = buildSignin({ aud, root_did: account!.root_did, key_id: account!.key_id, nonce, chain_seq: 0, chain_head: account!.head.hash, issued_at: as.now() });
    const sig = b64uEncode(await rt.keys.sign(signedBytes(signin)));
    const r = await as.call('POST', '/api/devices/session', { body: { signin, sig } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('CHECK_REQUIRED');
  });

  it('proves the server holds the pinned key before it signs anything', async () => {
    const { as, rt } = await paired();
    const other = await FakeAs.create();
    as.challengeKey = (other as unknown as { key: CryptoKeyPair }).key.privateKey;
    const before = as.calls.length;
    const r = await rt.session.open();
    expect(r).toEqual({ ok: false, code: 'as_unverified' });
    // No challenge for a sign-in nonce, no session call: nothing was signed.
    expect(as.calls.slice(before).map((c) => c.path)).toEqual(['/api/as/challenge']);
  });

  it('refuses a server whose challenge names an audience other than the pinned key', async () => {
    const { as, rt } = await paired();
    const original = as.call.bind(as);
    as.call = (async (m, p, o) => {
      const r = await original(m, p, o);
      return p === '/api/devices/challenge' ? { ...r, body: { ...(r.body as object), aud: 'f'.repeat(64) } } : r;
    }) as FakeAs['call'];
    expect(await rt.session.open()).toEqual({ ok: false, code: 'aud_mismatch' });
  });

  it('a server that is behind the head the phone verified is a rollback; a forked head is a fork', async () => {
    const { as, rt } = await paired();
    as.sessionRefusal = { status: 409, code: 'CHAIN_AHEAD' };
    expect(await rt.session.open()).toMatchObject({ ok: false, code: 'chain_rollback' });
    as.sessionRefusal = { status: 409, code: 'FORK' };
    expect(await rt.session.open()).toMatchObject({ ok: false, code: 'chain_fork' });
  });

  it('a chain the server truncated below the head the phone stored is a rollback, and no new session is made', async () => {
    const { as, rt } = await paired();
    const root = await rootOf(rt);
    await addWithRoot(as, root, await PeerComputer.create('Office Mac'));
    expect((await rt.session.open()).ok).toBe(true); // the phone now stores head 1
    expect((await rt.accounts.read())!.head.seq).toBe(1);
    rt.session.lost();
    as.entries.pop(); // the server's chain is back at head 0
    expect(await rt.session.open()).toMatchObject({ ok: false, code: 'chain_rollback' });
    expect(rt.session.bearer()).toBeNull();
  });

  it('a phone removed from the chain cannot sign in: the server refuses it', async () => {
    const { as, rt } = await paired();
    const root = await rootOf(rt);
    await addWithRoot(as, root, await PeerComputer.create('Office Mac'));
    await removeWithRoot(as, root, (await rt.accounts.read())!.key_id);
    expect(await rt.session.open()).toMatchObject({ ok: false, code: 'signin_refused', asCode: 'NOT_ACTIVE' });
  });

  it('a server that lets a removed phone in anyway is caught by the phone\'s own chain check: device_removed', async () => {
    const { as, rt } = await paired();
    const root = await rootOf(rt);
    await addWithRoot(as, root, await PeerComputer.create('Office Mac'));
    await removeWithRoot(as, root, (await rt.accounts.read())!.key_id);
    as.acceptAnySignin = true;
    expect(await rt.session.open()).toEqual({ ok: false, code: 'device_removed' });
    expect(rt.session.bearer()).toBeNull();
    // The server was asked to close the session it had opened.
    expect(as.sessions.size).toBe(0);
  });
});

describe('the phone\'s own limits (plan 8, 6.2)', () => {
  async function open() {
    const { as, rt } = await paired();
    expect((await rt.session.open()).ok).toBe(true);
    return { as, rt };
  }

  it('an hour without use ends it; use moves the limit; polling never counts', async () => {
    const { as, rt } = await open();
    as.clock += IDLE_LIMIT - 10;
    expect(rt.session.bearer()).not.toBeNull();
    rt.session.noteUse();
    as.clock += IDLE_LIMIT - 10;
    expect(rt.session.bearer()).not.toBeNull();
    as.clock += 20;
    expect(rt.session.bearer()).toBeNull();
  });

  it('12 hours after the last check it ends however much it was used', async () => {
    const { as, rt } = await open();
    for (let i = 0; i < 13; i++) { as.clock += 1800 * 2; rt.session.noteUse(); }
    expect(as.clock - 1_800_000_000).toBeGreaterThan(CHECK_LIMIT);
    expect(rt.session.bearer()).toBeNull();
  });

  it('more than 5 minutes in the background ends it; less does not', async () => {
    const { as, rt } = await open();
    rt.session.noteBackground();
    as.clock += BACKGROUND_LIMIT - 1;
    rt.session.noteForeground();
    expect(rt.session.bearer()).not.toBeNull();
    rt.session.noteBackground();
    as.clock += BACKGROUND_LIMIT + 1;
    rt.session.noteForeground();
    expect(rt.session.bearer()).toBeNull();
  });

  it('an ended session is closed on the server too, and a new one needs a new touch', async () => {
    const { as, rt } = await open();
    const proved = (rt.check as FakePasskeys).proved.length;
    rt.session.lost();
    expect(rt.session.bearer()).toBeNull();
    expect(as.sessions.size).toBe(0);
    expect((await rt.session.open()).ok).toBe(true);
    expect((rt.check as FakePasskeys).proved.length).toBe(proved + 1);
  });

  it('two calls to open share one sign-in (one touch)', async () => {
    const { rt } = await paired();
    const before = (rt.check as FakePasskeys).proved.length;
    const [a, b] = await Promise.all([rt.session.open(), rt.session.open()]);
    expect(a.ok && b.ok).toBe(true);
    expect((rt.check as FakePasskeys).proved.length).toBe(before + 1);
  });

  it('refuses when the phone is not paired or its keys are gone', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    expect(await rt.session.open()).toEqual({ ok: false, code: 'not_paired' });
    await registerPhone(rt, as);
    await rt.keys.deleteAll();
    expect(await rt.session.open()).toEqual({ ok: false, code: 'keys_missing' });
  });

  it('a server that cannot be reached is "as_unreachable", with no session', async () => {
    const { as, rt } = await paired();
    as.down = true;
    expect(await rt.session.open()).toEqual({ ok: false, code: 'as_unreachable' });
  });
});
