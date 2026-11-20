/**
 * The change-confirmation formats and both ends' checks (plan 7 phone path, 20.4), against real hap-core chains, real Ed25519
 * device keys and a real P-256 check key. Every refusal the plan names is a test: wrong hash, another chain's device, a removed
 * device, an expired request, a replayed answer for another request, an envelope or view the Authority Server changed.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  b64uEncode, buildDeviceRecord, buildEntry, deriveRootKey, ecdsaRawToDer, ed25519PublicKey, entryHash, generateRecoveryCode,
  objectHash, randomBytes, signEntry, signObject, verifyChain, type ChainEntry, type ChainState, type CheckKey,
} from '@hap/core/device-keys';
import {
  ChangeCheckError, buildConfirmation, buildEnvelope, openView, sealView, verifyAnswer, verifyRequest,
  type ChangeView,
} from './change-confirmation';

const NOW = 1_800_000_000;

async function checkKey(): Promise<{ check: CheckKey; priv: webcrypto.CryptoKey }> {
  const kp = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  return { check: { type: 'platform', pub: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))) }, priv: kp.privateKey };
}

async function proofOver(priv: webcrypto.CryptoKey, hash: string) {
  const digest = Buffer.from(hash.slice('sha256:'.length), 'hex');
  const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, digest));
  return { signature: b64uEncode(ecdsaRawToDer(raw)) };
}

async function dev(kind: 'gateway' | 'approve-app', label: string, withCheck: boolean) {
  const seed = randomBytes(32);
  const pub = await ed25519PublicKey(seed);
  const c = withCheck ? await checkKey() : null;
  const record = await buildDeviceRecord({ sign_pub: b64uEncode(pub), read_pub: b64uEncode(randomBytes(32)), kind, label, keystore: 'software', ...(c ? { check: c.check } : {}) }, pub);
  return { seed, record, checkPriv: c?.priv ?? null };
}
type Dev = Awaited<ReturnType<typeof dev>>;

/** A computer without a check key (genesis) and a phone with one, added root-signed. Optionally a second phone, later removed. */
async function account(o: { removePhone?: boolean } = {}) {
  const { seed } = await generateRecoveryCode();
  const root = await deriveRootKey(seed);
  const gw = await dev('gateway', 'Home Mac', false);
  const phone = await dev('approve-app', 'My iPhone', true);
  const e0 = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: NOW - 300, signer: 'root', device: gw.record });
  e0.sigs.push(await signEntry(e0, 'root', root.privateSeed), await signEntry(e0, gw.record.key_id, gw.seed));
  const e1 = buildEntry({ root_did: root.did, seq: 1, prev: await entryHash(e0), op: 'add', created_at: NOW - 200, signer: 'root', device: phone.record });
  e1.sigs.push(await signEntry(e1, 'root', root.privateSeed), await signEntry(e1, phone.record.key_id, phone.seed));
  e1.checks = [{ by: phone.record.key_id, check: await proofOver(phone.checkPriv!, await entryHash(e1)) }];
  const entries: ChainEntry[] = [e0, e1];
  if (o.removePhone) {
    // A second phone first: the last device that confirms changes cannot be removed (NO_GRANTING_DEVICE).
    const spare = await dev('approve-app', 'Spare phone', true);
    const e2 = buildEntry({ root_did: root.did, seq: 2, prev: await entryHash(e1), op: 'add', created_at: NOW - 150, signer: 'root', device: spare.record });
    e2.sigs.push(await signEntry(e2, 'root', root.privateSeed), await signEntry(e2, spare.record.key_id, spare.seed));
    e2.checks = [{ by: spare.record.key_id, check: await proofOver(spare.checkPriv!, await entryHash(e2)) }];
    const e3 = buildEntry({ root_did: root.did, seq: 3, prev: await entryHash(e2), op: 'remove', created_at: NOW - 100, signer: 'root', target: phone.record.key_id });
    e3.sigs.push(await signEntry(e3, 'root', root.privateSeed));
    entries.push(e2, e3);
  }
  const chain = await verifyChain({ expectedRootDid: root.did, entries });
  return { root, gw, phone, entries, chain };
}
type Account = Awaited<ReturnType<typeof account>>;

const RID = b64uEncode(randomBytes(16));
const HASH = 'c'.repeat(64);

function view(a: Account, over: Partial<ChangeView['request']> = {}): ChangeView {
  return {
    typ: 'suveren-change-request', v: 1,
    request: { request_id: RID, kind: 'replace', name: 'gmail', change_hash: HASH, gateway_key_id: a.gw.record.key_id, expires_at: NOW + 900, ...over },
    connector: 'Gmail',
    fields: [{ key: 'clientId', label: 'Client ID', secret: false, old: 'a.apps', new: 'b.apps' }, { key: 'clientSecret', secret: true }],
    issued_at: NOW,
  };
}

