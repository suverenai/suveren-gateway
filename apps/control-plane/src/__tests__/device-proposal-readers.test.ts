/**
 * Proposal content encrypted to every device (device-keys plan 5; build step 8, computer part).
 *
 * Real: a vault in a temp folder, the real chain/pin stores, hap-core's real chain verification, real HPKE and
 * AES-GCM, the real encrypt/decrypt/re-wrap code. Stood in: the network to the Authority Server (`FakeAs`), which
 * serves chains (and, for a person without one, a legacy reading key) and records what the gateway posts.
 *
 * What is pinned:
 *  - every ACTIVE device of the own chain and of each reader's chain gets a wrap, and opens the proposal;
 *  - `readers` equals the key set of `encrypted_keys` (v0.8 rule 2) and `encrypted_keys[did]` is the wrap of the device
 *    with the lowest `added_seq`;
 *  - a forged, forked or rolled-back chain of a reader: that person is `unreadable` (a code, an alarm), gets no wrap;
 *  - a reader WITHOUT a chain still opens it through the legacy wrap, by account id and by DID;
 *  - the own reading key must be the one in the chain's record of this computer;
 *  - a card context opens on a device, and fails when moved to another proposal;
 *  - a device added later opens an open proposal after a re-wrap, and a wrap is never made for another person's device.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { checkProposalReaders, computeProposalContentHash, decryptProposalContent as hapDecrypt } from '@hap/core';
import {
  b64uEncode, buildEntry, deriveRootKey, ecdsaRawToDer, ed25519PublicKey, entryHash, keyIdOf, randomBytes, signEntry,
  type ChainEntry, type DeviceRecord,
} from '@hap/core/device-keys';
import express from 'express';
import type { Server } from 'node:http';
import { createInternalContentCryptoRouter } from '../routes/internal-content-crypto';
import { Vault } from '../lib/vault';
import { DeviceChainStore } from '../lib/device-chain-store';
import { DevicePinStore } from '../lib/device-pin-store';
import { DeviceReaders, OwnChainError } from '../lib/device-readers';
import { ProposalRewrap } from '../lib/proposal-rewrap';
import { encryptProposalContent, decryptProposalContent, decryptProposalContext, NoWrapError } from '../lib/content-crypto';
import { sealContext, openContentKey, type CardContext } from '../lib/content-wraps';
import { generateKeyPair, type KeyPair } from '../lib/e2e-crypto';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import { AsUnreachableError, type DeviceAsClient } from '../lib/device-as-client';

// The legacy reading-key lookup (`GET /api/users/:id/pubkey`) goes through fetchAs; a person without a chain has one.
const legacy: Array<{ userId: string; did: string; pub: Uint8Array; omitDid?: boolean }> = [];
vi.mock('../lib/as-tls-pin', () => ({
  fetchAs: async (url: string) => {
    const seg = decodeURIComponent(url.split('/api/users/')[1].split('/')[0]);
    const a = legacy.find((x) => x.userId === seg || x.did === seg);
    return { res: { ok: !!a, status: a ? 200 : 404, json: async () => (a ? { userId: a.userId, pubkey: Buffer.from(a.pub).toString('base64'), did: a.omitDid ? undefined : a.did } : { error: 'nope' }) } };
  },
  AsTlsMismatchError: class extends Error {},
}));
vi.mock('../lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../lib/as-config', () => ({ resolvePinTls: () => false }));

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const ARGS = { to: 'kunde@example.com', amount: 5 };

// ── chains made with hap-core, devices with real reading keys ────────────────

interface Dev { seed: Uint8Array; record: DeviceRecord; read: KeyPair; checkPriv: webcrypto.CryptoKey }
type Root = Awaited<ReturnType<typeof deriveRootKey>>;
interface Person { root: Root; devs: Dev[]; entries: ChainEntry[] }

async function newDev(): Promise<Dev> {
  const seed = randomBytes(32);
  const signPub = await ed25519PublicKey(seed);
  const kp = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const read = await generateKeyPair();
  return {
    seed, read, checkPriv: kp.privateKey,
    record: {
      key_id: await keyIdOf(signPub), sign_pub: b64uEncode(signPub), read_pub: b64uEncode(read.publicKey), kind: 'gateway',
      label: `Computer ${Math.random().toString(36).slice(2, 6)}`, keystore: 'platform',
      check: { type: 'platform', pub: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))) },
    },
  };
}
async function checkOver(priv: webcrypto.CryptoKey, hash: string) {
  const digest = Buffer.from(hash.slice('sha256:'.length), 'hex');
  return { signature: b64uEncode(ecdsaRawToDer(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, digest)))) };
}
async function newPerson(): Promise<Person> {
  const root = await deriveRootKey(randomBytes(16));
  const first = await newDev();
  const e = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: 1794000000, signer: 'root', device: first.record });
  const h = await entryHash(e);
  e.sigs = [await signEntry(e, 'root', root.privateSeed), await signEntry(e, first.record.key_id, first.seed)];
  e.checks = [{ by: first.record.key_id, check: await checkOver(first.checkPriv, h) }];
  return { root, devs: [first], entries: [e] };
}
/** `admitter` (a device already in the chain) adds a new device; returns it. */
async function addDevice(p: Person, admitter = p.devs[0]): Promise<Dev> {
  const joiner = await newDev();
  const prev = p.entries[p.entries.length - 1];
  const e = buildEntry({ root_did: p.root.did, seq: prev.seq + 1, prev: await entryHash(prev), op: 'add', created_at: 1794000100 + prev.seq, signer: admitter.record.key_id, device: joiner.record });
  const h = await entryHash(e);
  e.sigs = [await signEntry(e, admitter.record.key_id, admitter.seed), await signEntry(e, joiner.record.key_id, joiner.seed)];
  e.checks = [{ by: admitter.record.key_id, check: await checkOver(admitter.checkPriv, h) }, { by: joiner.record.key_id, check: await checkOver(joiner.checkPriv, h) }];
  p.entries.push(e);
  p.devs.push(joiner);
  return joiner;
}
const headOf = async (p: Person) => ({ seq: p.entries.length - 1, hash: await entryHash(p.entries[p.entries.length - 1]) });

