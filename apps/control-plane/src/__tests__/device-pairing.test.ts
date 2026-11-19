/**
 * Pairing with the phone app, the gateway's side (device-keys plan 4.3, step 11 gateway part): this computer's `DevicePairing`
 * against the phone app's OWN drivers (apps/approve `JoinDriver`, `AdmitDriver`), through the phone's fake Authority Server
 * (`FakeAs`, which enforces what the plan says the real one must: each kind once, a phone `add` only with a passkey registration
 * stored under the pairing id, chain verification on every append). Two implementations that share only the protocol and
 * `@suveren/pairing` meet here: real keys, real signatures, real chain verification, a real vault and chain store; the native
 * helper is packages/unlock-helper's fake (software P-256, no touch).
 *
 * Not covered here: the real Authority Server (suveren-e2e), a real Touch ID prompt, a real phone camera.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dk from '@hap/core/device-keys';
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import { Vault } from '../lib/vault';
import { DeviceChainStore } from '../lib/device-chain-store';
import { CheckKeyStore, PlatformChecks } from '../lib/platform-checks';
import { PlatformHelper } from '../lib/platform-helper';
import { loadOrGenerateDeviceSigningKey, loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import { DevicePairing, PairingRefusal, type PairingView } from '../lib/device-pairing';
import { FakeAs, registerPhone, testRuntime, AS_URL } from '../../../approve/src/lib/test-kit';
import { JoinDriver } from '../../../approve/src/lib/join-driver';
import { AdmitDriver } from '../../../approve/src/lib/admit-driver';
import { Mailbox, pairingKeysOf } from '@suveren/pairing';
import { AsApi } from '../../../approve/src/lib/as-api';

const FAKE = fileURLToPath(new URL('../../../../packages/unlock-helper/test/fake-helper.mjs', import.meta.url));
const FAST = { scrypt: { N: 1024, r: 8, p: 1 }, deviceKeys: true };
const PW = 'correct horse battery';

const hosts: PlatformHelper[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.close(); });

const fakeHost = (): PlatformHelper => {
  const h = new PlatformHelper({ locate: () => ({ spec: { command: process.execPath, args: [FAKE], env: { ...process.env }, files: [] } }), idleMs: 30, touchTimeoutMs: 20_000 });
  hosts.push(h);
  return h;
};

/** A gateway process: a real vault and chain store, the helper's checks, a signin that records, and the pairing under test. */
async function gateway(as: FakeAs, o: { helper?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'device-pairing-'));
  const vault = new Vault(dir, FAST);
  await vault.createWithPassword(PW, 'u1');
  const store = new DeviceChainStore(vault);
  const host = fakeHost();
  const checks = o.helper === false ? undefined : new PlatformChecks(host);
  const checkStore = new CheckKeyStore(vault, store);
  const signIns: Array<{ probe: boolean }> = [];
  const probe = { ok: false };
  const signin = {
    signIn: async () => { signIns.push({ probe: false }); return { ok: true as const, session: { expiresAt: 0, user: { id: 'u', did: store.read()!.rootDid }, head: store.read()!.head } }; },
    performSignIn: async () => { signIns.push({ probe: true }); return probe.ok ? { ok: true as const, session: { expiresAt: 0, user: { id: 'u', did: '' }, head: { seq: 0, hash: '' } } } : { ok: false as const, code: 'signin_refused', transient: false }; },
  };
  const pairing = new DevicePairing({
    vault, store, client: { asUrl: AS_URL, call: (m, p, opts) => as.call(m as never, p, opts as never) }, signin: signin as never,
    checkAs: async () => ({ ok: true, publicKeyHex: as.keyHex }), ...(checks ? { checks, checkStore } : {}), now: as.now,
  });
  return { dir, vault, store, checks, checkStore, pairing, signIns, probe };
}

