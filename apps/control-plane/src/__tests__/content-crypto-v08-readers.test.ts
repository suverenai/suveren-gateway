/**
 * v0.8 proposal readers are named by DID (protocol.md → Proposals, rule 2).
 *
 * Release blocker (2026-11-04): 0.41.0 named `readers` / `encrypted_keys` by
 * ACCOUNT id, so the Authority Server refused every review proposal under a
 * 0.8 mandate (PROPOSAL_APPROVERS_INVALID). Pins:
 *  - under a 0.8 mandate: readers ∪ unreadable = owner DID + signed deciders,
 *    readers = key set of encrypted_keys (hap-core's checkProposalReaders);
 *  - the same CEK is wrapped by account id in `keys`, so a 0.40 gateway
 *    still opens it;
 *  - the gateway's own owner DID is wrapped to the LOCAL key, never the one
 *    the AS serves;
 *  - a decider known only by DID is looked up by DID; one without a key is
 *    `unreadable`;
 *  - decryption finds the reader's wrap by DID or by account id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decryptProposalContent as hapDecrypt, computeProposalContentHash, checkProposalReaders } from '@hap/core';
import { encryptProposalContent, decryptProposalContent } from '../lib/content-crypto';
import { generateKeyPair, decryptIntent } from '../lib/e2e-crypto';

/** What the fake AS serves: by account id or by DID → { userId, pubkey, did }. */
const accounts: Array<{ userId: string; did: string; pub: Uint8Array }> = [];
const requested: string[] = [];
vi.mock('../lib/as-tls-pin', () => ({
  fetchAs: async (url: string) => {
    const seg = decodeURIComponent(url.split('/api/users/')[1].split('/')[0]);
    requested.push(seg);
    const a = accounts.find((x) => x.userId === seg || x.did === seg);
    return {
      res: {
        ok: !!a,
        status: a ? 200 : 404,
        json: async () => (a ? { userId: a.userId, pubkey: Buffer.from(a.pub).toString('base64'), did: a.did } : { error: 'nope' }),
      },
    };
  },
}));
vi.mock('../lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../lib/as-config', () => ({ resolvePinTls: () => false }));

const ARGS = { to: 'kunde@example.com', amount: 5 };
const OWNER_DID = 'did:key:z6MkOwner';
const APPR_DID = 'did:key:z6MkApprover';

beforeEach(() => {
  accounts.length = 0;
  requested.length = 0;
});

