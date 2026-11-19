import { describe, it, expect } from 'vitest';
import { verifyEd25519, b64uDecode, b64uEncode } from '@hap/core/device-keys';
import { encryptProposalContent } from '@hap/core';
import { DeviceKeyStore, KeyStoreError } from './key-store';
import { MemoryKv, type Kv } from './kv';
import { isCryptoKey } from './bytes';

describe('the phone\'s keys (plan 2.2, step 1 check 3c)', () => {
  it('makes a signing key and a reading key; the key id is the hash of the signing public key', async () => {
    const store = new DeviceKeyStore(new MemoryKv());
    expect(await store.exists()).toBe(false);
    const k = await store.create();
    expect(k.signPub).toHaveLength(32);
    expect(k.readPub).toHaveLength(32);
    expect(k.keyId).toHaveLength(43);
    expect(await store.exists()).toBe(true);
    const again = await store.publicKeys();
    expect(again?.keyId).toBe(k.keyId);
    expect(b64uEncode(again!.readPub)).toBe(b64uEncode(k.readPub));
  });

  it('signs with the stored key; hap-core verifies the signature strictly', async () => {
    const store = new DeviceKeyStore(new MemoryKv());
    const k = await store.create();
    const msg = new TextEncoder().encode('suveren device test');
    const sig = await store.sign(msg);
    expect(sig).toHaveLength(64);
    expect(await verifyEd25519(k.signPub, msg, sig)).toBe(true);
    msg[0] ^= 1;
    expect(await verifyEd25519(k.signPub, msg, sig)).toBe(false);
  });

  it('keeps the signing key non-extractable and the reading key ONLY as ciphertext', async () => {
    const kv = new MemoryKv();
    const store = new DeviceKeyStore(kv);
    await store.create();
    const sign = await kv.get<CryptoKey>('keys.sign');
    const wrap = await kv.get<CryptoKey>('keys.wrap');
    expect(isCryptoKey(sign) && sign.extractable).toBe(false);
    expect(isCryptoKey(wrap) && wrap.extractable).toBe(false);
    // No reading CryptoKey of any kind is stored (iOS 18.7 reads an X25519 CryptoKey back as null): bytes and numbers only.
    for (const key of kv.keys()) {
      const v = await kv.get(key);
      if (key === 'keys.reader') {
        expect(Object.keys(v as object).sort()).toEqual(['iv', 'pub', 'wrapped']);
        expect(typeof (v as { wrapped: string }).wrapped).toBe('string');
      }
    }
    expect(JSON.stringify(await kv.get('keys.reader'))).not.toContain('"d"');
  });

  it('opens a content key wrapped to the reading public key, with a non-extractable key made for the call', async () => {
    const store = new DeviceKeyStore(new MemoryKv());
    const k = await store.create();
    const args = { to: 'anna@example.com', body: 'Hello' };
    const { content } = await encryptProposalContent(args, [{ did: 'did:key:z6Mkreader', publicKey: k.readPub }]);
    const cek = await store.openContentKey(content.encrypted_keys['did:key:z6Mkreader']);
    expect(cek).toHaveLength(32);
    // The same wrap opens every time (the key is unwrapped per use, not kept).
    expect(b64uEncode(await store.openContentKey(content.encrypted_keys['did:key:z6Mkreader']))).toBe(b64uEncode(cek));
  });

  it('refuses a second set of keys: it would silently replace the device\'s identity', async () => {
    const store = new DeviceKeyStore(new MemoryKv());
    await store.create();
    await expect(store.create()).rejects.toMatchObject({ code: 'keys_exist' });
  });

  it('deleteAll leaves no keys, and sign says so', async () => {
    const kv = new MemoryKv();
    const store = new DeviceKeyStore(kv);
    await store.create();
    await store.deleteAll();
    expect(await store.exists()).toBe(false);
    expect(kv.keys()).toEqual([]);
    await expect(store.sign(new Uint8Array(4))).rejects.toBeInstanceOf(KeyStoreError);
  });

  it('a store that cannot give a CryptoKey back (like X25519 in IndexedDB on iOS 18.7) fails visibly and leaves nothing', async () => {
    const inner = new MemoryKv();
    const blind: Kv = {
      get: async <T,>(k: string) => (isCryptoKey(await inner.get(k)) ? (null as T) : await inner.get<T>(k)),
      set: (k, v) => inner.set(k, v),
      delete: (k) => inner.delete(k),
    };
    const store = new DeviceKeyStore(blind);
    await expect(store.create()).rejects.toMatchObject({ code: 'storage_unusable' });
    expect(inner.keys()).toEqual([]);
    expect(await store.exists()).toBe(false);
  });

  it('a wrap for another reading key does not open', async () => {
    const a = new DeviceKeyStore(new MemoryKv());
    const b = new DeviceKeyStore(new MemoryKv());
    const ka = await a.create();
    await b.create();
    const { content } = await encryptProposalContent({ x: 1 }, [{ did: 'did:key:z6Mka', publicKey: ka.readPub }]);
    await expect(b.openContentKey(content.encrypted_keys['did:key:z6Mka'])).rejects.toBeTruthy();
  });

  it('base64url helpers agree with hap-core (a wrap is base64url without padding)', () => {
    expect(b64uDecode(b64uEncode(new Uint8Array([1, 2, 3, 250])))).toEqual(new Uint8Array([1, 2, 3, 250]));
  });
});