/** The gateway is the account's first device, with a check key: set up as DeviceSetup does, written straight into the fake server. */
async function setUp(as: FakeAs, g: Awaited<ReturnType<typeof gateway>>, label = 'Office Mac') {
  const { seed } = await dk.generateRecoveryCode();
  const root = await dk.deriveRootKey(seed);
  const signing = await loadOrGenerateDeviceSigningKey(g.vault);
  const reading = await loadOrGenerateKeyPair(g.vault);
  const checkKey = await g.checks!.createKey();
  const device = await dk.buildDeviceRecord({
    sign_pub: dk.b64uEncode(signing.publicKey), read_pub: dk.b64uEncode(reading.publicKey), kind: 'gateway', label, keystore: 'software', check: platformCheckKey(checkKey.publicKey),
  }, signing.publicKey);
  const entry = dk.buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: as.now() - 3600, signer: 'root', device });
  entry.sigs.push(await dk.signEntry(entry, 'root', root.privateSeed), await dk.signEntry(entry, device.key_id, signing.privateSeed));
  entry.checks.push({ by: device.key_id, check: platformCheckProof((await g.checks!.sign(checkKey, dk.entrySignedBytes(entry))).signature) });
  await as.appendDirect(entry);
  g.checkStore.write(checkKey);
  g.store.create({ v: 1, rootDid: root.did, keyId: device.key_id, head: { seq: 0, hash: await dk.entryHash(entry) }, asUrl: AS_URL, label, setUpAt: entry.created_at });
  // The device session the gateway signed in with: the credential is the whole Authorization value.
  const credential = 'Bearer tok-gateway';
  as.sessions.set(credential, device.key_id);
  g.vault.setSpCookie(credential);
  return { root, keyId: device.key_id };
}

/** Poll the gateway until its view satisfies `ok` (the page polls every few seconds). */
async function until(g: { pairing: DevicePairing }, ok: (v: PairingView) => boolean, phone?: () => Promise<void>): Promise<PairingView> {
  let v = g.pairing.view();
  for (let i = 0; i < 10 && !ok(v); i++) {
    if (phone) await phone();
    v = await g.pairing.status();
  }
  if (!ok(v)) throw new Error(`the view never got there: ${JSON.stringify(v).slice(0, 300)}`);
  return v;
}

const refusalOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'no refusal'; } catch (e) { return e instanceof PairingRefusal ? e.code : `other: ${String(e)}`; } };

