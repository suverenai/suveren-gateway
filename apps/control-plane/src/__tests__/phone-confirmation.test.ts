/**
 * A change to a connector login confirmed on the person's phone (device-keys plan 7 phone path, 20.4, 20.13; stage D3): this
 * computer's `ChangeConfirmations` + `PhoneConfirmations` against the phone app's OWN reader and driver (apps/approve
 * `ChangeRequestReader`, `ChangeConfirmDriver`), through the phone's fake Authority Server (`FakeAs`, which carries the request and
 * the answer with the real server's rules). Two implementations that share only the formats in `@suveren/pairing` meet here: real
 * keys, real signatures, a real passkey-shaped check, real chain verification, a real vault and chain store.
 *
 * Covered: the whole path; what the phone is shown (never a secret, old values of `text` fields); the change runs once, only for the
 * exact change, only from the session that asked; deny; a request run out; an Authority Server that changes the ciphertext, swaps the
 * envelope, or hands one request's answer to another; another account's phone; a computer with its own check key; the switch's
 * other paths unchanged (the password still confirms where the phone is not used).
 *
 * Not covered here: the real Authority Server (suveren-e2e), a real phone's Face ID, the page's screens in a browser.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dk from '@hap/core/device-keys';
import { Vault } from '../lib/vault';
import { DeviceChainStore } from '../lib/device-chain-store';
import { DevicePinStore } from '../lib/device-pin-store';
import { DeviceReaders } from '../lib/device-readers';
import { loadOrGenerateDeviceSigningKey, loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import { ChangeConfirmations } from '../lib/change-confirmation';
import { describeChange } from '../lib/change-describe';
import { PhoneConfirmations, PhoneConfirmRefusal } from '../lib/phone-confirmation';
import { FakeAs, PeerComputer, addWithRoot, registerPhone, testRuntime, AS_URL, type TestRuntime } from '../../../approve/src/lib/test-kit';
import { ChangeConfirmDriver, ChangeRequestReader, type ChangeItem } from '../../../approve/src/lib/change-requests';
import { buildConfirmation } from '@suveren/pairing';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 }, deviceKeys: true };
const PW = 'correct horse battery';
const SESSION = 'page-session-1';

const MANIFESTS = [{
  id: 'gmail', name: 'Gmail',
  credentials: { fields: [{ key: 'clientId', type: 'text', label: 'Client ID' }, { key: 'clientSecret', type: 'password', label: 'Client secret' }] },
}];
const STORED: Record<string, Record<string, string>> = { gmail: { clientId: 'old.apps.example', clientSecret: 'old-secret-123' } };
const CHANGE = { route: 'credentials', op: 'put-merge', fields: { clientId: 'new.apps.example', clientSecret: 'new-secret-456' } };

/** The person: a phone (with its passkey) that made the identity, and this computer, added root-signed, WITHOUT a check key. */
async function world(o: { withCheckKey?: boolean } = {}) {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  const { recoveryCode } = await registerPhone(rt, as, 'My iPhone');
  const root = await dk.rootKeyFromRecoveryCode(recoveryCode);

  const dir = mkdtempSync(join(tmpdir(), 'phone-confirm-'));
  const vault = new Vault(dir, FAST);
  await vault.createWithPassword(PW, 'u1');
  const store = new DeviceChainStore(vault);
  const signing = await loadOrGenerateDeviceSigningKey(vault);
  const reading = await loadOrGenerateKeyPair(vault);
  const device = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(signing.publicKey), read_pub: dk.b64uEncode(reading.publicKey), kind: 'gateway', label: 'Home Mac', keystore: 'software' }, signing.publicKey);
  const state0 = await as.state();
  const entry = dk.buildEntry({ root_did: root.did, seq: state0.head.seq + 1, prev: state0.head.hash, op: 'add', created_at: as.now() - 60, signer: 'root', device });
  entry.sigs.push(await dk.signEntry(entry, 'root', root.privateSeed), await dk.signEntry(entry, device.key_id, signing.privateSeed));
  await as.appendDirect(entry);
  store.create({ v: 1, rootDid: root.did, keyId: device.key_id, head: { seq: entry.seq, hash: await dk.entryHash(entry) }, asUrl: AS_URL, label: 'Home Mac', setUpAt: entry.created_at });
  const credential = 'Bearer tok-home-mac';
  as.sessions.set(credential, device.key_id);
  vault.setSpCookie(credential);

  // The phone opens its session (its touch) and reads the chain that now holds the computer.
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error(`phone session: ${opened.code}`);

  const client = { asUrl: AS_URL, call: (m: string, p: string, opts?: { body?: unknown; bearer?: string }) => as.call(m as never, p, opts as never) };
  const pins = new DevicePinStore(vault, store);
  const readers = new DeviceReaders({ vault, store, client: client as never, pins });
  const confirmations = new ChangeConfirmations({
    now: () => as.clock * 1000,
    describe: (kind, name, change) => describeChange(kind, name, change, MANIFESTS, (n) => STORED[n] ?? null),
  });
  const phone = new PhoneConfirmations({ vault, store, client: client as never, readers, confirmations, hasCheckKey: () => o.withCheckKey === true, now: as.now });
  return { as, rt, root, vault, store, confirmations, phone, readers, readPub: reading.publicKey, keyId: device.key_id };
}
type World = Awaited<ReturnType<typeof world>>;