async function signedRequest(a: Account, v: ChangeView, signer: Dev = a.gw, chain: ChainState = a.chain) {
  const env = buildEnvelope({ gateway_key_id: signer.record.key_id, chain_seq: chain.head.seq, chain_head: chain.head.hash, content_hash: await objectHash(v), issued_at: NOW });
  return { envelope: env, senderSig: await signObject(env, signer.seed) };
}

async function answerBy(a: Account, d: Dev, over: Record<string, unknown> = {}, chain: ChainState = a.chain) {
  const c = buildConfirmation({
    root_did: a.root.did, key_id: d.record.key_id, chain_seq: chain.head.seq, chain_head: chain.head.hash, request_id: RID, change_hash: HASH,
    gateway_key_id: a.gw.record.key_id, decision: 'allow', confirmed_at: NOW, ...over,
  } as Parameters<typeof buildConfirmation>[0]);
  const sig = await signObject(c, d.seed);
  const check = d.checkPriv ? await proofOver(d.checkPriv, await objectHash(c)) : undefined;
  return { confirmation: c, sig, ...(check ? { check } : {}) };
}

const expectOf = (a: Account) => ({ rootDid: a.root.did, requestId: RID, changeHash: HASH, gatewayKeyId: a.gw.record.key_id, createdAt: NOW - 10, expiresAt: NOW + 900 });
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'accepted'; } catch (e) { return e instanceof ChangeCheckError ? e.code : `other ${String(e)}`; } };

describe('sealing', () => {
  it('opens for the request it was sealed for, and only for it', async () => {
    const a = await account();
    const cek = randomBytes(32);
    const ct = await sealView(view(a), cek);
    expect((await openView(cek, ct, RID)).connector).toBe('Gmail');
    expect(await codeOf(openView(cek, ct, b64uEncode(randomBytes(16))))).toBe('unreadable');
    expect(await codeOf(openView(randomBytes(32), ct, RID))).toBe('unreadable');
    // one byte changed by the Authority Server
    const bytes = Buffer.from(ct, 'base64url');
    bytes[20] ^= 1;
    expect(await codeOf(openView(cek, bytes.toString('base64url'), RID))).toBe('unreadable');
  });

  it('never seals a value for a secret field, nor fields for a removal', async () => {
    const a = await account();
    const v = view(a);
    v.fields[1] = { key: 'clientSecret', secret: true, new: 'shh' };
    expect(await codeOf(sealView(v, randomBytes(32)))).toBe('malformed');
    expect(await codeOf(sealView({ ...view(a, { kind: 'remove' }) }, randomBytes(32)))).toBe('malformed');
  });
});

describe('the phone checks a request (20.4)', () => {
  it('accepts a request signed by an active gateway of the chain, and names it', async () => {
    const a = await account();
    const v = view(a);
    const r = await signedRequest(a, v);
    const got = await verifyRequest({ requestId: RID, view: v, ...r }, { chain: a.chain, now: NOW });
    expect(got.gatewayLabel).toBe('Home Mac');
  });

  it('refuses an unsigned or re-signed envelope, a signer that is not a gateway, a changed view, another request, an expired one', async () => {
    const a = await account();
    const v = view(a);
    const r = await signedRequest(a, v);
    expect(await codeOf(verifyRequest({ requestId: RID, view: v, envelope: r.envelope, senderSig: undefined }, { chain: a.chain, now: NOW }))).toBe('bad_signature');
    // a phone of the chain signs the envelope while naming itself: not a gateway
    const byPhone = await signedRequest(a, v, a.phone);
    expect(await codeOf(verifyRequest({ requestId: RID, view: v, ...byPhone }, { chain: a.chain, now: NOW }))).toBe('not_a_gateway');
    // another account's gateway
    const b = await account();
    const foreign = await signedRequest(b, v, b.gw);
    expect(await codeOf(verifyRequest({ requestId: RID, view: v, ...foreign }, { chain: a.chain, now: NOW }))).toBe('not_a_gateway');
    // the view the phone opened is not the one signed (the AS swapped the ciphertext for another sealed view)
    const other = { ...v, connector: 'Mollie' };
    expect(await codeOf(verifyRequest({ requestId: RID, view: other, ...r }, { chain: a.chain, now: NOW }))).toBe('content_mismatch');
    expect(await codeOf(verifyRequest({ requestId: b64uEncode(randomBytes(16)), view: v, ...r }, { chain: a.chain, now: NOW }))).toBe('wrong_request');
    expect(await codeOf(verifyRequest({ requestId: RID, view: v, ...r }, { chain: a.chain, now: NOW + 901 }))).toBe('expired');
  });
});