describe('"Add a phone": this computer admits the phone app (shown_by: admitter)', () => {
  async function world() {
    const as = await FakeAs.create();
    const g = await gateway(as);
    const acct = await setUp(as, g);
    const rt = testRuntime(as);
    const join = new JoinDriver({ keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, now: rt.now });
    return { as, g, acct, rt, join };
  }

  it('the whole ceremony: QR, the phone scans, commit, challenge, open, three codes, the right tap, the touch, the entry is appended with the pairing id, done', async () => {
    const { as, g, acct, rt, join } = await world();
    const v0 = await g.pairing.admitStart();
    expect(v0).toMatchObject({ flow: 'admit', step: 'qr' });
    if (v0.flow !== 'admit' || v0.step !== 'qr') return;
    // The QR names this account and this computer, is shown by the admitter, carries the AS key and the head, and lives ten minutes.
    const qr = dk.decodePairingQr(v0.qr, { now: as.now() });
    expect(qr).toMatchObject({ shown_by: 'admitter', as_url: AS_URL, as_key: as.keyHex, root_did: acct.root.did, key_id: acct.keyId, head: { seq: 0 } });
    expect(qr.expires_at).toBe(as.now() + 600);
    // The mailbox is open at the Authority Server under the derived id, and holds neither the secret nor a key.
    const keys = await pairingKeysOf(qr);
    expect(as.mailboxes.has(keys.pairingId)).toBe(true);
    expect(JSON.stringify([...as.mailboxes.entries()])).not.toContain(qr.secret);

    // The phone scans, reviews, is named, commits.
    await join.scanned(v0.qr);
    expect(join.get().step).toBe('review');
    join.confirmReview();
    await join.submitName('My iPhone');
    expect(join.get().step).toBe('waiting');

    const connected = await g.pairing.status();            // commit -> challenge
    expect(connected).toMatchObject({ flow: 'admit', step: 'connected' });
    await join.poll();                                       // challenge -> open, the phone's code
    const choose = await g.pairing.status();               // open -> three codes
    expect(choose.flow === 'admit' && choose.step === 'choose').toBe(true);
    if (choose.flow !== 'admit' || choose.step !== 'choose') return;
    const compare = join.get();
    if (compare.step !== 'compare') throw new Error('phone not at compare');
    expect(choose.label).toBe('My iPhone');
    expect(choose.kind).toBe('approve-app');
    expect(choose.codes).toHaveLength(3);
    expect(new Set(choose.codes).size).toBe(3);
    expect(choose.codes).toContain(compare.code);
    expect(choose.rows.map(r => [r.label, !!r.adding])).toEqual([['Office Mac', false], ['My iPhone', true]]);
    // Nothing is in the chain until the tap and the touch.
    expect(as.entries).toHaveLength(1);

    const done = await g.pairing.admitChoose(compare.code);
    expect(done).toMatchObject({ flow: 'admit', step: 'done', label: 'My iPhone' });
    expect(as.entries).toHaveLength(2);
    const added = as.entries[1];
    // Signed by this computer and the phone, both checks present, and the whole chain verifies at the head the phone's passkey names.
    expect(added.op).toBe('add');
    expect(added.signer).toBe(acct.keyId);
    expect(added.sigs.map(s => s.by)).toEqual([acct.keyId, added.device!.key_id]);
    expect(added.checks.map(c => c.by).sort()).toEqual([acct.keyId, added.device!.key_id].sort());
    expect(added.device!.check?.type).toBe('webauthn');
    const state = await dk.verifyChain({ expectedRootDid: acct.root.did, entries: as.entries });
    // The stored head moved with the chain; the page's device list says the same.
    expect(g.store.read()!.head).toEqual(state.head);
    if (done.flow === 'admit' && done.step === 'done') expect(done.rows.map(r => r.label)).toEqual(['Office Mac', 'My iPhone']);

    // The phone is told which entry was stored, finds its own entry, and keeps the account.
    await join.poll();
    expect(join.get()).toEqual({ step: 'done' });
    expect((await rt.accounts.read())!.root_did).toBe(acct.root.did);
    // The pairing is over: the secrets are gone from what the page can read.
    const after = JSON.stringify(g.pairing.view());
    expect(after).not.toContain(qr.secret);
  });

  it('a wrong tap ends the pairing, signs nothing, adds nothing, and tells the phone', async () => {
    const { as, g, rt, join } = await world();
    const v0 = await g.pairing.admitStart();
    if (v0.flow !== 'admit' || v0.step !== 'qr') throw new Error('qr');
    await join.scanned(v0.qr); join.confirmReview(); await join.submitName('My iPhone');
    await g.pairing.status(); await join.poll();
    const choose = await g.pairing.status();
    if (choose.flow !== 'admit' || choose.step !== 'choose') throw new Error('choose');
    const real = (join.get() as { code: string }).code;
    const wrong = choose.codes.find(c => c !== real) as string;
    const spy: string[] = [];
    const orig = g.checks!.sign.bind(g.checks!);
    g.checks!.sign = async (...a) => { spy.push('touch'); return orig(...a); };
    const out = await g.pairing.admitChoose(wrong);
    expect(out).toEqual({ flow: 'admit', step: 'failed', code: 'wrong_code' });
    expect(spy).toEqual([]);                  // no touch was asked for
    expect(as.entries).toHaveLength(1);
    await join.poll();
    expect(join.get()).toMatchObject({ step: 'failed' });
    expect(await rt.accounts.read()).toBeNull();
  });

  it('a touch that does not come (cancelled) adds nothing and tells the phone', async () => {
    const { as, g, join } = await world();
    const v0 = await g.pairing.admitStart();
    if (v0.flow !== 'admit' || v0.step !== 'qr') throw new Error('qr');
    await join.scanned(v0.qr); join.confirmReview(); await join.submitName('My iPhone');
    await g.pairing.status(); await join.poll();
    await g.pairing.status();
    const code = (join.get() as { code: string }).code;
    g.checks!.sign = async () => { const { CheckError } = await import('../lib/platform-checks'); throw new CheckError('helper_failed', 'user_cancelled'); };
    expect(await g.pairing.admitChoose(code)).toEqual({ flow: 'admit', step: 'failed', code: 'cancelled' });
    expect(as.entries).toHaveLength(1);
    await join.poll();
    expect(join.get()).toMatchObject({ step: 'failed' });
  });

  it('refuses to start without a check key of its own: a computer that cannot grant admits nobody', async () => {
    const as = await FakeAs.create();
    const g = await gateway(as, { helper: false });
    // an account whose only device has no check key
    const { seed } = await dk.generateRecoveryCode();
    const root = await dk.deriveRootKey(seed);
    const signing = await loadOrGenerateDeviceSigningKey(g.vault);
    const reading = await loadOrGenerateKeyPair(g.vault);
    const device = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(signing.publicKey), read_pub: dk.b64uEncode(reading.publicKey), kind: 'gateway', label: 'Plain', keystore: 'software' }, signing.publicKey);
    const e = dk.buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: as.now() - 60, signer: 'root', device });
    e.sigs.push(await dk.signEntry(e, 'root', root.privateSeed), await dk.signEntry(e, device.key_id, signing.privateSeed));
    await as.appendDirect(e);
    g.store.create({ v: 1, rootDid: root.did, keyId: device.key_id, head: { seq: 0, hash: await dk.entryHash(e) }, asUrl: AS_URL, label: 'Plain', setUpAt: e.created_at });
    as.sessions.set('Bearer tok-gateway', device.key_id);
    g.vault.setSpCookie('Bearer tok-gateway');
    expect(await refusalOf(g.pairing.admitStart())).toBe('cannot_grant');
    expect((await g.pairing.devices()).canGrant).toBe(false);
    expect(as.mailboxes.size).toBe(0);
  });

  it('refuses without a set-up chain, without a signed-in session, and while another pairing runs', async () => {
    const as = await FakeAs.create();
    const g = await gateway(as);
    expect(await refusalOf(g.pairing.admitStart())).toBe('not_set_up');
    await setUp(as, g);
    g.vault.setSpCookie('hap-session=legacy');
    expect(await refusalOf(g.pairing.admitStart())).toBe('not_signed_in');
    g.vault.setSpCookie('Bearer tok-gateway');
    await g.pairing.admitStart();
    expect(await refusalOf(g.pairing.admitStart())).toBe('pairing_pending');
    await g.pairing.cancel();
    expect(g.pairing.view()).toEqual({ flow: 'none' });
    await g.pairing.admitStart();
  });

  it('a pairing past its ten minutes ends; a lock forgets it', async () => {
    const { as, g } = await world();
    await g.pairing.admitStart();
    as.clock += 601;
    expect(await g.pairing.status()).toEqual({ flow: 'admit', step: 'failed', code: 'qr_expired' });
    await g.pairing.cancel();
    await g.pairing.admitStart();
    g.vault.clearKey();
    expect(g.pairing.view()).toEqual({ flow: 'none' });
  });

  it('a name already in the account is refused by the phone before it makes anything', async () => {
    const { g, join } = await world();
    const v0 = await g.pairing.admitStart();
    if (v0.flow !== 'admit' || v0.step !== 'qr') throw new Error('qr');
    await join.scanned(v0.qr); join.confirmReview();
    await join.submitName('office mac');
    expect(join.get()).toMatchObject({ step: 'name', error: expect.any(String) });
  });

  it('a mailbox message with a wrong MAC ends the pairing (the server cannot forge a message)', async () => {
    const { as, g } = await world();
    const v0 = await g.pairing.admitStart();
    if (v0.flow !== 'admit' || v0.step !== 'qr') throw new Error('qr');
    const qr = dk.decodePairingQr(v0.qr, { now: as.now() });
    const keys = await pairingKeysOf(qr);
    as.mailboxes.get(keys.pairingId)!.messages.push({ kind: 'commit', body: { c: 'sha256:' + '0'.repeat(64) }, mac: dk.b64uEncode(dk.randomBytes(32)) });
    expect(await g.pairing.status()).toEqual({ flow: 'admit', step: 'failed', code: 'bad_message' });
  });

  it('the Devices list is the verified chain: rows, identity code, origin, whether this computer can grant', async () => {
    const as = await FakeAs.create();
    const g = await gateway(as);
    const acct = await setUp(as, g);
    const list = await g.pairing.devices();
    expect(list.rows.map(r => [r.label, r.thisDevice, r.canGrant])).toEqual([['Office Mac', true, true]]);
    expect(list.identityCode).toBe(await dk.identityCode(acct.root.did));
    expect(list.origin).toMatchObject({ label: 'Office Mac', kind: 'gateway' });
    expect(list.canGrant).toBe(true);
    expect(list.hasRoom).toBe(true);
  });
});