// ── the Authority Server as the gateway sees it ──────────────────────────────

class FakeAs {
  chains = new Map<string, unknown[]>();
  /** What `GET /api/proposals?...` returns, and what was posted. */
  proposals: Array<Record<string, unknown>> = [];
  posted: Array<{ path: string; body: { device_keys: Record<string, { ct: string; enc: string }> } }> = [];
  down = false;
  serve(p: Person, entries: unknown[] = p.entries) { this.chains.set(p.root.did, entries); }
  readonly client = {
    asUrl: 'https://as.example',
    call: async (method: string, path: string, opts: { body?: unknown } = {}) => {
      if (this.down) throw new AsUnreachableError('down');
      if (method === 'GET' && path.startsWith('/api/devices/chain?did=')) {
        const did = decodeURIComponent(path.split('did=')[1]);
        const entries = this.chains.get(did);
        if (!entries) return { status: 404, body: null };
        const last = entries[entries.length - 1] as ChainEntry;
        return { status: 200, body: { entries, head: { seq: last.seq, hash: await entryHash(last) } } };
      }
      if (method === 'GET' && path.startsWith('/api/proposals?')) return { status: 200, body: { proposals: path.includes('creator=me') ? this.proposals : [] } };
      if (method === 'POST' && /^\/api\/proposals\/[^/]+\/wraps$/.test(path)) {
        this.posted.push({ path, body: opts.body as never });
        return { status: 201, body: { added: Object.keys((opts.body as { device_keys: object }).device_keys), existing: [] } };
      }
      return { status: 404, body: null };
    },
  } as unknown as DeviceAsClient;
}

interface Gateway { vault: Vault; store: DeviceChainStore; pins: DevicePinStore; readers: DeviceReaders; me: Person; dev: Dev; alarms: Array<{ did: string; code: string }>; as: FakeAs }

/** One gateway: it is `dev` of person `me`. Its vault holds the reading key of `dev` (the chain's record of it is the check). */
async function boot(me: Person, dev: Dev, as: FakeAs, teamMembers?: () => Promise<ReadonlySet<string> | null>): Promise<Gateway> {
  const vault = new Vault(mkdtempSync(join(tmpdir(), 'dk-readers-')), { ...FAST, deviceKeys: true });
  await vault.createWithPassword('correct horse battery', 'u-me');
  vault.setCredential('e2eKey', { privateKey: Buffer.from(dev.read.privateKey).toString('base64'), publicKey: Buffer.from(dev.read.publicKey).toString('base64') } as never);
  vault.setSpCookie('Bearer test-token');
  vault.setSessionUser({ id: 'u-me', did: me.root.did });
  const store = new DeviceChainStore(vault);
  store.create({ v: 1, rootDid: me.root.did, keyId: dev.record.key_id, head: await headOf(me), asUrl: 'https://as.example', label: dev.record.label, setUpAt: 1794000000 });
  const pins = new DevicePinStore(vault, store);
  const alarms: Array<{ did: string; code: string }> = [];
  const readers = new DeviceReaders({ vault, store, client: as.client, pins, onAlarm: (did, code) => alarms.push({ did, code }), ...(teamMembers ? { teamMembers } : {}) });
  return { vault, store, pins, readers, me, dev, alarms, as };
}

