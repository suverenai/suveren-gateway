import { describe, it, expect } from 'vitest';
import { entryHash, rootKeyFromRecoveryCode, verifyChain, verifyCheck } from '@hap/core/device-keys';
import { AdmitDriver, codeChoices } from './admit-driver';
import { errorText } from '../texts';
import { FakeAs, FakePasskeys, PeerAdmitter, PeerComputer, PeerJoiner, addWithRoot, registerPhone, testRuntime, type TestRuntime } from './test-kit';

const driverOf = (rt: TestRuntime) => new AdmitDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now });

/** A phone that registered an account and has an open session. */
async function world(over: { passkeys?: FakePasskeys } = {}) {
  const as = await FakeAs.create();
  const rt = testRuntime(as, over);
  const { recoveryCode } = await registerPhone(rt, as, 'My iPhone');
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error('session');
  const mac = await PeerComputer.create('New Mac');
  const joiner = new PeerJoiner(as, mac);
  await joiner.open();
  return { as, rt, mac, joiner, recoveryCode };
}

/** Scan, and bring the ceremony to the phone's choose screen. */
async function toChoose(admit: AdmitDriver, joiner: PeerJoiner) {
  await admit.scanned(joiner.qrText);
  await joiner.step();   // hello -> commit
  await admit.poll();    // commit -> challenge
  await joiner.step();   // challenge -> open
  await admit.poll();    // open -> choose
}

