import { describe, it, expect } from 'vitest';
import { b64uEncode, buildPairingMessage, identityCode, randomBytes } from '@hap/core/device-keys';
import { JoinDriver } from './join-driver';
import { errorText } from '../texts';
import { FakeAs, FakePasskeys, PeerAdmitter, PeerComputer, PeerJoiner, addWithRoot, seedAccount, testRuntime, type TestRuntime } from './test-kit';
import { Mailbox } from './mailbox';
import { AsApi } from './as-api';

const driverOf = (rt: TestRuntime) => new JoinDriver({
  keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, now: rt.now,
});

async function world(label = 'Office Mac', withCheck = true) {
  const as = await FakeAs.create();
  const mac = await PeerComputer.create(label, withCheck);
  const { root } = await seedAccount(as, mac);
  const rt = testRuntime(as);
  const admitter = new PeerAdmitter(as, mac);
  await admitter.open();
  return { as, mac, root, rt, admitter };
}

/** Scan, confirm the review, name, and make everything up to `commit`. */
async function toWaiting(join: JoinDriver, admitter: PeerAdmitter, name = 'My iPhone') {
  await join.scanned(admitter.qrText);
  join.confirmReview();
  await join.submitName(name);
}

describe('this phone joins an account that exists (pairing 4.3, phone as joiner)', () => {
  it('the whole ceremony: review, commit, challenge, open, the same comparison code on both, confirm on the computer, done', async () => {
    const { as, mac, rt, admitter } = await world();
    const join = driverOf(rt);

    await join.scanned(admitter.qrText);
    const review = join.get();
    expect(review.step).toBe('review');
    if (review.step !== 'review') return;
    expect(review.facts.identityCode).toBe(await identityCode(as.rootDid));
    expect(review.facts.origin).toMatchObject({ label: 'Office Mac', kind: 'gateway' });
    expect(review.facts.devices.map((d) => d.label)).toEqual(['Office Mac']);
    expect(review.facts.admitterLabel).toBe('Office Mac');
    // Before the person agrees, the phone has made no key and said nothing to the mailbox.
    expect(rt.kv.keys()).toEqual([]);
    expect(as.mailboxes.get(admitter.pairing.pairingId)!.messages).toEqual([]);

    join.confirmReview();
    await join.submitName('My iPhone');
    expect(join.get()).toEqual({ step: 'waiting', admitterLabel: 'Office Mac' });
    // The commitment is out before the phone has seen the challenge; the passkey registration is with the server under the pairing id.
    expect(as.mailboxes.get(admitter.pairing.pairingId)!.messages.map((m) => m.kind)).toEqual(['commit']);
    expect(as.mailboxes.get(admitter.pairing.pairingId)!.passkey).toBeTruthy();

    await admitter.step();           // commit -> challenge
    await join.poll();               // challenge -> open, code
    await admitter.step();           // open verified against the commitment, code
    const compare = join.get();
    expect(compare.step).toBe('compare');
    if (compare.step !== 'compare') return;
    expect(compare.code).toMatch(/^\d{6}$/);
    expect(compare.code).toBe(admitter.code);

    // Nobody is admitted until the person confirms on the computer: the phone has no account and cannot sign in.
    expect(await rt.accounts.read()).toBeNull();
    expect(await rt.session.open()).toEqual({ ok: false, code: 'not_paired' });
    expect(as.entries).toHaveLength(1);

    await admitter.confirm();
    expect(admitter.result).toBe('admitted');
    await join.poll();
    expect(join.get()).toEqual({ step: 'done' });

    const account = await rt.accounts.read();
    expect(account).toMatchObject({ root_did: as.rootDid, label: 'My iPhone', as_key: as.keyHex });
    expect(account!.head.seq).toBe(1);
    expect(as.entries).toHaveLength(2);
    expect(as.entries[1]).toMatchObject({ op: 'add', signer: mac.keyId });
    expect(as.entries[1].device).toMatchObject({ kind: 'approve-app', label: 'My iPhone' });

    // The sign-in that follows finds this phone in a chain it verified itself, and lists both devices.
    const opened = await rt.session.open();
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(Object.keys(opened.session.chain.devices)).toHaveLength(2);
  });

  it('keeps no secret in the state or in any request: the QR secret is not in the mailbox, only the pairing id and MACs', async () => {
    const { as, rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    const qrBody = JSON.parse(atob(admitter.qrText.slice('SUVEREN-PAIR-1:'.length).replace(/-/g, '+').replace(/_/g, '/')));
    expect(JSON.stringify(as.calls)).not.toContain(qrBody.secret);
    expect(JSON.stringify(join.get())).not.toContain(qrBody.secret);
  });

  it('an expired QR is refused', async () => {
    const { as, rt, admitter } = await world();
    as.clock += 601;
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toEqual({ step: 'scan', busy: false, error: errorText('qr_expired') });
    expect(rt.kv.keys()).toEqual([]);
  });

  it('text that is not a pairing QR is refused', async () => {
    const { rt } = await world();
    const join = driverOf(rt);
    await join.scanned('https://example.com/not-a-qr');
    expect(join.get()).toMatchObject({ step: 'scan', error: errorText('qr_invalid') });
  });

  it('a QR shown by a new computer is for admitting, not for joining', async () => {
    const { as, rt, mac } = await world();
    const joiner = new PeerJoiner(as, mac);
    await joiner.open();
    const join = driverOf(rt);
    await join.scanned(joiner.qrText);
    expect(join.get()).toMatchObject({ step: 'scan', error: errorText('qr_wrong_kind') });
  });

  it('a QR for another server is refused', async () => {
    const { as, mac, rt } = await world();
    const admitter = new PeerAdmitter(as, mac);
    await admitter.open({ as_url: 'https://other.test' });
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toMatchObject({ error: errorText('qr_other_server') });
  });

  it('a QR whose as_key is not the key the server proves it holds is refused before the mailbox is read', async () => {
    const { as, mac, rt } = await world();
    const other = await FakeAs.create();
    const admitter = new PeerAdmitter(as, mac);
    await admitter.open({ as_key: other.keyHex });
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toMatchObject({ error: errorText('as_unverified') });
    expect(as.calls.some((c) => c.path.startsWith('/api/devices/pairings'))).toBe(false);
  });

  it('a mailbox that does not exist (the QR was never opened, or is gone) says so', async () => {
    const { as, mac, rt } = await world();
    const admitter = new PeerAdmitter(as, mac);
    await admitter.open();
    as.mailboxes.clear();
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toMatchObject({ error: errorText('qr_not_open') });
  });

  it('refuses an admitter that cannot add devices (no check key)', async () => {
    const { rt, admitter } = await world('Old PC', false);
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toMatchObject({ step: 'scan', error: errorText('admitter_cannot_grant') });
  });

  it('refuses a chain that does not verify from the genesis on (the server rewrote it)', async () => {
    const { as, rt, admitter } = await world();
    as.entries[0] = { ...as.entries[0], created_at: as.entries[0].created_at + 1 };
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toMatchObject({ error: errorText('chain_invalid') });
  });

  it('a QR that names another root DID than the chain the server gives is refused', async () => {
    const { as, mac, rt } = await world();
    const wrong = await FakeAs.create();
    const mac2 = await PeerComputer.create('Else');
    await seedAccount(wrong, mac2);
    const admitter = new PeerAdmitter(as, mac);
    await admitter.open({ root_did: wrong.rootDid });
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    expect(join.get()).toMatchObject({ error: errorText('chain_invalid') });
  });

  it('refuses a name another device in the account already has, and asks again', async () => {
    const { rt, admitter } = await world('Office Mac');
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    join.confirmReview();
    await join.submitName(' office mac ');
    expect(join.get()).toMatchObject({ step: 'name', error: errorText('label_taken') });
    expect(rt.kv.keys()).toEqual([]);
  });

  it('a phone that is already paired refuses to pair again', async () => {
    const { as, rt, admitter } = await world();
    const first = driverOf(rt);
    await toWaiting(first, admitter);
    await admitter.step(); await first.poll(); await admitter.step(); await admitter.confirm(); await first.poll();
    expect(first.get().step).toBe('done');
    const again = driverOf(rt);
    const admitter2 = new PeerAdmitter(as, await PeerComputer.create('Second'));
    await admitter2.open();
    await again.scanned(admitter2.qrText);
    expect(again.get()).toMatchObject({ step: 'scan', error: errorText('already_paired') });
  });

  it('a message with a wrong MAC ends the pairing loudly, deletes the keys, and adds nothing', async () => {
    const { as, rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    as.mailboxes.get(admitter.pairing.pairingId)!.messages.push({ kind: 'challenge', body: { r_a: b64uEncode(randomBytes(32)) }, mac: b64uEncode(randomBytes(32)) });
    await join.poll();
    expect(join.get()).toEqual({ step: 'failed', error: errorText('bad_message') });
    expect(rt.kv.keys()).toEqual([]);
    expect(as.entries).toHaveLength(1);
  });

  it('a kind that appears twice ends the pairing (the server keeps each kind once; two means tampering)', async () => {
    const { as, rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    const box = as.mailboxes.get(admitter.pairing.pairingId)!;
    const a = await buildPairingMessage(admitter.pairing.macKey, 'challenge', { r_a: b64uEncode(randomBytes(32)) });
    const b = await buildPairingMessage(admitter.pairing.macKey, 'challenge', { r_a: b64uEncode(randomBytes(32)) });
    box.messages.push(a, b);
    await join.poll();
    expect(join.get()).toEqual({ step: 'failed', error: errorText('bad_message') });
    expect(rt.kv.keys()).toEqual([]);
  });

  it('the computer refusing (the person tapped the wrong code) ends it with nothing stored', async () => {
    const { as, rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    await admitter.step(); await join.poll(); await admitter.step();
    await admitter.refuse('CODE_MISMATCH');
    await join.poll();
    expect(join.get()).toEqual({ step: 'failed', error: errorText('wrong_code') });
    expect(rt.kv.keys()).toEqual([]);
    expect(await rt.accounts.read()).toBeNull();
    expect(as.entries).toHaveLength(1);
  });

  it('a head that moved before the computer appended is said, and nothing is stored', async () => {
    const { as, root, rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    await admitter.step(); await join.poll(); await admitter.step();
    // Another computer is added first: seq 1 is taken.
    await addWithRoot(as, root, await PeerComputer.create('Third'));
    await admitter.confirm();
    expect(admitter.result).toBe('refused');
    await join.poll();
    expect(join.get()).toEqual({ step: 'failed', error: errorText('CHAIN_HEAD_MOVED') });
    expect(rt.kv.keys()).toEqual([]);
    expect(await rt.accounts.read()).toBeNull();
  });

  it('a done whose entry hash is not the entry the phone built is refused', async () => {
    const { as, rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    await admitter.step(); await join.poll(); await admitter.step();
    await new Mailbox(new AsApi(as), admitter.pairing).send('done', { entry_hash: 'sha256:' + 'e'.repeat(64) });
    await join.poll();
    expect(join.get()).toEqual({ step: 'failed', error: errorText('head_mismatch') });
    expect(rt.kv.keys()).toEqual([]);
    expect(await rt.accounts.read()).toBeNull();
  });

  it('cancel removes the keys of an unfinished pairing', async () => {
    const { rt, admitter } = await world();
    const join = driverOf(rt);
    await toWaiting(join, admitter);
    expect(await rt.keys.exists()).toBe(true);
    await join.cancel();
    expect(await rt.keys.exists()).toBe(false);
    expect(join.get()).toEqual({ step: 'scan', busy: false });
  });

  it('a cancelled touch while making the passkey leaves no keys', async () => {
    const as = await FakeAs.create();
    const mac = await PeerComputer.create('Office Mac');
    await seedAccount(as, mac);
    const passkeys = new FakePasskeys();
    const rt = testRuntime(as, { passkeys });
    const admitter = new PeerAdmitter(as, mac);
    await admitter.open();
    const join = driverOf(rt);
    await join.scanned(admitter.qrText);
    join.confirmReview();
    passkeys.cancelNext = true;
    await join.submitName('My iPhone');
    expect(join.get()).toEqual({ step: 'failed', error: errorText('cancelled') });
    expect(rt.kv.keys()).toEqual([]);
  });
});