const deps = (g: Gateway) => ({
  spUrl: 'https://as.example', cookie: 'Bearer test-token', dataDir: '/tmp/x', selfUserId: 'u-me', selfDid: g.me.root.did,
  selfPublicKey: g.dev.read.publicKey, device: { readers: g.readers, selfPrivateKey: g.dev.read.privateKey },
});
const CONTEXT: CardContext = { display: { title: 'Send' }, execution_mapping: { to: 'recipients' }, static_execution: { action_type: 'send' }, linked_record: null, gateway_version: '9.9.9' };

beforeEach(() => { legacy.length = 0; });

describe('device keys step 8: encryption to every device', () => {
  it('wraps to every active device of the own chain and of the approver\'s chain; each opens it; readers equal the key set', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const second = await addDevice(me);
    const appr = await newPerson();
    const phone = await addDevice(appr);
    as.serve(me); as.serve(appr);
    const g = await boot(me, me.devs[0], as);

    const { content, unreadableFor, unreadableReaders } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] }, CONTEXT);

    expect(Object.keys(content.device_keys!).sort()).toEqual([...me.devs, ...appr.devs].map((d) => d.record.key_id).sort());
    expect(content.readers.sort()).toEqual([me.root.did, appr.root.did].sort());
    expect(Object.keys(content.encrypted_keys).sort()).toEqual(content.readers.sort());
    expect(content.unreadable).toEqual([]);
    expect(unreadableFor).toEqual([]);
    expect(unreadableReaders).toEqual([]);
    expect(() => checkProposalReaders({ ciphertext: content.ciphertext, encrypted_keys: content.encrypted_keys, readers: content.readers, unreadable: content.unreadable }, { ownerDid: me.root.did, deciders: [appr.root.did] })).not.toThrow();
    expect(content.hash).toBe(computeProposalContentHash(ARGS));

    // `encrypted_keys[did]` is the wrap of the device with the LOWEST added_seq (the first one).
    expect(content.encrypted_keys[me.root.did]).toEqual(content.device_keys![me.devs[0].record.key_id]);
    expect(content.encrypted_keys[appr.root.did]).toEqual(content.device_keys![appr.devs[0].record.key_id]);

    // Every device opens the content with its own reading key, from its own entry only (as the AS serves a device session).
    for (const [person, devs] of [[me, [me.devs[0], second]], [appr, [appr.devs[0], phone]]] as const) {
      for (const d of devs) {
        const served = { ...content, device_keys: { [d.record.key_id]: content.device_keys![d.record.key_id] } };
        expect(JSON.parse(await decryptProposalContent(served, 'someone', d.read.privateKey, person.root.did))).toEqual(ARGS);
        expect(JSON.parse(await decryptProposalContent(served, 'someone', d.read.privateKey, person.root.did, d.record.key_id))).toEqual(ARGS);
        // hap-core's normative decryption, over the device's own wrap.
        expect((await hapDecrypt({ ciphertext: content.ciphertext, encrypted_keys: { [d.record.key_id]: content.device_keys![d.record.key_id] }, readers: [d.record.key_id], unreadable: [] }, d.record.key_id, d.read.privateKey)).arguments).toEqual(ARGS);
      }
    }
    // A device's key opens no other device's wrap.
    await expect(decryptProposalContent({ ...content, device_keys: { [appr.devs[0].record.key_id]: content.device_keys![appr.devs[0].record.key_id] } }, 'someone', me.devs[0].read.privateKey, undefined, appr.devs[0].record.key_id)).rejects.toThrow();
  });

  it('a removed device gets no wrap; a person whose chain has no reading-key change still gets the devices it has', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const second = await addDevice(me);
    // remove `second` again
    const prev = me.entries[me.entries.length - 1];
    const rm = buildEntry({ root_did: me.root.did, seq: prev.seq + 1, prev: await entryHash(prev), op: 'remove', created_at: 1794000300, signer: me.devs[0].record.key_id, target: second.record.key_id });
    const h = await entryHash(rm);
    rm.sigs = [await signEntry(rm, me.devs[0].record.key_id, me.devs[0].seed)];
    rm.checks = [{ by: me.devs[0].record.key_id, check: await checkOver(me.devs[0].checkPriv, h) }];
    me.entries.push(rm);
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const { content } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [] });
    expect(Object.keys(content.device_keys!)).toEqual([me.devs[0].record.key_id]);
  });

  it('a forged chain of an approver: listed as unreadable with a code and an alarm, no wrap for them; the owner still reads', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const appr = await newPerson();
    await addDevice(appr);
    as.serve(me);
    // The Authority Server serves the approver's chain with a device swapped in for an attacker's key, signatures unchanged.
    const attacker = await newDev();
    const forged = JSON.parse(JSON.stringify(appr.entries)) as ChainEntry[];
    (forged[1] as unknown as { device: DeviceRecord }).device = attacker.record;
    as.serve(appr, forged);
    const g = await boot(me, me.devs[0], as);

    const { content, unreadableReaders } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] });
    expect(unreadableReaders).toEqual([{ did: appr.root.did, code: 'chain_invalid' }]);
    expect(content.unreadable).toEqual([appr.root.did]);
    expect(content.readers).toEqual([me.root.did]);
    expect(Object.keys(content.device_keys!)).toEqual([me.devs[0].record.key_id]);
    expect(Object.keys(content.device_keys!)).not.toContain(attacker.record.key_id);
    expect(g.alarms).toEqual([{ did: appr.root.did, code: 'chain_invalid' }]);
    expect(() => checkProposalReaders({ ciphertext: content.ciphertext, encrypted_keys: content.encrypted_keys, readers: content.readers, unreadable: content.unreadable }, { ownerDid: me.root.did, deciders: [appr.root.did] })).not.toThrow();
    // The attacker's key cannot open what was made.
    await expect(hapDecrypt({ ciphertext: content.ciphertext, encrypted_keys: { x: content.device_keys![me.devs[0].record.key_id] }, readers: ['x'], unreadable: [] }, 'x', attacker.read.privateKey)).rejects.toThrow();
  });

  it('a chain that is shorter than the one pinned (rollback) or differs at the pinned head (fork): unreadable, alarm', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const appr = await newPerson();
    await addDevice(appr);
    as.serve(me); as.serve(appr);
    const g = await boot(me, me.devs[0], as);
    // First time: verified and pinned at seq 1.
    expect((await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] })).unreadableReaders).toEqual([]);
    expect(g.pins.get(appr.root.did)).toEqual(await headOf(appr));

    // Rollback: the server serves only the genesis.
    as.serve(appr, appr.entries.slice(0, 1));
    const r = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] });
    expect(r.unreadableReaders).toEqual([{ did: appr.root.did, code: 'chain_rollback' }]);
    expect(r.content.readers).toEqual([me.root.did]);

    // Fork: the same length, another second entry (a different device admitted).
    const other = await newPerson();   // only to borrow a valid-looking device: the fork is built from the same root
    void other;
    const forkRoot = JSON.parse(JSON.stringify(appr.entries)) as ChainEntry[];
    const rogue = await newDev();
    const prev = forkRoot[0];
    const e = buildEntry({ root_did: appr.root.did, seq: 1, prev: await entryHash(prev), op: 'add', created_at: 1794000999, signer: appr.devs[0].record.key_id, device: rogue.record });
    const hh = await entryHash(e);
    e.sigs = [await signEntry(e, appr.devs[0].record.key_id, appr.devs[0].seed), await signEntry(e, rogue.record.key_id, rogue.seed)];
    e.checks = [{ by: appr.devs[0].record.key_id, check: await checkOver(appr.devs[0].checkPriv, hh) }, { by: rogue.record.key_id, check: await checkOver(rogue.checkPriv, hh) }];
    as.serve(appr, [forkRoot[0], e]);
    const f = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] });
    expect(f.unreadableReaders).toEqual([{ did: appr.root.did, code: 'chain_fork' }]);
    expect(g.alarms.map((a) => a.code)).toEqual(['chain_rollback', 'chain_fork']);
  });

  it('an outage is no alarm: the approver is unreadable with a code, the doorbell stays quiet', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const appr = await newPerson();
    as.serve(me);          // the approver's chain answers 404 → no chain → legacy lookup finds nothing
    const g = await boot(me, me.devs[0], as);
    const r = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] });
    expect(r.unreadableReaders).toEqual([{ did: appr.root.did, code: 'no_reading_key' }]);
    expect(g.alarms).toEqual([]);
  });

  it('a reader WITHOUT a chain still opens it through the legacy wrap: by DID and by account id', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const oldReader = await generateKeyPair();
    const OLD_DID = 'did:key:z6MkLegacyReader';
    legacy.push({ userId: 'u-old', did: OLD_DID, pub: oldReader.publicKey });
    const g = await boot(me, me.devs[0], as);

    const { content, unreadableReaders } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [OLD_DID] });
    expect(unreadableReaders).toEqual([]);
    expect(content.readers.sort()).toEqual([me.root.did, OLD_DID].sort());
    expect(Object.keys(content.keys)).toEqual(['u-old']);
    // The last released gateway: no chain, no device_keys, finds its wrap by account id (and a 0.41 one by DID).
    const asServed = { ...content, device_keys: undefined, context: undefined };
    expect(JSON.parse(await decryptProposalContent(asServed, 'u-old', oldReader.privateKey))).toEqual(ARGS);
    expect(JSON.parse(await decryptProposalContent(asServed, 'whoever', oldReader.privateKey, OLD_DID))).toEqual(ARGS);
    expect((await hapDecrypt({ ciphertext: content.ciphertext, encrypted_keys: content.encrypted_keys, readers: content.readers, unreadable: [] }, OLD_DID, oldReader.privateKey)).arguments).toEqual(ARGS);
    // The device keys hold only chain devices, never the legacy reader.
    expect(Object.keys(content.device_keys!)).toEqual([me.devs[0].record.key_id]);
  });

  it('the own reading key must be the one in the chain\'s record of this computer; nothing is encrypted otherwise', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const stranger = await generateKeyPair();
    await expect(encryptProposalContent(ARGS, [], { ...deps(g), selfPublicKey: stranger.publicKey }, { ownerDid: me.root.did, deciders: [] })).rejects.toMatchObject({ code: 'key_mismatch' });
    // A removed or unknown own computer: the chain does not list it as active.
    const g2 = await boot(me, await newDev(), as);
    await expect(g2.readers.own(g2.dev.read.publicKey)).rejects.toBeInstanceOf(OwnChainError);
    // An outage on the own chain stops it too: a proposal its own submitter cannot read must not exist.
    as.down = true;
    await expect(encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [] })).rejects.toMatchObject({ code: 'as_unreachable' });
  });

  it('a gateway without a device chain, or a 0.7 mandate, makes no device_keys (today\'s path)', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const mine = await generateKeyPair();
    legacy.push({ userId: 'u-me', did: me.root.did, pub: mine.publicKey });
    const noDevice = await encryptProposalContent(ARGS, [], { spUrl: 'x', cookie: 'c', dataDir: '/tmp/x', selfUserId: 'u-me', selfDid: me.root.did, selfPublicKey: mine.publicKey }, { ownerDid: me.root.did, deciders: [] });
    expect(noDevice.content.device_keys).toBeUndefined();
    const v07 = await encryptProposalContent(ARGS, [], deps(g));
    expect(v07.content.device_keys).toBeUndefined();
  });
});