describe('this phone admits a new computer (pairing 4.3, phone as admitter)', () => {
  it('the whole ceremony: hello, commit, challenge, open, three codes, the right tap, the phone\'s touch, the entry is appended, done', async () => {
    const { as, rt, mac, joiner } = await world();
    const admit = driverOf(rt);
    await admit.scanned(joiner.qrText);
    expect(admit.get()).toEqual({ step: 'opening' });
    // The phone made the mailbox and said hello with its own verified facts.
    const box = as.mailboxes.get(joiner.pairing.pairingId)!;
    expect(box.messages.map((m) => m.kind)).toEqual(['hello']);
    expect(box.messages[0].body).toMatchObject({ root_did: as.rootDid, key_id: (await rt.accounts.read())!.key_id, as_key: as.keyHex });

    await joiner.step(); await admit.poll(); await joiner.step(); await admit.poll();
    const st = admit.get();
    expect(st.step).toBe('choose');
    if (st.step !== 'choose') return;
    expect(st.choice.label).toBe('New Mac');
    expect(st.choice.kind).toBe('gateway');
    expect(st.choice.codes).toHaveLength(3);
    expect(new Set(st.choice.codes).size).toBe(3);
    expect(st.choice.codes).toContain(joiner.code);
    // The list after the add: this phone, and the new computer marked as new.
    expect(st.choice.rows.map((r) => [r.label, !!r.adding])).toEqual([['My iPhone', false], ['New Mac', true]]);
    expect(as.entries).toHaveLength(1);

    const proved = (rt.check as FakePasskeys).proved.length;
    await admit.choose(joiner.code as string);
    const done = admit.get();
    expect(done.step).toBe('done');
    if (done.step !== 'done') return;
    expect(done.label).toBe('New Mac');
    expect(done.rows.map((r) => r.label)).toEqual(['My iPhone', 'New Mac']);
    // One touch, over the entry; the entry is in the chain, signed by the phone, with both checks, and the chain verifies.
    expect((rt.check as FakePasskeys).proved.length).toBe(proved + 1);
    expect(as.entries).toHaveLength(2);
    const added = as.entries[1];
    expect(added.signer).toBe((await rt.accounts.read())!.key_id);
    expect(added.sigs).toHaveLength(2);
    expect(added.checks).toHaveLength(2);
    await verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
    const phone = (await as.state()).devices[(await rt.accounts.read())!.key_id];
    expect(await verifyCheck(phone.check!, await entryHash(added), added.checks.find((c) => c.by === phone.key_id)!.check)).toBe(true);

    // The computer is told which entry was stored.
    await joiner.step();
    expect(joiner.doneMessage?.body).toEqual({ entry_hash: await entryHash(added) });
    expect(mac.keyId).toBe(added.device!.key_id);
    // The phone's stored head moved with the chain it fetched again.
    expect((await rt.accounts.read())!.head.seq).toBe(1);
  });

  it('a wrong tap ends the pairing, adds nothing, and tells the computer', async () => {
    const { as, rt, joiner } = await world();
    const admit = driverOf(rt);
    await toChoose(admit, joiner);
    const st = admit.get();
    if (st.step !== 'choose') throw new Error('choose');
    const wrong = st.choice.codes.find((c) => c !== joiner.code) as string;
    await admit.choose(wrong);
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('wrong_code') });
    expect(as.entries).toHaveLength(1);
    await joiner.step();
    expect(joiner.doneMessage?.body).toEqual({ refused: 'CODE_MISMATCH' });
  });

  it('an open that is not the entry the computer committed to is refused before any code is shown', async () => {
    const { as, rt, joiner } = await world();
    joiner.swapEntryInOpen = true;
    const admit = driverOf(rt);
    await toChoose(admit, joiner);
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('commit_mismatch') });
    expect(as.entries).toHaveLength(1);
    await joiner.step();
    expect(joiner.doneMessage?.body).toEqual({ refused: 'COMMIT_MISMATCH' });
  });

  it('a QR whose as_key is not the one this phone pinned is refused, and no mailbox is made', async () => {
    const { as, rt, mac } = await world();
    const other = await FakeAs.create();
    const joiner = new PeerJoiner(as, mac);
    await joiner.open({ as_key: other.keyHex });
    const admit = driverOf(rt);
    await admit.scanned(joiner.qrText);
    expect(admit.get()).toMatchObject({ step: 'scan', error: errorText('as_key_mismatch') });
    expect(as.calls.some((c) => c.method === 'POST' && c.path === '/api/devices/pairings')).toBe(false);
  });

  it('a QR for another server, an expired QR, and a QR shown by a device that already has the account are refused', async () => {
    const { as, rt, mac } = await world();
    const admit = driverOf(rt);
    const other = new PeerJoiner(as, mac);
    await other.open({ as_url: 'https://other.test' });
    await admit.scanned(other.qrText);
    expect(admit.get()).toMatchObject({ error: errorText('qr_other_server') });

    const old = new PeerJoiner(as, mac);
    await old.open();
    as.clock += 601;
    await admit.scanned(old.qrText);
    expect(admit.get()).toMatchObject({ error: errorText('qr_expired') });

    const shown = new PeerAdmitter(as, mac);
    // (an admitter QR needs a chain the computer is in; use this phone's own device for the key id)
    await shown.open({ key_id: (await rt.accounts.read())!.key_id });
    await admit.scanned(shown.qrText);
    expect(admit.get()).toMatchObject({ error: errorText('qr_wrong_kind') });
  });

  it('without an open session the phone asks to be opened first', async () => {
    const { rt, joiner } = await world();
    rt.session.lost();
    const admit = driverOf(rt);
    await admit.scanned(joiner.qrText);
    expect(admit.get()).toMatchObject({ error: errorText('session_ended') });
  });

  it('refuses a computer whose name another device already has', async () => {
    const { as, rt } = await world();
    const twin = await PeerComputer.create('my iphone');
    const joiner = new PeerJoiner(as, twin);
    await joiner.open();
    const admit = driverOf(rt);
    await toChoose(admit, joiner);
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('label_taken') });
    expect(as.entries).toHaveLength(1);
  });

  it('refuses when the account already has the most devices', async () => {
    const { as, rt, mac, recoveryCode } = await world();
    const root = await rootKeyFromRecoveryCode(recoveryCode);
    for (const n of ['A', 'B', 'C', 'D']) await addWithRoot(as, root, await PeerComputer.create(n));
    // The phone's session still shows the old chain: refresh it first, as the device list does.
    expect((await rt.session.refreshChain()).ok).toBe(true);
    const joiner = new PeerJoiner(as, mac);
    await joiner.open();
    const admit = driverOf(rt);
    await admit.scanned(joiner.qrText);
    expect(admit.get()).toMatchObject({ error: errorText('too_many_devices') });
  });

  it('a cancelled touch adds nothing and tells the computer', async () => {
    const passkeys = new FakePasskeys();
    const { as, rt, joiner } = await world({ passkeys });
    const admit = driverOf(rt);
    await toChoose(admit, joiner);
    passkeys.cancelNext = true;
    await admit.choose(joiner.code as string);
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('cancelled') });
    expect(as.entries).toHaveLength(1);
    await joiner.step();
    expect(joiner.doneMessage?.body).toEqual({ refused: 'CHECK_CANCELLED' });
  });

  it('a head that moved before the append is refused by the server and said to both', async () => {
    const { as, rt, joiner, recoveryCode } = await world();
    const admit = driverOf(rt);
    await toChoose(admit, joiner);
    await addWithRoot(as, await rootKeyFromRecoveryCode(recoveryCode), await PeerComputer.create('Third'));
    await admit.choose(joiner.code as string);
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('chain_moved') });
    expect(as.entries).toHaveLength(2);
    await joiner.step();
    expect(joiner.doneMessage?.body).toEqual({ refused: 'CHAIN_HEAD_MOVED' });
  });

  it('a mailbox message with a wrong MAC ends the pairing', async () => {
    const { as, rt, joiner } = await world();
    const admit = driverOf(rt);
    await admit.scanned(joiner.qrText);
    as.mailboxes.get(joiner.pairing.pairingId)!.messages.push({ kind: 'commit', body: { c: 'sha256:' + '0'.repeat(64) }, mac: 'AAAA' });
    await admit.poll();
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('bad_message') });
  });

  it('does nothing after the QR ran out while it waited', async () => {
    const { as, rt, joiner } = await world();
    const admit = driverOf(rt);
    await admit.scanned(joiner.qrText);
    as.clock += 601;
    await admit.poll();
    expect(admit.get()).toEqual({ step: 'failed', error: errorText('qr_expired') });
  });
});

describe('the three codes', () => {
  it('always hold the real one, three different six-digit codes, in an order that is not always the same', () => {
    const positions = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const c = codeChoices('123456');
      expect(c).toHaveLength(3);
      expect(new Set(c).size).toBe(3);
      for (const x of c) expect(x).toMatch(/^\d{6}$/);
      expect(c).toContain('123456');
      positions.add(c.indexOf('123456'));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});