describe('content-crypto — v0.8 readers by DID', () => {
  it('personal mode: the owner DID is the only reader, wrapped to the LOCAL key; `keys` stays by account id', async () => {
    const local = await generateKeyPair();
    const asServed = await generateKeyPair(); // what a compromised AS might serve for the owner
    accounts.push({ userId: 'self', did: OWNER_DID, pub: asServed.publicKey });

    const { content } = await encryptProposalContent(
      ARGS, [],
      { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/x', selfUserId: 'self', selfDid: OWNER_DID, selfPublicKey: local.publicKey },
      { ownerDid: OWNER_DID, deciders: [] },
    );

    expect(content.readers).toEqual([OWNER_DID]);
    expect(content.unreadable).toEqual([]);
    expect(Object.keys(content.encrypted_keys)).toEqual([OWNER_DID]);
    expect(Object.keys(content.keys)).toEqual(['self']);
    expect(content.hash).toBe(computeProposalContentHash(ARGS));
    expect(() => checkProposalReaders(content, { ownerDid: OWNER_DID, deciders: [] })).not.toThrow();

    // The DID wrap opens with the LOCAL key (hap-core, the normative construction)…
    expect((await hapDecrypt(content, OWNER_DID, local.privateKey)).arguments).toEqual(ARGS);
    // …and NOT with the AS-served one.
    await expect(hapDecrypt(content, OWNER_DID, asServed.privateKey)).rejects.toThrow();

    // This gateway finds its wrap by DID; with only an account id it still finds `keys.self`
    // (sealed to the AS-registered key, as before — here that is `asServed`).
    expect(JSON.parse(await decryptProposalContent(content, 'self', local.privateKey, OWNER_DID))).toEqual(ARGS);
    expect(JSON.parse(await decryptProposalContent(content, 'self', asServed.privateKey))).toEqual(ARGS);
  });

  it('team with an above-cap approver: readers = owner + signed approver by DID; a 0.40 approver opens `keys` by account id', async () => {
    const owner = await generateKeyPair();
    const appr = await generateKeyPair();
    accounts.push({ userId: 'owner-id', did: OWNER_DID, pub: owner.publicKey });
    accounts.push({ userId: 'appr-id', did: APPR_DID, pub: appr.publicKey });

    const { content, unreadableFor } = await encryptProposalContent(
      ARGS, ['owner-id', 'appr-id'],
      { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/x', selfUserId: 'owner-id', selfDid: OWNER_DID, selfPublicKey: owner.publicKey },
      { ownerDid: OWNER_DID, deciders: [APPR_DID, 'did:key:z6MkGone'] },
    );

    expect(unreadableFor).toEqual([]);
    expect(content.readers.sort()).toEqual([APPR_DID, OWNER_DID].sort());
    expect(content.unreadable).toEqual(['did:key:z6MkGone']);
    expect(Object.keys(content.keys).sort()).toEqual(['appr-id', 'owner-id']);
    expect(() => checkProposalReaders(content, { ownerDid: OWNER_DID, deciders: [APPR_DID, 'did:key:z6MkGone'] })).not.toThrow();
    // The approver was resolved from its account-id lookup's `did` — no extra lookup by DID for it.
    expect(requested.filter((r) => r === APPR_DID)).toEqual([]);

    // 0.41 approver: by DID. 0.40 approver: by account id with the pre-0.41 decryptor.
    expect(JSON.parse(await decryptProposalContent(content, 'appr-id', appr.privateKey, APPR_DID))).toEqual(ARGS);
    const w = content.keys['appr-id'];
    const legacy = await decryptIntent({
      intentCiphertext: new Uint8Array(Buffer.from(content.ciphertext, 'base64')),
      encryptedKeys: { 'appr-id': { ct: new Uint8Array(Buffer.from(w.ct, 'base64')), enc: new Uint8Array(Buffer.from(w.enc, 'base64')) } },
    }, 'appr-id', appr.privateKey);
    expect(JSON.parse(legacy)).toEqual(ARGS);
  });

  it('a signed decider known only by DID is looked up by DID', async () => {
    const owner = await generateKeyPair();
    const appr = await generateKeyPair();
    accounts.push({ userId: 'appr-id', did: APPR_DID, pub: appr.publicKey });

    const { content } = await encryptProposalContent(
      ARGS, [],
      { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/x', selfUserId: 'self', selfDid: OWNER_DID, selfPublicKey: owner.publicKey },
      { ownerDid: OWNER_DID, deciders: [APPR_DID] },
    );
    expect(requested).toContain(APPR_DID);
    expect(content.readers.sort()).toEqual([APPR_DID, OWNER_DID].sort());
    expect((await hapDecrypt(content, APPR_DID, appr.privateKey)).arguments).toEqual(ARGS);
  });

  it('decryption takes both names: `keys` by account id and `encrypted_keys` by DID on one wire', async () => {
    const owner = await generateKeyPair();
    accounts.push({ userId: 'owner-id', did: OWNER_DID, pub: owner.publicKey });
    const { content } = await encryptProposalContent(
      ARGS, [],
      { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/x', selfUserId: 'owner-id', selfDid: OWNER_DID, selfPublicKey: owner.publicKey },
      { ownerDid: OWNER_DID, deciders: [] },
    );
    // As the AS stores and returns it: one `keys` map with both labels.
    const stored = { ciphertext: content.ciphertext, keys: { ...content.keys, ...content.encrypted_keys }, hash: content.hash };
    expect(JSON.parse(await decryptProposalContent(stored, 'owner-id', owner.privateKey, OWNER_DID))).toEqual(ARGS);
    expect(JSON.parse(await decryptProposalContent(stored, 'owner-id', owner.privateKey))).toEqual(ARGS);
  });

  it('under a 0.7 mandate nothing changes: readers by account id, encrypted_keys = keys', async () => {
    const self = await generateKeyPair();
    accounts.push({ userId: 'self', did: OWNER_DID, pub: self.publicKey });
    const { content } = await encryptProposalContent(ARGS, [], { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/x', selfUserId: 'self' });
    expect(content.readers).toEqual(['self']);
    expect(content.keys).toEqual(content.encrypted_keys);
  });
});