describe('device keys step 8: the card context', () => {
  it('opens on a device from its own wrap, with the fingerprint of its own proposal', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const second = await addDevice(me);
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const { content } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [] }, CONTEXT);
    expect(content.context).toBeTruthy();
    for (const d of [me.devs[0], second]) {
      const served = { ...content, device_keys: { [d.record.key_id]: content.device_keys![d.record.key_id] } };
      expect(await decryptProposalContext(served, 'u', d.read.privateKey, me.root.did)).toEqual({ context: CONTEXT });
    }
    // The context is not part of the fingerprint: the content hash is over the arguments alone.
    expect(content.hash).toBe(computeProposalContentHash(ARGS));
  });

  it('a context moved to another proposal fails to open (the associated data names the proposal), and the arguments still open', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const a = (await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [] }, CONTEXT)).content;
    const b = (await encryptProposalContent({ to: 'other@example.com', amount: 7 }, [], deps(g), { ownerDid: me.root.did, deciders: [] }, { ...CONTEXT, gateway_version: '1.2.3' })).content;
    const own = me.devs[0].record.key_id;
    // B's context on A's proposal (A's wrap, A's fingerprint): refused. And the other way round.
    expect(await decryptProposalContext({ ...a, context: b.context }, 'u', me.devs[0].read.privateKey, me.root.did)).toEqual({ contextError: 'context_unreadable' });
    // Even under the SAME content key a context sealed for another fingerprint does not open.
    const cek = await openContentKey(a.device_keys![own], me.devs[0].read.privateKey);
    const moved = await sealContext(cek, CONTEXT, b.hash);
    expect(await decryptProposalContext({ ...a, context: moved }, 'u', me.devs[0].read.privateKey, me.root.did)).toEqual({ contextError: 'context_unreadable' });
    expect(await decryptProposalContext({ ...a, context: await sealContext(cek, CONTEXT, a.hash) }, 'u', me.devs[0].read.privateKey, me.root.did)).toEqual({ context: CONTEXT });
    // A tampered context, and a proposal without one.
    const flipped = a.context!.slice(0, -2) + (a.context!.endsWith('A') ? 'BB' : 'AA');
    expect(await decryptProposalContext({ ...a, context: flipped }, 'u', me.devs[0].read.privateKey, me.root.did)).toEqual({ contextError: 'context_unreadable' });
    expect(await decryptProposalContext({ ...a, context: undefined }, 'u', me.devs[0].read.privateKey, me.root.did)).toBeNull();
    // The arguments are not affected by any of it.
    expect(JSON.parse(await decryptProposalContent({ ...a, context: b.context }, 'u', me.devs[0].read.privateKey, me.root.did))).toEqual(ARGS);
  });

  it('a context that is not the gateway\'s four members is refused when sealed', async () => {
    await expect(sealContext(new Uint8Array(32), { display: 'x'.repeat(50_000) } as never, 'sha256:' + 'a'.repeat(64))).rejects.toMatchObject({ code: 'context_too_large' });
  });
});

