/**
 * v0.8 proposal content (protocol.md → Proposals — what the Authority Server
 * receives): the gateway seals with hap-core's construction and sends the
 * normative envelope beside the names today's AS stores. Pins:
 *  - the wire carries content.{ciphertext, encrypted_keys, readers, unreadable}
 *    and the legacy keys/hash with the same values;
 *  - hap-core itself opens what the gateway sealed (byte-level agreement);
 *  - a 0.40 gateway's decryptor (standard-base64 Buffer decoding) still opens it;
 *  - pre-0.41 content (standard base64) still opens;
 *  - rule 8: content whose fingerprint differs is refused, never shown.
 */
import { describe, it, expect, vi } from 'vitest';
import { decryptProposalContent as hapDecrypt, computeProposalContentHash, checkProposalReaders } from '@hap/core';
import { encryptProposalContent, decryptProposalContent } from '../lib/content-crypto';
import { generateKeyPair, encryptForRecipients, decryptIntent } from '../lib/e2e-crypto';

const keysByUser = new Map<string, Uint8Array>();
vi.mock('../lib/as-tls-pin', () => ({
  fetchAs: async (url: string) => {
    const id = decodeURIComponent(url.split('/api/users/')[1].split('/')[0]);
    const pub = keysByUser.get(id);
    return { res: { ok: !!pub, status: pub ? 200 : 404, json: async () => ({ pubkey: pub ? Buffer.from(pub).toString('base64') : undefined }) } };
  },
}));
vi.mock('../lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../lib/as-config', () => ({ resolvePinTls: () => false }));

const DEPS = { spUrl: 'https://as.example', cookie: 'sid=1', dataDir: '/tmp/suveren-test', selfUserId: 'self' };
const ARGS = { to: 'kunde@example.com', amount: 5, body: 'Grüße — ✓' };

describe('content-crypto — v0.8 proposal content', () => {
  it('seals with hap-core and sends the normative envelope beside the legacy names', async () => {
    const self = await generateKeyPair();
    const owner = await generateKeyPair();
    keysByUser.set('self', self.publicKey);
    keysByUser.set('owner', owner.publicKey);

    const { content, unreadableFor } = await encryptProposalContent(ARGS, ['owner', 'approver-without-key'], DEPS);

    expect(unreadableFor).toEqual(['approver-without-key']);
    expect(content.readers.sort()).toEqual(['owner', 'self']);
    expect(content.unreadable).toEqual(['approver-without-key']);
    expect(content.keys).toEqual(content.encrypted_keys);
    expect(content.hash).toBe(computeProposalContentHash(ARGS));
    expect(content.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    // readers ∪ unreadable = owner + deciders; readers = key set of encrypted_keys
    expect(() => checkProposalReaders(content, { ownerDid: 'owner', deciders: ['self', 'approver-without-key'] })).not.toThrow();

    // hap-core opens it — the bytes are the normative construction.
    const opened = await hapDecrypt(content, 'owner', owner.privateKey);
    expect(opened.arguments).toEqual(ARGS);
    expect(opened.proposalContentHash).toBe(content.hash);

    // This gateway opens it, checked against the fingerprint.
    expect(JSON.parse(await decryptProposalContent(content, 'self', self.privateKey))).toEqual(ARGS);

    // A 0.40 gateway's decryptor (Buffer 'base64', which reads base64url too) opens it unchanged.
    const wrap = content.keys.owner;
    const legacy = await decryptIntent({
      intentCiphertext: new Uint8Array(Buffer.from(content.ciphertext, 'base64')),
      encryptedKeys: { owner: { ct: new Uint8Array(Buffer.from(wrap.ct, 'base64')), enc: new Uint8Array(Buffer.from(wrap.enc, 'base64')) } },
    }, 'owner', owner.privateKey);
    expect(JSON.parse(legacy)).toEqual(ARGS);
  });

  it('rule 8: refuses content whose fingerprint does not match — never shows it', async () => {
    const self = await generateKeyPair();
    keysByUser.set('self', self.publicKey);
    const { content } = await encryptProposalContent(ARGS, [], DEPS);
    const forged = { ...content, hash: computeProposalContentHash({ ...ARGS, amount: 500 }) };
    await expect(decryptProposalContent(forged, 'self', self.privateKey)).rejects.toThrow(/fingerprint/);
  });

  it('pre-0.41 content (standard base64, `keys` only) still opens, and is fingerprint-checked', async () => {
    const self = await generateKeyPair();
    const jcs = JSON.stringify({ amount: 5, body: 'Grüße — ✓', to: 'kunde@example.com' });
    const enc = await encryptForRecipients(jcs, [{ userId: 'self', publicKey: self.publicKey }]);
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
    const wire = {
      ciphertext: b64(enc.intentCiphertext),
      keys: { self: { ct: b64(enc.encryptedKeys.self.ct), enc: b64(enc.encryptedKeys.self.enc) } },
      hash: computeProposalContentHash(ARGS),
    };
    expect(JSON.parse(await decryptProposalContent(wire, 'self', self.privateKey))).toEqual(ARGS);
    await expect(decryptProposalContent({ ...wire, hash: computeProposalContentHash({ x: 1 }) }, 'self', self.privateKey))
      .rejects.toThrow(/fingerprint/);
  });
});
