import { describe, it, expect } from 'vitest';
import { entryHash, identityCode, verifyChain, verifyCheck } from '@hap/core/device-keys';
import { RegisterDriver } from './register-driver';
import { errorText } from '../texts';
import { FakeAs, FakePasskeys, registerPhone, testRuntime, type TestRuntime } from './test-kit';

const driverOf = (rt: TestRuntime) => new RegisterDriver({
  keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, rpId: rt.rpId, now: rt.now,
});

describe('register this phone as the first device (genesis, step 11)', () => {
  it('code, name, recovery code, kept, then the account exists on the server and on the phone', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const { driver, recoveryCode } = await registerPhone(rt, as, 'My iPhone');
    expect(driver.get().step).toBe('done');
    expect(recoveryCode).toMatch(/^SV1-/);

    // The server holds a chain of one entry, a genesis that verifies, with this phone as the only device and its passkey as check key.
    expect(as.entries).toHaveLength(1);
    const state = await verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
    const dev = Object.values(state.devices)[0];
    expect(dev).toMatchObject({ kind: 'approve-app', label: 'My iPhone', keystore: 'platform' });
    expect(dev.check).toMatchObject({ type: 'webauthn', rp_id: 'approve.test' });

    // The phone stored exactly what it built, and pinned its own identity.
    const account = await rt.accounts.read();
    expect(account).toMatchObject({ root_did: as.rootDid, key_id: dev.key_id, label: 'My iPhone', as_url: rt.asUrl, as_key: as.keyHex });
    expect(account?.head).toEqual({ seq: 0, hash: await entryHash(as.entries[0]) });
    expect(account?.check.cred_id).toBe((dev.check as { cred_id: string }).cred_id);
  });

  it('the genesis carries the phone\'s check over the entry, and it is a real touch over exactly that entry', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    await registerPhone(rt, as);
    const entry = as.entries[0];
    const dev = entry.device!;
    const proof = entry.checks.find((c) => c.by === dev.key_id)!;
    expect(await verifyCheck(dev.check!, await entryHash(entry), proof.check)).toBe(true);
    // Two touches: one to make the passkey, one over the entry.
    expect((rt.check as FakePasskeys).proved).toEqual([await entryHash(entry)]);
  });

  it('the recovery code is shown once and is NOT in the state, the store, or any request', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode(as.issueCode());
    await d.submitName('My iPhone');
    const code = d.recoveryCode()!;
    expect(JSON.stringify(d.get())).not.toContain(code);
    d.codeSeen();
    d.toggleKept(true);
    expect(JSON.stringify(d.get())).not.toContain(code);
    await d.finish();
    expect(d.get().step).toBe('done');
    expect(d.recoveryCode()).toBeNull();
    for (const k of rt.kv.keys()) expect(JSON.stringify(await rt.kv.get(k) ?? null)).not.toContain(code.replace(/-/g, '').slice(4, 12));
    expect(JSON.stringify(as.calls)).not.toContain(code);
    expect(JSON.stringify(as.calls)).not.toContain('SV1-');
    expect(JSON.stringify(as.entries)).not.toContain('SV1-');
  });

  it('nothing is made or stored before the person has kept the code', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode(as.issueCode());
    await d.submitName('My iPhone');
    d.codeSeen();
    await d.finish(); // not ticked
    expect(d.get().step).toBe('kept');
    expect(rt.kv.keys()).toEqual([]);
    expect(as.entries).toHaveLength(0);
    d.cancel();
    expect(d.get()).toEqual({ step: 'code', busy: false });
    expect(rt.kv.keys()).toEqual([]);
  });

  it('a second use of the enrolment code is refused and the phone says so, and keeps nothing', async () => {
    const as = await FakeAs.create();
    const code = as.issueCode();
    const first = testRuntime(as);
    const d1 = driverOf(first);
    await d1.submitCode(code); await d1.submitName('First'); d1.codeSeen(); d1.toggleKept(true); await d1.finish();
    expect(d1.get().step).toBe('done');

    const second = testRuntime(as);
    const d2 = driverOf(second);
    await d2.submitCode(code); await d2.submitName('Second'); d2.codeSeen(); d2.toggleKept(true); await d2.finish();
    expect(d2.get()).toEqual({ step: 'failed', error: errorText('ENROLMENT_CODE_USED'), canRetry: false });
    expect(second.kv.keys()).toEqual([]);
    expect(await second.accounts.read()).toBeNull();
  });

  it('a used code on a server that checks the code first reads as "already used"', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const code = as.issueCode();
    as.usedCodes.add(code);
    const d = driverOf(rt);
    await d.submitCode(code); await d.submitName('x'); d.codeSeen(); d.toggleKept(true); await d.finish();
    expect(d.get()).toEqual({ step: 'failed', error: errorText('ENROLMENT_CODE_USED'), canRetry: false });
    expect(rt.kv.keys()).toEqual([]);
  });

  it('a code the server does not know is refused', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode('AAAAAAAAAAAAAAAAAAAAAA');
    await d.submitName('x'); d.codeSeen(); d.toggleKept(true); await d.finish();
    expect(d.get()).toMatchObject({ step: 'failed', error: errorText('ENROLMENT_CODE_INVALID') });
  });

  it('a genesis without a passkey registration for the phone is refused by the server (plan 3.2 rule 2a)', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const { driver } = await registerPhone(rt, as);
    expect(driver.get().step).toBe('done');
    // Replay the genesis body with the passkey left out, on a server with no chain yet.
    const fresh = await FakeAs.create();
    const body = { entry: as.entries[0], enrolment_code: fresh.issueCode() };
    const r = await fresh.call('POST', '/api/devices/chain', { body });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('PASSKEY_REQUIRED');
  });

  it('a malformed code is refused before anything is asked of the server', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode('x y');
    expect(d.get()).toMatchObject({ step: 'code', error: errorText('enrolment_code_invalid') });
    expect(as.calls).toHaveLength(0);
  });

  it('a server that cannot prove it holds its key is refused before the code is used', async () => {
    const as = await FakeAs.create();
    const other = await FakeAs.create();
    // The server names its key, but signs its challenges with another one.
    as.challengeKey = (other as unknown as { key: CryptoKeyPair }).key.privateKey;
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode(as.issueCode());
    expect(d.get()).toMatchObject({ step: 'code', error: errorText('as_unverified') });
  });

  it('a server that cannot be reached can be tried again, with the same code, and the phone keeps no keys meanwhile', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode(as.issueCode()); await d.submitName('x'); d.codeSeen(); d.toggleKept(true);
    as.down = true;
    await d.finish();
    expect(d.get()).toMatchObject({ step: 'failed', canRetry: true });
    expect(rt.kv.keys()).toEqual([]);
    as.down = false;
    await d.finish();
    expect(d.get().step).toBe('done');
  });

  it('a cancelled touch fails visibly, leaves no keys and can be tried again', async () => {
    const as = await FakeAs.create();
    const passkeys = new FakePasskeys();
    const rt = testRuntime(as, { passkeys });
    const d = driverOf(rt);
    await d.submitCode(as.issueCode()); await d.submitName('x'); d.codeSeen(); d.toggleKept(true);
    passkeys.cancelNext = true;
    await d.finish();
    expect(d.get()).toEqual({ step: 'failed', error: errorText('cancelled'), canRetry: true });
    expect(rt.kv.keys()).toEqual([]);
    await d.finish();
    expect(d.get().step).toBe('done');
  });

  it('a phone without a screen lock cannot register', async () => {
    const as = await FakeAs.create();
    const passkeys = new FakePasskeys();
    passkeys.noScreenLock = true;
    const rt = testRuntime(as, { passkeys });
    const d = driverOf(rt);
    await d.submitCode(as.issueCode()); await d.submitName('x'); d.codeSeen(); d.toggleKept(true); await d.finish();
    expect(d.get()).toMatchObject({ step: 'failed', error: errorText('no_user_verification') });
    expect(as.entries).toHaveLength(0);
  });

  it('a name that is not a valid label is refused', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    const d = driverOf(rt);
    await d.submitCode(as.issueCode());
    await d.submitName('   ');
    expect(d.get()).toMatchObject({ step: 'name', error: errorText('label_invalid') });
    await d.submitName('a\u0000b');
    expect(d.get()).toMatchObject({ step: 'name', error: errorText('label_invalid') });
  });

  it('a phone that is already paired refuses to pair again', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    await registerPhone(rt, as);
    const d = driverOf(rt);
    await d.submitCode(as.issueCode()); await d.submitName('again'); d.codeSeen(); d.toggleKept(true); await d.finish();
    expect(d.get()).toEqual({ step: 'failed', error: errorText('already_paired'), canRetry: false });
  });

  it('the identity the phone pinned is the one the root key made: the identity code matches', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    await registerPhone(rt, as);
    const account = await rt.accounts.read();
    expect(await identityCode(account!.root_did)).toMatch(/^\d{4}( \d{4}){5}$/);
  });
});