describe('device keys step 8: re-wrap for a device added later', () => {
  it('wraps an open proposal for the later computer only, the later computer opens it, and a second run does nothing', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const appr = await newPerson();
    as.serve(me); as.serve(appr);
    const g = await boot(me, me.devs[0], as);
    const { content } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] }, CONTEXT);
    const own = me.devs[0].record.key_id;
    // As the AS serves it to this device: its own wrap only.
    as.proposals = [{ id: 'p-1', status: 'pending', content: { ...content, device_keys: { [own]: content.device_keys![own] } } }];

    // A computer is added to my chain later. Nothing was wrapped for it.
    const later = await addDevice(me);
    as.serve(me);
    // The gateway's own record of the chain head moves with its sign-in; the re-wrap verifies against it.
    g.store.advance(await headOf(me));

    const rewrap = new ProposalRewrap({ vault: g.vault, client: as.client, readers: g.readers });
    const res = await rewrap.run();
    expect(res).toMatchObject({ checked: 1, rewrapped: 1, failed: 0 });
    expect(as.posted).toHaveLength(1);
    expect(as.posted[0].path).toBe('/api/proposals/p-1/wraps');
    expect(Object.keys(as.posted[0].body.device_keys)).toEqual([later.record.key_id]);   // the later computer ONLY: never the approver's, never this one's
    // The later computer opens the proposal and its context with the new wrap.
    const served = { ...content, device_keys: { [later.record.key_id]: as.posted[0].body.device_keys[later.record.key_id] } };
    expect(JSON.parse(await decryptProposalContent(served, 'u', later.read.privateKey, me.root.did))).toEqual(ARGS);
    expect(await decryptProposalContext(served, 'u', later.read.privateKey, me.root.did)).toEqual({ context: CONTEXT });

    // The same wrap again would be a replacement: not asked for.
    expect(await rewrap.run()).toMatchObject({ checked: 0, rewrapped: 0, failed: 0 });
    expect(as.posted).toHaveLength(1);
  });

  it('does nothing without another device, on a locked gateway, or for a proposal this device holds no wrap of', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const rewrap = new ProposalRewrap({ vault: g.vault, client: as.client, readers: g.readers });
    expect(await rewrap.run()).toMatchObject({ skipped: 'no_other_device' });

    await addDevice(me);
    as.serve(me);
    g.store.advance(await headOf(me));
    as.proposals = [{ id: 'p-9', status: 'pending', content: { device_keys: {} } }, { id: 'p-8', status: 'executed', content: { device_keys: { [me.devs[0].record.key_id]: { ct: 'a', enc: 'b' } } } }];
    expect(await rewrap.run()).toMatchObject({ checked: 0, rewrapped: 0 });
    expect(as.posted).toHaveLength(0);

    g.vault.clearKey();
    expect(await rewrap.run()).toMatchObject({ skipped: 'locked' });
  });
});