describe('the gateway checks an answer (plan 7)', () => {
  it('accepts an allow from an active granting phone of its own chain', async () => {
    const a = await account();
    const c = await verifyAnswer(await answerBy(a, a.phone), { chain: a.chain, expect: expectOf(a), now: NOW + 5 });
    expect(c.decision).toBe('allow');
  });

  it('a deny verifies by its signature alone', async () => {
    const a = await account();
    const ans = await answerBy(a, a.phone, { decision: 'deny' });
    const { check: _c, ...noCheck } = ans as { check?: unknown };
    expect((await verifyAnswer(noCheck as typeof ans, { chain: a.chain, expect: expectOf(a), now: NOW })).decision).toBe('deny');
  });

  it('refuses a wrong change hash, another request, another gateway, another identity', async () => {
    const a = await account();
    const ctx = { chain: a.chain, now: NOW };
    expect(await codeOf(verifyAnswer(await answerBy(a, a.phone, { change_hash: 'd'.repeat(64) }), { ...ctx, expect: expectOf(a) }))).toBe('wrong_request');
    expect(await codeOf(verifyAnswer(await answerBy(a, a.phone, { request_id: b64uEncode(randomBytes(16)) }), { ...ctx, expect: expectOf(a) }))).toBe('wrong_request');
    expect(await codeOf(verifyAnswer(await answerBy(a, a.phone, { gateway_key_id: a.phone.record.key_id }), { ...ctx, expect: expectOf(a) }))).toBe('wrong_gateway');
    const b = await account();
    expect(await codeOf(verifyAnswer(await answerBy(a, a.phone, { root_did: b.root.did }), { ...ctx, expect: expectOf(a) }))).toBe('wrong_root');
  });

  it('refuses another chain\'s device, a removed device, the asking computer itself', async () => {
    const a = await account();
    const b = await account();
    // b's phone signs an answer naming a's request: not a device of a's chain
    const foreign = await answerBy(a, b.phone);
    expect(await codeOf(verifyAnswer(foreign, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('not_granting');
    // a's phone, removed since
    const r = await account({ removePhone: true });
    const removed = await answerBy(r, r.phone, {}, r.chain);
    expect(await codeOf(verifyAnswer(removed, { chain: r.chain, expect: expectOf(r), now: NOW }))).toBe('not_granting');
    // the computer answering its own request
    expect(await codeOf(verifyAnswer(await answerBy(a, a.gw), { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('not_granting');
  });

  it('refuses a signature by another key, a missing check, a check over something else', async () => {
    const a = await account();
    const good = await answerBy(a, a.phone);
    const other = await answerBy(a, a.gw);
    expect(await codeOf(verifyAnswer({ ...good, sig: other.sig }, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('bad_signature');
    const { check: _c, ...noCheck } = good as { check?: unknown };
    expect(await codeOf(verifyAnswer(noCheck as typeof good, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('check_required');
    const elsewhere = await proofOver(a.phone.checkPriv!, await objectHash({ ...good.confirmation, decision: 'deny' }));
    expect(await codeOf(verifyAnswer({ ...good, check: elsewhere }, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('bad_check');
  });

  it('refuses an expired request and a time outside it; a head this gateway has not seen is "read the chain again"', async () => {
    const a = await account();
    const good = await answerBy(a, a.phone);
    expect(await codeOf(verifyAnswer(good, { chain: a.chain, expect: expectOf(a), now: NOW + 900 }))).toBe('expired');
    expect(await codeOf(verifyAnswer(await answerBy(a, a.phone, { confirmed_at: NOW + 3600 }), { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('bad_time');
    expect(await codeOf(verifyAnswer(await answerBy(a, a.phone, { confirmed_at: NOW - 3600 }), { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('bad_time');
    const ahead = await answerBy(a, a.phone, { chain_seq: a.chain.head.seq + 1 });
    expect(await codeOf(verifyAnswer(ahead, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('chain_ahead');
    const fork = await answerBy(a, a.phone, { chain_head: `sha256:${'e'.repeat(64)}` });
    expect(await codeOf(verifyAnswer(fork, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('chain_fork');
  });

  it('refuses an answer with an extra member', async () => {
    const a = await account();
    const good = await answerBy(a, a.phone);
    const c = { ...good.confirmation, note: 'x' };
    expect(await codeOf(verifyAnswer({ ...good, confirmation: c }, { chain: a.chain, expect: expectOf(a), now: NOW }))).toBe('malformed');
  });
});
