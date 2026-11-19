import { describe, it, expect } from 'vitest';
import {
  b64uEncode, buildDeviceRecord, buildEntry, deriveRootKey, ed25519PublicKey, entrySignedBytes, generateRecoveryCode,
  pairingCommitment, randomBytes, signEd25519, signEntry, verifyChain,
  type ChainEntry, type ChainState,
} from '@hap/core/device-keys';
import { Mailbox, pairingKeysOf, type MailboxPort } from './mailbox';
import { codeChoices, sameCode } from './codes';
import { checkOpen, OpenCheckError } from './open-check';
import { deviceRows, labelTaken, originOf } from './chain-view';

const NOW = 1_800_000_000;

async function account() {
  const { seed } = await generateRecoveryCode();
  const root = await deriveRootKey(seed);
  const priv = randomBytes(32);
  const pub = await ed25519PublicKey(priv);
  const rec = await buildDeviceRecord({ sign_pub: b64uEncode(pub), read_pub: b64uEncode(randomBytes(32)), kind: 'gateway', label: 'Office Mac', keystore: 'software' }, pub);
  const e0 = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: NOW - 100, signer: 'root', device: rec });
  e0.sigs.push(await signEntry(e0, 'root', root.privateSeed), await signEntry(e0, rec.key_id, priv));
  const chain = await verifyChain({ expectedRootDid: root.did, entries: [e0] });
  return { root, rec, entries: [e0], chain };
}

/** What a new device sends in `open`, for a given chain, kind and label. */
async function opened(a: Awaited<ReturnType<typeof account>>, over: { kind?: 'gateway' | 'approve-app'; label?: string; seq?: number; signer?: string; swap?: boolean } = {}) {
  const priv = randomBytes(32);
  const pub = await ed25519PublicKey(priv);
  const rec = await buildDeviceRecord({ sign_pub: b64uEncode(pub), read_pub: b64uEncode(randomBytes(32)), kind: over.kind ?? 'approve-app', label: over.label ?? 'My iPhone', keystore: 'software' }, pub);
  const entry = buildEntry({
    root_did: a.root.did, seq: over.seq ?? a.chain.head.seq + 1, prev: a.chain.head.hash, op: 'add', created_at: NOW, signer: over.signer ?? a.rec.key_id, device: rec,
  });
  const sig = await signEd25519(priv, entrySignedBytes(entry));
  const rJ = randomBytes(32);
  const commit = await pairingCommitment(entry, sig, rJ);
  const sent = over.swap ? { ...entry, created_at: entry.created_at + 1 } : entry;
  const sentSig = over.swap ? await signEd25519(priv, entrySignedBytes(sent)) : sig;
  return { body: { entry: sent, sig: b64uEncode(sentSig), r_j: b64uEncode(rJ) }, commit, entry };
}

const expectFor = (a: Awaited<ReturnType<typeof account>>, commit: string, kind: 'gateway' | 'approve-app' = 'approve-app') =>
  ({ chain: a.chain as ChainState, rootDid: a.root.did, admitterKeyId: a.rec.key_id, kind, commit });

const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'accepted'; } catch (e) { return e instanceof OpenCheckError ? e.code : `other ${String(e)}`; } };

describe('checkOpen: what an admitter checks of message 4', () => {
  it('accepts the entry message 2 committed to', async () => {
    const a = await account();
    const o = await opened(a);
    const r = await checkOpen(o.body, expectFor(a, o.commit));
    expect(r.entry.device?.label).toBe('My iPhone');
    expect(r.rJ).toHaveLength(32);
  });

  it('refuses an entry that is not the one committed to (a valid signature does not help)', async () => {
    const a = await account();
    const o = await opened(a, { swap: true });
    expect(await codeOf(checkOpen(o.body, expectFor(a, o.commit)))).toBe('commit_mismatch');
  });

  it('refuses the wrong kind of device, a wrong head, a wrong signer, a name already taken, and an entry with signatures', async () => {
    const a = await account();
    const wrongKind = await opened(a, { kind: 'gateway' });
    expect(await codeOf(checkOpen(wrongKind.body, expectFor(a, wrongKind.commit, 'approve-app')))).toBe('open_invalid');
    const wrongSeq = await opened(a, { seq: 5 });
    expect(await codeOf(checkOpen(wrongSeq.body, expectFor(a, wrongSeq.commit)))).toBe('open_invalid');
    const wrongSigner = await opened(a, { signer: 'root' });
    expect(await codeOf(checkOpen(wrongSigner.body, expectFor(a, wrongSigner.commit)))).toBe('open_invalid');
    const taken = await opened(a, { label: 'office mac' });
    expect(await codeOf(checkOpen(taken.body, expectFor(a, taken.commit)))).toBe('label_taken');
    const signed = await opened(a);
    const withSigs = { ...signed.body, entry: { ...signed.body.entry, sigs: [{ by: 'x', sig: b64uEncode(new Uint8Array(64)) }] } };
    expect(await codeOf(checkOpen(withSigs, expectFor(a, signed.commit)))).toBe('open_invalid');
    expect(await codeOf(checkOpen({}, expectFor(a, signed.commit)))).toBe('open_invalid');
  });

  it('refuses a signature made by another key than the one the entry names', async () => {
    const a = await account();
    const o = await opened(a);
    const forged = { ...o.body, sig: b64uEncode(await signEd25519(randomBytes(32), entrySignedBytes(o.entry))) };
    expect(await codeOf(checkOpen(forged, expectFor(a, o.commit)))).toBe('open_invalid');
  });
});