describe('device keys step 8: the internal routes the MCP server uses', () => {
  const SECRET = 'test-internal-secret-0123456789';
  async function serve(g: Gateway, withDevice: boolean): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express();
    const rewrap = new ProposalRewrap({ vault: g.vault, client: g.as.client, readers: g.readers });
    app.use('/internal', express.json(), createInternalContentCryptoRouter(() => SECRET, g.vault, 'https://as.example', '/tmp/x', withDevice ? { readers: g.readers, rewrap, store: g.store } : undefined));
    return new Promise((resolve) => {
      const server: Server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve({ url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, close: () => new Promise<void>((r) => server.close(() => r())) });
      });
    });
  }
  const post = (url: string, path: string, body: unknown, secret: string | null = SECRET) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Internal-Secret': secret } : {}) }, body: JSON.stringify(body) });

  it('encrypt-content seals to every device and the card context; decrypt-content opens the content from the served own wrap and the context with it', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const second = await addDevice(me);
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const { url, close } = await serve(g, true);
    try {
      const enc = await post(url, '/internal/encrypt-content', { toolArgs: ARGS, recipientUserIds: [], readers: { ownerDid: me.root.did, deciders: [] }, context: CONTEXT });
      expect(enc.status).toBe(200);
      const { content } = await enc.json() as { content: { device_keys: Record<string, unknown>; context: string; ciphertext: string; keys: object; hash: string } };
      expect(Object.keys(content.device_keys).sort()).toEqual(me.devs.map((d) => d.record.key_id).sort());
      expect(second.record.key_id in content.device_keys).toBe(true);

      // This gateway opens it from the entry the AS serves it (its own).
      const own = me.devs[0].record.key_id;
      const dec = await post(url, '/internal/decrypt-content', { ciphertext: content.ciphertext, keys: content.keys, device_keys: { [own]: content.device_keys[own] }, context: content.context, proposalContentHash: content.hash });
      expect(dec.status).toBe(200);
      const body = await dec.json() as { plaintext: string; context: unknown };
      expect(JSON.parse(body.plaintext)).toEqual(ARGS);
      expect(body.context).toEqual(CONTEXT);

      // A context from another proposal: the arguments open, the context reports its code.
      const other = await (await post(url, '/internal/encrypt-content', { toolArgs: { z: 1 }, recipientUserIds: [], readers: { ownerDid: me.root.did, deciders: [] }, context: CONTEXT })).json() as { content: { context: string } };
      const moved = await post(url, '/internal/decrypt-content', { ciphertext: content.ciphertext, keys: content.keys, device_keys: { [own]: content.device_keys[own] }, context: other.content.context, proposalContentHash: content.hash });
      expect(moved.status).toBe(200);
      const movedBody = await moved.json() as { plaintext: string; contextError?: string; context?: unknown };
      expect(JSON.parse(movedBody.plaintext)).toEqual(ARGS);
      expect(movedBody.contextError).toBe('context_unreadable');
      expect(movedBody.context).toBeUndefined();

      // A context that is not the gateway's four members is refused.
      expect((await post(url, '/internal/encrypt-content', { toolArgs: ARGS, recipientUserIds: [], readers: { ownerDid: me.root.did, deciders: [] }, context: { display: 'x' } })).status).toBe(400);
    } finally { await close(); }
  });

  it('rewrap-proposals needs the secret, and answers 404 on a gateway without a device chain', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const withDevice = await serve(g, true);
    const without = await serve(g, false);
    try {
      expect((await post(withDevice.url, '/internal/rewrap-proposals', {}, null)).status).toBe(401);
      expect((await post(withDevice.url, '/internal/rewrap-proposals', {})).status).toBe(200);
      expect((await post(without.url, '/internal/rewrap-proposals', {})).status).toBe(404);
    } finally { await withDevice.close(); await without.close(); }
  });
});