const reader = (rt: TestRuntime) => new ChangeRequestReader({ keys: rt.keys, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now });
const driverFor = (rt: TestRuntime, item: ChangeItem) => new ChangeConfirmDriver({ keys: rt.keys, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now, check: rt.check }, item);
const refusalOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'no refusal'; } catch (e) { return e instanceof PhoneConfirmRefusal ? e.code : `other: ${String(e)}`; } };

async function sendOne(w: World, change: unknown = CHANGE, kind: 'replace' | 'remove' = 'replace') {
  const req = w.confirmations.request(SESSION, kind, 'gmail', change);
  const sent = await w.phone.send(SESSION, req.request_id);
  return { req, sent };
}

async function phoneItems(w: World): Promise<ChangeItem[]> {
  const r = await reader(w.rt).list();
  if (!r.ok) throw new Error(`phone list: ${r.code}`);
  return r.items;
}

describe('the whole path', () => {
  it('the computer sends, the phone shows and confirms with its touch, the computer verifies and the change runs once', async () => {
    const w = await world();
    const { req, sent } = await sendOne(w);
    expect(sent.phones).toEqual(['My iPhone']);
    // 15 minutes on the phone path (20.13), not 300 seconds.
    expect(sent.expiresAt - w.as.clock * 1000).toBe(15 * 60_000);
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('waiting');

    const items = await phoneItems(w);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.gatewayLabel).toBe('Home Mac');
    expect(item.view.connector).toBe('Gmail');
    expect(item.view.request).toMatchObject({ request_id: req.request_id, kind: 'replace', name: 'gmail', change_hash: req.change_hash, gateway_key_id: w.keyId });
    // What the phone is shown: the text field old -> new; the secret field named, never its value.
    expect(item.view.fields).toEqual([
      { key: 'clientId', label: 'Client ID', secret: false, old: 'old.apps.example', new: 'new.apps.example' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ]);

    const d = driverFor(w.rt, item);
    await d.confirm();
    expect(d.get()).toEqual({ step: 'confirmed' });
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('confirmed');
    // The change itself: once, for exactly this change, from the session that asked.
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(true);
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('a confirmation is for the exact change and the session that asked only', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    await driverFor(w.rt, (await phoneItems(w))[0]).confirm();
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('confirmed');
    const other = { ...CHANGE, fields: { ...CHANGE.fields, clientSecret: 'attacker-secret' } };
    // Another change with the same request id: refused, and the request is spent.
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', other)).toBe(false);
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
    // Another session cannot poll or use it.
    const { req: r2 } = await sendOne(w);
    expect(await refusalOf(w.phone.poll('another-session', r2.request_id))).toBe('request_unknown');
    await driverFor(w.rt, (await phoneItems(w)).find((i) => i.requestId === r2.request_id)!).confirm();
    expect(await w.phone.poll(SESSION, r2.request_id)).toBe('confirmed');
    expect(w.confirmations.consume('another-session', r2.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('nothing of a secret reaches the Authority Server', async () => {
    const w = await world();
    await sendOne(w);
    const wire = JSON.stringify([...w.as.confirmations.values()]);
    for (const secret of ['new-secret-456', 'old-secret-123', 'new.apps.example', 'old.apps.example', 'Client secret']) expect(wire).not.toContain(secret);
  });

  it('a removal names no field and says the AI can no longer use the connector', async () => {
    const w = await world();
    const { req } = await sendOne(w, { route: 'credentials', op: 'delete' }, 'remove');
    const item = (await phoneItems(w))[0];
    expect(item.view.request.kind).toBe('remove');
    expect(item.view.fields).toEqual([]);
    await driverFor(w.rt, item).confirm();
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('confirmed');
    expect(w.confirmations.consume(SESSION, req.request_id, 'remove', 'gmail', { route: 'credentials', op: 'delete' })).toBe(true);
  });
});

describe('refusals', () => {
  it('"Do not allow" on the phone: the computer says denied and nothing can use the request', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    const d = driverFor(w.rt, (await phoneItems(w))[0]);
    await d.deny();
    expect(d.get()).toEqual({ step: 'denied' });
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('denied');
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('a request that ran out: the phone says so, the computer says expired', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    const item = (await phoneItems(w))[0];
    w.as.clock += 15 * 60 + 1;
    const d = driverFor(w.rt, item);
    await d.confirm();
    expect(d.get()).toEqual({ step: 'expired' });
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('expired');
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('the Authority Server changes the ciphertext, or swaps the envelope: the phone never shows it', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    const row = w.as.confirmations.get(req.request_id)!;
    const bytes = Buffer.from(row.ciphertext, 'base64url');
    bytes[bytes.length - 3] ^= 1;
    row.ciphertext = bytes.toString('base64url');
    expect(await phoneItems(w)).toEqual([]);

    const { req: r2 } = await sendOne(w);
    const row2 = w.as.confirmations.get(r2.request_id)!;
    row2.envelope = { ...row2.envelope, content_hash: `sha256:${'0'.repeat(64)}` };
    expect(await phoneItems(w)).toEqual([]);
  });

  it('an answer for one request handed to another by the Authority Server is invalid on the computer', async () => {
    const w = await world();
    const a = await sendOne(w);
    const b = await sendOne(w, { ...CHANGE, fields: { clientSecret: 'other-secret' } });
    const itemA = (await phoneItems(w)).find((i) => i.requestId === a.req.request_id)!;
    await driverFor(w.rt, itemA).confirm();
    // The server copies A's answer onto B.
    w.as.confirmations.get(b.req.request_id)!.answer = w.as.confirmations.get(a.req.request_id)!.answer;
    expect(await w.phone.poll(SESSION, b.req.request_id)).toBe('invalid');
    expect(w.confirmations.consume(SESSION, b.req.request_id, 'replace', 'gmail', { ...CHANGE, fields: { clientSecret: 'other-secret' } })).toBe(false);
    // A is unaffected.
    expect(await w.phone.poll(SESSION, a.req.request_id)).toBe('confirmed');
  });

  it('an answer signed by another account\'s phone, or by this computer\'s chain naming the wrong identity, is invalid', async () => {
    const w = await world();
    const other = await world();
    const { req } = await sendOne(w);
    // Another account's phone signs, with its real key and its real touch, an answer naming THIS request and THIS identity.
    const acct = (await other.rt.accounts.read())!;
    const s = other.rt.session.current()!;
    const c = buildConfirmation({
      root_did: (await w.rt.accounts.read())!.root_did, key_id: acct.key_id, chain_seq: s.chain.head.seq, chain_head: s.chain.head.hash,
      request_id: req.request_id, change_hash: req.change_hash, gateway_key_id: w.keyId, decision: 'allow', confirmed_at: w.as.now(),
    });
    const sig = dk.b64uEncode(await other.rt.keys.sign(dk.signedBytes(c)));
    const check = await other.rt.check.prove(acct.check.cred_id, await dk.objectHash(c));
    // A dishonest server stores it as the answer.
    w.as.confirmations.get(req.request_id)!.answer = { confirmation: c, sig, check };
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('invalid');
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('a computer with its own check key never uses the phone (DEC-47)', async () => {
    const w = await world({ withCheckKey: true });
    const req = w.confirmations.request(SESSION, 'replace', 'gmail', CHANGE);
    expect(await refusalOf(w.phone.send(SESSION, req.request_id))).toBe('check_key_required');
    expect(w.as.confirmations.size).toBe(0);
  });

  it('a request of another session, or none, is not sent', async () => {
    const w = await world();
    const req = w.confirmations.request(SESSION, 'replace', 'gmail', CHANGE);
    expect(await refusalOf(w.phone.send('another-session', req.request_id))).toBe('request_unknown');
    expect(await refusalOf(w.phone.send(SESSION, 'AAAAAAAAAAAAAAAAAAAAAA'))).toBe('request_unknown');
    expect(w.as.confirmations.size).toBe(0);
  });

  it('cancel on the page withdraws it: the phone no longer shows it, and it cannot be confirmed', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    const item = (await phoneItems(w))[0];
    await w.phone.cancel(SESSION, req.request_id);
    expect(await phoneItems(w)).toEqual([]);
    const d = driverFor(w.rt, item);
    await d.confirm();
    expect(d.get()).toEqual({ step: 'expired' });
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('the password path is unchanged where the phone is not used', async () => {
    const w = await world();
    const req = w.confirmations.request(SESSION, 'replace', 'gmail', CHANGE);
    expect(w.confirmations.confirm(SESSION, req.request_id, 'password')).toBe(true);
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(true);
  });
});

describe('independent review fixes', () => {
  it('L1: the own head moves forward after a verified read; an older chain served later is a rollback, nothing is sent', async () => {
    const w = await world();
    await addWithRoot(w.as, w.root, await PeerComputer.create('Spare Mac', false));
    const fresh = await w.as.state();
    await w.readers.own(w.readPub);
    expect(w.store.read()!.head).toEqual(fresh.head);
    // The server hides the newest entry again.
    w.as.entries.pop();
    const req = w.confirmations.request(SESSION, 'replace', 'gmail', CHANGE);
    expect(await refusalOf(w.phone.send(SESSION, req.request_id))).toBe('own_chain_unusable');
    expect(w.as.confirmations.size).toBe(0);
  });

  it('L3: a request the server refused keeps its 300 seconds (the password after it too), and the page is told the phone could not be reached', async () => {
    const w = await world();
    const req = w.confirmations.request(SESSION, 'replace', 'gmail', CHANGE);
    // The server refuses it (the id is taken there).
    w.as.confirmations.set(req.request_id, { request_id: req.request_id, gateway_key_id: 'x', device_keys: {}, created_at: w.as.now(), expires_at: w.as.now() + 900, answer: null });
    expect(await refusalOf(w.phone.send(SESSION, req.request_id))).toBe('phone_unreachable');
    w.as.clock += 301;
    expect(w.confirmations.confirm(SESSION, req.request_id, 'password')).toBe(false);
    expect(w.confirmations.consume(SESSION, req.request_id, 'replace', 'gmail', CHANGE)).toBe(false);
  });

  it('L3: a request the server took lives 15 minutes', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    w.as.clock += 600;
    await driverFor(w.rt, (await phoneItems(w))[0]).confirm();
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('confirmed');
  });

  it('L4: once the computer has read the answer, the row is gone at the server (confirmed and denied)', async () => {
    const w = await world();
    const a = await sendOne(w);
    await driverFor(w.rt, (await phoneItems(w))[0]).confirm();
    expect(await w.phone.poll(SESSION, a.req.request_id)).toBe('confirmed');
    expect(w.as.confirmations.has(a.req.request_id)).toBe(false);
    const b = await sendOne(w);
    await driverFor(w.rt, (await phoneItems(w))[0]).deny();
    expect(await w.phone.poll(SESSION, b.req.request_id)).toBe('denied');
    expect(w.as.confirmations.has(b.req.request_id)).toBe(false);
  });

  it('L5: a change the phone could not be shown in full is never sent to the phone', async () => {
    const w = await world();
    const req = w.confirmations.request(SESSION, 'replace', 'gmail', { route: 'credentials', op: 'put-merge', fields: { clientId: 'x'.repeat(600) } });
    expect(await refusalOf(w.phone.send(SESSION, req.request_id))).toBe('change_not_describable');
    expect(w.as.confirmations.size).toBe(0);
  });
});

describe('the phone\'s touch', () => {
  it('Cancel while the touch is asked sends nothing; the request stays and can be confirmed after', async () => {
    const w = await world();
    const { req } = await sendOne(w);
    const item = (await phoneItems(w))[0];
    const passkeys = w.rt.check as unknown as { gate: Promise<void> | null };
    let open!: () => void;
    passkeys.gate = new Promise((r) => { open = r; });
    const d = driverFor(w.rt, item);
    const p = d.confirm();
    await new Promise((r) => setTimeout(r, 10));
    expect(d.get().step).toBe('touch');
    d.cancelTouch();
    open();
    passkeys.gate = null;
    await p;
    expect(d.get()).toEqual({ step: 'idle' });
    expect(w.as.confirmations.get(req.request_id)!.answer).toBeNull();
    await d.confirm();
    expect(await w.phone.poll(SESSION, req.request_id)).toBe('confirmed');
  });
});