describe('codeChoices and sameCode', () => {
  it('the real code and two others, all different, in random positions', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const c = codeChoices('123456');
      expect(c).toHaveLength(3);
      expect(new Set(c).size).toBe(3);
      expect(c).toContain('123456');
      for (const x of c) expect(x).toMatch(/^\d{6}$/);
      seen.add(c.indexOf('123456'));
    }
    expect(seen.size).toBe(3);
  });
  it('compares whole codes', () => {
    expect(sameCode('123456', '123456')).toBe(true);
    expect(sameCode('123456', '123457')).toBe(false);
    expect(sameCode('123456', '12345')).toBe(false);
  });
});

describe('the device list', () => {
  it('rows oldest first, the origin, the taken label', async () => {
    const a = await account();
    const rows = deviceRows(a.entries, a.chain, a.rec.key_id, NOW);
    expect(rows).toEqual([{ keyId: a.rec.key_id, label: 'Office Mac', kind: 'gateway', thisDevice: true, canGrant: false, addedAt: NOW - 100, recent: false }]);
    expect(originOf(a.entries)).toEqual({ label: 'Office Mac', kind: 'gateway', at: NOW - 100 });
    expect(labelTaken(a.chain, ' OFFICE mac ')).toBe(true);
    expect(labelTaken(a.chain, 'Other')).toBe(false);
  });
});

describe('the mailbox over any port', () => {
  function memoryPort() {
    const messages: unknown[] = [];
    const port: MailboxPort = {
      postMessage: async (_id, m) => (messages.some((x) => (x as { kind: string }).kind === m.kind)
        ? { ok: false, code: 'KIND_EXISTS', status: 409 } : (messages.push(m), { ok: true, data: {}, status: 201 })),
      readMailbox: async () => ({ ok: true, data: { messages: [...messages] }, status: 200 }),
    };
    return { messages, port };
  }

  it('sends with a MAC, reads back verified, takes each kind once, and stops on a bad message', async () => {
    const keys = await pairingKeysOf({ secret: b64uEncode(randomBytes(32)) });
    const m = memoryPort();
    const box = new Mailbox(m.port, keys);
    expect(await box.send('challenge', { r_a: b64uEncode(randomBytes(32)) })).toEqual({ ok: true });
    expect(await box.send('challenge', { r_a: b64uEncode(randomBytes(32)) })).toEqual({ ok: false, code: 'KIND_EXISTS' });
    const read = await box.poll();
    expect(read.ok && Object.keys(read.messages)).toEqual(['challenge']);
    m.messages.push({ kind: 'commit', body: { c: 'sha256:' + '0'.repeat(64) }, mac: b64uEncode(randomBytes(32)) });
    expect(await box.poll()).toEqual({ ok: false, code: 'bad_message' });
  });

  it('the network failing is its own answer', async () => {
    const keys = await pairingKeysOf({ secret: b64uEncode(randomBytes(32)) });
    const down: MailboxPort = { postMessage: async () => ({ ok: false, code: 'x', status: 0 }), readMailbox: async () => ({ ok: false, code: 'x', status: 0 }) };
    const box = new Mailbox(down, keys);
    expect(await box.send('hello', { root_did: 'did:key:z', head: { seq: 0, hash: 'sha256:' + '0'.repeat(64) }, key_id: 'k', as_key: 'ab' })).toEqual({ ok: false, code: 'as_unreachable' });
    expect(await box.poll()).toEqual({ ok: false, code: 'as_unreachable' });
  });
});