describe('device keys step 8: review fixes', () => {
  const dec = { deciders: [] as string[] };
  it('H1a: a DID seen with a chain before, answered "no chain" by the AS, is an alarm and never gets the legacy wrap', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const appr = await newPerson();
    as.serve(me); as.serve(appr);
    const g = await boot(me, me.devs[0], as);
    expect((await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] })).unreadableReaders).toEqual([]);   // pinned now
    // A hacked AS: no chain for the approver any more, and a reading key of its own for that DID.
    as.chains.delete(appr.root.did);
    const attacker = await generateKeyPair();
    legacy.push({ userId: 'u-appr', did: appr.root.did, pub: attacker.publicKey });
    const r = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [appr.root.did] });
    expect(r.unreadableReaders).toEqual([{ did: appr.root.did, code: 'chain_missing' }]);
    expect(r.content.readers).toEqual([me.root.did]);
    expect(r.content.keys).toEqual({});
    expect(g.alarms).toEqual([{ did: appr.root.did, code: 'chain_missing' }]);
    await expect(hapDecrypt({ ciphertext: r.content.ciphertext, encrypted_keys: { [appr.root.did]: r.content.encrypted_keys[me.root.did] }, readers: [appr.root.did], unreadable: [] }, appr.root.did, attacker.privateKey)).rejects.toThrow();
  });

  it('H1b: on a chain gateway a legacy answer that does not name the DID is not believed', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const k = await generateKeyPair();
    legacy.push({ userId: 'u-old', did: 'did:key:z6MkOld', pub: k.publicKey, omitDid: true });
    const g = await boot(me, me.devs[0], as);
    const r = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: ['did:key:z6MkOld'] });
    expect(r.unreadableReaders).toEqual([{ did: 'did:key:z6MkOld', code: 'no_reading_key' }]);
    expect(r.content.keys).toEqual({});
  });

  it('H1c/M1: with a verified member list, a member without a chain is no legacy reader, and a decider not on the list is unreadable', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    const member = await newPerson();     // on the list, but the AS says it has no chain
    const outsider = await newPerson();   // not on the list, chain fine
    as.serve(me); as.serve(outsider);
    const k = await generateKeyPair();
    legacy.push({ userId: 'u-m', did: member.root.did, pub: k.publicKey });
    const g = await boot(me, me.devs[0], as, async () => new Set([me.root.did, member.root.did]));
    const r = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [member.root.did, outsider.root.did] });
    expect((r.unreadableReaders ?? []).sort((a, b) => a.did.localeCompare(b.did))).toEqual([
      { did: member.root.did, code: 'chain_missing' }, { did: outsider.root.did, code: 'not_a_team_member' },
    ].sort((a, b) => a.did.localeCompare(b.did)));
    expect(r.content.readers).toEqual([me.root.did]);
    expect(Object.keys(r.content.device_keys!)).toEqual([me.devs[0].record.key_id]);
    // No port wired (null): today's behaviour, the legacy reader is wrapped.
    const g2 = await boot(me, me.devs[0], as, async () => null);
    expect((await encryptProposalContent(ARGS, [], deps(g2), { ownerDid: me.root.did, deciders: [member.root.did] })).content.readers.sort()).toEqual([me.root.did, member.root.did].sort());
    void dec;
  });

  it('L1: a wrap that does not open THIS proposal\'s content is not passed on', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const a = (await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [] })).content;
    const b = (await encryptProposalContent({ other: 1 }, [], deps(g), { ownerDid: me.root.did, deciders: [] })).content;
    const own = me.devs[0].record.key_id;
    await addDevice(me); as.serve(me); g.store.advance(await headOf(me));
    // The AS serves B's ciphertext with A's wrap (and A's fingerprint): the key opens nothing of it.
    as.proposals = [{ id: 'p-x', status: 'pending', content: { ...b, hash: a.hash, device_keys: { [own]: a.device_keys![own] } } }];
    const res = await new ProposalRewrap({ vault: g.vault, client: as.client, readers: g.readers }).run();
    expect(res.skippedProposals).toEqual([{ id: 'p-x', code: 'content_key_mismatch' }]);
    expect(as.posted).toHaveLength(0);
    // The genuine one goes through.
    as.proposals = [{ id: 'p-y', status: 'pending', content: { ...a, device_keys: { [own]: a.device_keys![own] } } }];
    expect((await new ProposalRewrap({ vault: g.vault, client: as.client, readers: g.readers }).run()).rewrapped).toBe(1);
  });

  it('L4: a device with no wrap of its own gets the code no_wrap_for_this_device, not a decryption failure', async () => {
    const as = new FakeAs();
    const me = await newPerson();
    as.serve(me);
    const g = await boot(me, me.devs[0], as);
    const { content } = await encryptProposalContent(ARGS, [], deps(g), { ownerDid: me.root.did, deciders: [] });
    const later = await newDev();
    const err = await decryptProposalContent({ ...content, keys: {}, encrypted_keys: {}, device_keys: {} }, 'u', later.read.privateKey, undefined, later.record.key_id).catch((e) => e);
    expect(err).toBeInstanceOf(NoWrapError);
    expect(err.code).toBe('no_wrap_for_this_device');
  });
});
