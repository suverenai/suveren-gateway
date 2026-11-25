import { describe, it, expect } from 'vitest';
import { encryptProposalContent } from '@hap/core';
import { b64uDecode, b64uEncode, concat, hkdfSha256, utf8 } from '@hap/core/device-keys';
import { DeviceKeyStore } from './key-store';
import { MemoryKv } from './kv';
import { openContent, openContext, pickWrap, NoWrapError, CONTEXT_INFO, type ContentWire } from './content';

const ARGS = { to: 'anna@example.com', subject: 'Offer', body: 'Hello Anna' };

async function setup() {
  const store = new DeviceKeyStore(new MemoryKv());
  const keys = await store.create();
  const { content, proposalContentHash } = await encryptProposalContent(ARGS, [{ did: 'did:key:z6Mkowner', publicKey: keys.readPub }]);
  const wrap = content.encrypted_keys['did:key:z6Mkowner'];
  const wire: ContentWire = { ciphertext: content.ciphertext, device_keys: { [keys.keyId]: wrap }, proposalContentHash };
  return { store, keys, wire, hash: proposalContentHash, wrap };
}

/** The card context, sealed the way the gateway seals it (plan 5): HKDF of the content key, AAD "context" || 0x00 || fingerprint. */
/** The sealed text with one bit of its last byte flipped: always different bytes (replacing characters can leave them equal). */
function tamper(sealed: string): string {
  const bytes = b64uDecode(sealed);
  bytes[bytes.length - 1] ^= 0x01;
  return b64uEncode(bytes);
}

async function sealContext(store: DeviceKeyStore, wrap: { ct: string; enc: string }, fingerprint: string, context: object): Promise<string> {
  const cek = await store.openContentKey(wrap);
  const ctxKey = await hkdfSha256(cek, '', CONTEXT_INFO, 32);
  const key = await crypto.subtle.importKey('raw', new Uint8Array(ctxKey), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = concat(utf8('context'), Uint8Array.of(0), utf8(fingerprint));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(aad) }, key, new Uint8Array(utf8(JSON.stringify(context)))));
  return b64uEncode(concat(iv, sealed));
}

describe('opening a proposal\'s content on the phone (plan 5; v0.8 rules 3 and 8)', () => {
  it('opens the arguments with the phone\'s own wrap', async () => {
    const { store, keys, wire } = await setup();
    const { plaintext } = await openContent(wire, keys.keyId, store);
    expect(JSON.parse(plaintext)).toEqual(ARGS);
  });

  it('a device served exactly one entry reads it even when its key id is not the name', async () => {
    const { store, wire, wrap } = await setup();
    const single: ContentWire = { ...wire, device_keys: { someOtherName: wrap } };
    expect(pickWrap(single, 'x')).toEqual(wrap);
    expect((JSON.parse((await openContent(single, 'x', store)).plaintext))).toEqual(ARGS);
  });

  it('never guesses among several entries', async () => {
    const { wrap } = await setup();
    expect(pickWrap({ ciphertext: 'a', device_keys: { a: wrap, b: wrap } }, 'c')).toBeUndefined();
  });

  it('a device with no wrap says so with its own error (a device added after the request was made)', async () => {
    const { store, keys, wire } = await setup();
    await expect(openContent({ ...wire, device_keys: {} }, keys.keyId, store)).rejects.toBeInstanceOf(NoWrapError);
    await expect(openContent({ ...wire, device_keys: undefined }, keys.keyId, store)).rejects.toBeInstanceOf(NoWrapError);
  });

  it('refuses content whose fingerprint does not match (rule 8), and the error carries no content', async () => {
    const { store, keys, wire } = await setup();
    const bad = { ...wire, proposalContentHash: 'sha256:' + '0'.repeat(64) };
    const e = await openContent(bad, keys.keyId, store).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).not.toContain('Anna');
    expect((e as Error).message).not.toContain('example.com');
  });

  it('refuses a tampered ciphertext', async () => {
    const { store, keys, wire } = await setup();
    const flipped = wire.ciphertext.slice(0, -2) + (wire.ciphertext.endsWith('AA') ? 'BB' : 'AA');
    await expect(openContent({ ...wire, ciphertext: flipped }, keys.keyId, store)).rejects.toBeInstanceOf(Error);
  });

  it('refuses a wrap that is not base64url', async () => {
    const { store, keys, wire } = await setup();
    await expect(openContent({ ...wire, device_keys: { [keys.keyId]: { ct: 'not base64!', enc: 'x' } } }, keys.keyId, store)).rejects.toBeInstanceOf(Error);
  });
});

describe('the card context', () => {
  const CONTEXT = { display: { labels: { to: 'To' } }, execution_mapping: {}, linked_record: null, gateway_version: '0.46.0' };

  it('opens, and is null when the proposal carries none', async () => {
    const { store, keys, wire, hash, wrap } = await setup();
    expect(await openContext(wire, keys.keyId, store)).toBeNull();
    const context = await sealContext(store, wrap, hash, CONTEXT);
    const r = await openContext({ ...wire, context }, keys.keyId, store);
    expect(r).toEqual({ context: CONTEXT });
  });

  it('a context moved to another proposal does not open: the fingerprint is in the associated data', async () => {
    const { store, keys, wire, hash, wrap } = await setup();
    const context = await sealContext(store, wrap, hash, CONTEXT);
    const other = { ...wire, context, proposalContentHash: 'sha256:' + '1'.repeat(64) };
    expect(await openContext(other, keys.keyId, store)).toEqual({ contextError: 'context_unreadable' });
  });

  it('a tampered context, and one that is not an object, fail the same way', async () => {
    const { store, keys, wire, hash, wrap } = await setup();
    const context = await sealContext(store, wrap, hash, CONTEXT);
    expect(await openContext({ ...wire, context: tamper(context) }, keys.keyId, store)).toEqual({ contextError: 'context_unreadable' });
    const notObject = await sealContext(store, wrap, hash, ['x'] as unknown as object);
    expect(await openContext({ ...wire, context: notObject }, keys.keyId, store)).toEqual({ contextError: 'context_unreadable' });
  });

  it('the arguments open even when the context does not', async () => {
    const { store, keys, wire } = await setup();
    expect(await openContext({ ...wire, context: 'AAAA' }, keys.keyId, store)).toEqual({ contextError: 'context_unreadable' });
    expect(JSON.parse((await openContent({ ...wire, context: 'AAAA' }, keys.keyId, store)).plaintext)).toEqual(ARGS);
  });
});