describe('"Add this computer": the phone admits this computer (shown_by: joiner)', () => {
  async function world(o: { helper?: boolean } = {}) {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    await registerPhone(rt, as, 'My iPhone');
    const opened = await rt.session.open();
    if (!opened.ok) throw new Error('session');
    const admit = new AdmitDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now });
    const g = await gateway(as, o);
    return { as, rt, admit, g };
  }

  /** Drive the ceremony to the phone's choose screen; returns the gateway's code. */
  async function toCompare(w: Awaited<ReturnType<typeof world>>, name = 'Office Mac') {
    const v0 = await w.g.pairing.joinStart();
    if (v0.flow !== 'join' || v0.step !== 'qr') throw new Error('qr');
    await w.admit.scanned(v0.qr);                                                // phone: mailbox + hello
    const review = await until(w.g, v => v.flow === 'join' && v.step === 'review');
    await w.g.pairing.joinConfirm(name);                                         // commit
    await w.admit.poll();                                                        // phone: challenge
    const compare = await until(w.g, v => v.flow === 'join' && v.step === 'compare');
    await w.admit.poll();                                                        // phone: open verified, three codes
    return { v0, review, compare };
  }

  it('the whole ceremony: QR, hello, the review of the account, commit, challenge, open, the same code on both, the phone confirms, the chain is stored, signed in', async () => {
    const w = await world();
    const { as, rt, admit, g } = w;
    const { v0, review, compare } = await toCompare(w);
    // The QR: shown by a joiner, nothing of an account in it, this computer's trusted AS key.
    const qr = dk.decodePairingQr(v0.flow === 'join' && v0.step === 'qr' ? v0.qr : '', { now: as.now() });
    expect(qr).toMatchObject({ shown_by: 'joiner', as_key: as.keyHex, root_did: null, head: null, key_id: null });
    // The review (DEC-47: "says so once"): the identity code, where it was made, every device, who admits. Before anything was made.
    if (review.flow !== 'join' || review.step !== 'review') return;
    expect(review.identityCode).toBe(await dk.identityCode(as.rootDid));
    expect(review.origin).toMatchObject({ label: 'My iPhone', kind: 'approve-app' });
    expect(review.devices.map(d => d.label)).toEqual(['My iPhone']);
    expect(review.admitterLabel).toBe('My iPhone');
    expect(review.suggestedLabel).toBe('This computer');
    expect(review.canGrant).toBe(true);   // the fake helper has Touch ID: this computer brings a check key

    // The phone's three codes include the one this computer shows.
    const st = admit.get();
    if (st.step !== 'choose' || compare.flow !== 'join' || compare.step !== 'compare') throw new Error('not at the codes');
    expect(st.choice.codes).toHaveLength(3);
    expect(st.choice.codes).toContain(compare.code);
    expect(st.choice.label).toBe('Office Mac');
    expect(st.choice.kind).toBe('gateway');
    // Nothing is stored here and nothing is in the chain until the phone confirms.
    expect(g.store.exists()).toBe(false);
    expect(as.entries).toHaveLength(1);

    await admit.choose(compare.code);
    expect(admit.get().step).toBe('done');
    expect(as.entries).toHaveLength(2);
    const done = await until(g, v => v.flow === 'join' && v.step === 'done');
    expect(done).toEqual({ flow: 'join', step: 'done', signedIn: true });

    // The chain is stored with this computer's own key, a check key the chain names, and the head of the entry; it signed in.
    const stored = g.store.read()!;
    expect(stored).toMatchObject({ rootDid: as.rootDid, label: 'Office Mac', asUrl: AS_URL, head: { seq: 1 } });
    const state = await dk.verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
    expect(state.head.hash).toBe(stored.head.hash);
    const me = state.devices[stored.keyId];
    expect(me).toMatchObject({ kind: 'gateway', label: 'Office Mac', removed_seq: null });
    expect(me.check?.type).toBe('platform');
    expect(g.checkStore.read()?.publicKey).toBe((me.check as { pub: string }).pub);
    expect(g.signIns).toEqual([{ probe: false }]);
    // the entry carries this computer's own check and the phone's, and the phone signed as admitter
    const added = as.entries[1];
    expect(added.signer).toBe((await rt.accounts.read())!.key_id);
    expect(added.checks).toHaveLength(2);
    // no secret is left in what the page reads
    expect(JSON.stringify(g.pairing.view())).not.toContain(qr.secret);
  });

  it('a computer without Touch ID joins as a device that approves and does not grant', async () => {
    const w = await world({ helper: false });
    const { as, admit, g } = w;
    const { compare } = await toCompare(w);
    if (compare.flow !== 'join' || compare.step !== 'compare') throw new Error('compare');
    await admit.choose(compare.code);
    await until(g, v => v.flow === 'join' && v.step === 'done');
    const state = await as.state();
    expect(state.devices[g.store.read()!.keyId].check).toBeNull();
    expect(g.checkStore.has()).toBe(false);
  });

  it('a wrong tap on the phone adds nothing, stores nothing, and the computer says so', async () => {
    const w = await world();
    const { as, admit, g } = w;
    const { compare } = await toCompare(w);
    const st = admit.get();
    if (st.step !== 'choose' || compare.flow !== 'join' || compare.step !== 'compare') throw new Error('choose');
    await admit.choose(st.choice.codes.find(c => c !== compare.code) as string);
    const v = await until(g, x => x.flow === 'join' && x.step === 'failed');
    expect(v).toEqual({ flow: 'join', step: 'failed', code: 'wrong_code' });
    expect(as.entries).toHaveLength(1);
    expect(g.store.exists()).toBe(false);
    expect(g.checkStore.has()).toBe(false);
  });

  it('a name that is taken in the account is refused on the review, and the person can choose another', async () => {
    const w = await world();
    const { g, admit } = w;
    const v0 = await g.pairing.joinStart();
    if (v0.flow !== 'join' || v0.step !== 'qr') throw new Error('qr');
    await admit.scanned(v0.qr);
    await until(g, v => v.flow === 'join' && v.step === 'review');
    const taken = await g.pairing.joinConfirm('my iphone');
    expect(taken).toMatchObject({ flow: 'join', step: 'review', error: 'label_taken' });
    const bad = await g.pairing.joinConfirm('   ');
    expect(bad).toMatchObject({ step: 'review', error: 'label_invalid' });
    const ok = await g.pairing.joinConfirm('Office Mac');
    expect(ok).toMatchObject({ flow: 'join', step: 'waiting' });
  });

  it('a phone that pinned another Authority Server key is refused (hello names an AS key this computer does not trust)', async () => {
    const as = await FakeAs.create();
    const g = await gateway(as);
    const v0 = await g.pairing.joinStart();
    if (v0.flow !== 'join' || v0.step !== 'qr') throw new Error('qr');
    const qr = dk.decodePairingQr(v0.qr, { now: as.now() });
    const keys = await pairingKeysOf(qr);
    const box = new Mailbox(new AsApi(as), keys);
    // an account whose chain the "phone" shows; the AS key in hello is not the one this computer trusts
    const rt = testRuntime(as);
    await registerPhone(rt, as, 'My iPhone');
    as.mailboxes.set(keys.pairingId, { messages: [] });
    const acc = (await rt.accounts.read())!;
    await box.send('hello', { root_did: as.rootDid, head: (await as.state()).head, key_id: acc.key_id, as_key: 'ab'.repeat(32) });
    expect(await g.pairing.status()).toEqual({ flow: 'join', step: 'failed', code: 'as_key_mismatch' });
  });

  it('refuses on a computer that already has a chain, with a lock, with no password, and beside another pairing', async () => {
    const as = await FakeAs.create();
    const g = await gateway(as);
    await setUp(as, g);
    expect(await refusalOf(g.pairing.joinStart())).toBe('already_set_up');
    const as2 = await FakeAs.create();
    const g2 = await gateway(as2);
    await g2.pairing.joinStart();
    expect(await refusalOf(g2.pairing.joinStart())).toBe('pairing_pending');
    await g2.pairing.cancel();
    g2.vault.clearKey();
    expect(await refusalOf(g2.pairing.joinStart())).toBe('locked');
  });

  it('plan 20.2: a computer signed in to another account refuses this chain; to its own account it joins; a new computer joins any', async () => {
    // another account: refused before the person sees anything, nothing stored
    const other = await world();
    other.g.vault.setSessionUser({ id: 'u9', did: 'did:key:z6MkSomeoneElse' });
    const v0 = await other.g.pairing.joinStart();
    if (v0.flow !== 'join' || v0.step !== 'qr') throw new Error('qr');
    await other.admit.scanned(v0.qr);
    expect(await until(other.g, v => v.flow === 'join' && v.step === 'failed')).toEqual({ flow: 'join', step: 'failed', code: 'other_account' });
    expect(other.g.store.exists()).toBe(false);
    // its own account: joins
    const own = await world();
    own.g.vault.setSessionUser({ id: 'u1', did: own.as.rootDid });
    const { compare } = await toCompare(own);
    if (compare.flow !== 'join' || compare.step !== 'compare') throw new Error('compare');
    await own.admit.choose(compare.code);
    expect(await until(own.g, v => v.flow === 'join' && v.step === 'done')).toMatchObject({ step: 'done', signedIn: true });
    expect(own.g.store.read()?.rootDid).toBe(own.as.rootDid);
    // a new computer (no session, no logins) joins: every other test of this block
  });

  it('plan 20.2: stored connector logins and no signed-in account: sign in first, nothing is shown', async () => {
    const w = await world();
    w.g.vault.setCredential('gmail', { token: 'x' });
    expect(await refusalOf(w.g.pairing.joinStart())).toBe('sign_in_first');
    expect(w.g.pairing.view()).toEqual({ flow: 'none' });
    w.g.vault.setSessionUser({ id: 'u1', did: w.as.rootDid });
    expect((await w.g.pairing.joinStart()).flow).toBe('join');
  });

  it('a lost done: the mailbox runs out after the phone appended; a sign-in that finds this computer\'s entry stores the chain, and one that does not stores nothing', async () => {
    for (const found of [true, false]) {
      const w = await world();
      const { as, admit, g } = w;
      const { v0, compare } = await toCompare(w);
      if (v0.flow !== 'join' || v0.step !== 'qr' || compare.flow !== 'join' || compare.step !== 'compare') throw new Error('compare');
      await admit.choose(compare.code);
      expect(as.entries).toHaveLength(2);
      // the phone's done never reaches this computer, and the mailbox is gone
      as.mailboxes.clear();
      g.probe.ok = found;
      as.clock += 700;
      const v = await g.pairing.status();
      if (found) {
        expect(v).toEqual({ flow: 'join', step: 'done', signedIn: true });
        expect(g.store.read()?.head.seq).toBe(1);
        expect(g.signIns[0]).toEqual({ probe: true });
      } else {
        expect(v).toEqual({ flow: 'join', step: 'failed', code: 'qr_expired' });
        expect(g.store.exists()).toBe(false);
        expect(g.checkStore.has()).toBe(false);
      }
    }
  });

  it('a done that names another entry than the one this computer built stores nothing', async () => {
    const w = await world();
    const { as, g } = w;
    const { v0 } = await toCompare(w);
    if (v0.flow !== 'join' || v0.step !== 'qr') return;
    const keys = await pairingKeysOf(dk.decodePairingQr(v0.qr, { now: as.now() }));
    const box = new Mailbox(new AsApi(as), keys);
    await box.send('done', { entry_hash: 'sha256:' + 'a'.repeat(64) });
    expect(await g.pairing.status()).toEqual({ flow: 'join', step: 'failed', code: 'head_mismatch' });
    expect(g.store.exists()).toBe(false);
  });
});

describe('the codes', () => {
  it('every code the source can say is in PAIRING_CODES (the page\'s texts are held to that list)', async () => {
    const { readFileSync } = await import('node:fs');
    const { PAIRING_CODES } = await import('../lib/device-pairing');
    const src = readFileSync(fileURLToPath(new URL('../lib/device-pairing.ts', import.meta.url)), 'utf8');
    const said = new Set<string>();
    for (const m of src.matchAll(/refuse\(\d+, '([a-z_]+)'/g)) said.add(m[1]);
    for (const m of src.matchAll(/(?:this\.fail|this\.stop)\((?:h|this\.h), '([a-z_]+)'/g)) said.add(m[1]);
    for (const m of src.matchAll(/return '([a-z_]+)';/g)) said.add(m[1]);
    for (const m of src.matchAll(/\? '([a-z_]+)' :/g)) said.add(m[1]);
    for (const code of said) expect(PAIRING_CODES as readonly string[], code).toContain(code);
    expect(said.size).toBeGreaterThan(25);
  });
});
