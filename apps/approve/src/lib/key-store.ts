/**
 * The phone's device keys and where they live (device-keys plan 2.2, 8; step 1 results 12.2).
 *
 * Two keys make a device: an Ed25519 signing key and an X25519 reading key. Both are WebCrypto keys, and the app's own
 * code must never be able to read them out.
 *
 *   Signing key   Ed25519, created non-extractable, stored in IndexedDB as a CryptoKey. Step 1 proved this on the iPhone XS
 *                 (iOS 18.7) and on Android.
 *
 *   Reading key   X25519. On iOS 18.7 an X25519 CryptoKey written to IndexedDB reads back as null (step 1, check 3), so it
 *                 cannot be stored as a CryptoKey. The fallback proven there (check 3c): the key is created EXTRACTABLE, at
 *                 once wrapped (PKCS#8) by a non-extractable AES-GCM key that IndexedDB does keep, stored ONLY as ciphertext,
 *                 and unwrapped as non-extractable for each use. The cost, stated in the plan: the raw private key exists in
 *                 page memory once, at creation. No protocol change: the chain entry says `keystore: "platform"` for both.
 *
 * The same code runs on Android and on a computer's browser: one path, so there is no per-platform branch to get wrong.
 *
 * Nothing here logs, and no error text carries key material. A write is trusted only after it was read back and used
 * (`create` ends with a trial); a store that cannot keep keys fails visibly (`storage_unusable`), never silently.
 */
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from '@hpke/core';
import { b64uDecode, b64uEncode, keyIdOf } from '@hap/core/device-keys';
import type { Kv } from './kv';
import { isCryptoKey, own, toArrayBuffer } from './bytes';

export class KeyStoreError extends Error {
  constructor(readonly code: 'keys_exist' | 'no_keys' | 'storage_unusable' | 'cannot_open', message?: string) {
    super(message ?? code);
    this.name = 'KeyStoreError';
  }
}

const K_SIGN = 'keys.sign';        // Ed25519 private key, CryptoKey, non-extractable
const K_SIGN_PUB = 'keys.sign_pub'; // base64url raw public key
const K_WRAP = 'keys.wrap';        // AES-GCM wrapping key, CryptoKey, non-extractable
const K_READER = 'keys.reader';    // { wrapped, iv, pub }: ciphertext of the X25519 private key and its public key
const K_META = 'keys.meta';        // written last: marks a complete set

interface WrappedReader { wrapped: string; iv: string; pub: string }
interface Meta { v: 1; created_at: number; keystore: 'platform' }

/** What the chain entry needs of the keys. */
export interface DevicePublicKeys {
  signPub: Uint8Array;
  readPub: Uint8Array;
  /** `base64url(sha256(sign_pub))`, plan 2.3. */
  keyId: string;
}

const suite = (): CipherSuite => new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

export class DeviceKeyStore {
  /** `subtle` and `now` are injected for tests; the phone uses the defaults. */
  constructor(
    private readonly kv: Kv,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** True once a complete set of keys was made and stored. */
  async exists(): Promise<boolean> {
    return (await this.kv.get<Meta>(K_META))?.v === 1;
  }

  /**
   * Make the keys, store them, and prove the store gives them back and they work. Refuses when keys exist: a second set
   * would silently replace the device's identity.
   */
  async create(): Promise<DevicePublicKeys> {
    if (await this.exists()) throw new KeyStoreError('keys_exist');
    const s = this.subtle;
    const sign = (await s.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const signPub = new Uint8Array(await s.exportKey('raw', sign.publicKey));
    const wrapKey = (await s.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])) as CryptoKey;
    // The reading key is extractable for this one moment only, so it can be wrapped (check 3c).
    const reader = (await s.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(await s.wrapKey('pkcs8', reader.privateKey, wrapKey, { name: 'AES-GCM', iv }));
    const readPub = new Uint8Array(await s.exportKey('raw', reader.publicKey));

    try {
      await this.kv.set(K_SIGN, sign.privateKey);
      await this.kv.set(K_SIGN_PUB, b64uEncode(signPub));
      await this.kv.set(K_WRAP, wrapKey);
      await this.kv.set(K_READER, { wrapped: b64uEncode(wrapped), iv: b64uEncode(iv), pub: b64uEncode(readPub) } satisfies WrappedReader);
      await this.kv.set(K_META, { v: 1, created_at: this.now(), keystore: 'platform' } satisfies Meta);
      await this.trial();
    } catch (e) {
      await this.deleteAll().catch(() => { /* the next start finds no meta and makes a new set */ });
      throw e instanceof KeyStoreError ? e : new KeyStoreError('storage_unusable');
    }
    return { signPub, readPub, keyId: await keyIdOf(signPub) };
  }

  /** The public keys of the stored device, or null when there are none. */
  async publicKeys(): Promise<DevicePublicKeys | null> {
    if (!(await this.exists())) return null;
    const sp = await this.kv.get<string>(K_SIGN_PUB);
    const r = await this.kv.get<WrappedReader>(K_READER);
    if (typeof sp !== 'string' || !r || typeof r.pub !== 'string') throw new KeyStoreError('storage_unusable');
    const signPub = b64uDecode(sp);
    return { signPub, readPub: b64uDecode(r.pub), keyId: await keyIdOf(signPub) };
  }

  /** Ed25519 signature (64 bytes) over `message` with the device's signing key. The key never leaves WebCrypto. */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const key = await this.kv.get<CryptoKey>(K_SIGN);
    if (!isCryptoKey(key)) throw new KeyStoreError('no_keys');
    return new Uint8Array(await this.subtle.sign({ name: 'Ed25519' }, key, own(message)));
  }

  /**
   * HPKE-open a content key from one wrap (base64url `ct` and `enc`, plan 5) with the reading key. The reading key is
   * unwrapped as NON-extractable for this call and dropped; nothing keeps it.
   */
  async openContentKey(wrap: { ct: string; enc: string }): Promise<Uint8Array> {
    const priv = await this.readerPrivate();
    const stored = await this.kv.get<WrappedReader>(K_READER);
    if (!stored) throw new KeyStoreError('no_keys');
    const publicKey = await this.subtle.importKey('raw', own(b64uDecode(stored.pub)), { name: 'X25519' }, true, []);
    const ctx = await suite().createRecipientContext({
      recipientKey: { privateKey: priv, publicKey },
      enc: toArrayBuffer(b64uDecode(wrap.enc)),
    });
    const cek = new Uint8Array(await ctx.open(toArrayBuffer(b64uDecode(wrap.ct))));
    if (cek.length !== 32) throw new KeyStoreError('cannot_open', 'content key has the wrong length');
    return cek;
  }

  /** Forget this device's keys (unpairing). The recovery code and the chain are not touched. */
  async deleteAll(): Promise<void> {
    for (const k of [K_META, K_SIGN, K_SIGN_PUB, K_WRAP, K_READER]) await this.kv.delete(k);
  }

  /** The reading private key, unwrapped non-extractable. */
  private async readerPrivate(): Promise<CryptoKey> {
    const wrapKey = await this.kv.get<CryptoKey>(K_WRAP);
    const stored = await this.kv.get<WrappedReader>(K_READER);
    if (!isCryptoKey(wrapKey) || !stored) throw new KeyStoreError('no_keys');
    return this.subtle.unwrapKey(
      'pkcs8', own(b64uDecode(stored.wrapped)), wrapKey, { name: 'AES-GCM', iv: own(b64uDecode(stored.iv)) },
      { name: 'X25519' }, false, ['deriveBits'],
    );
  }

  /** What 12.2 check 3 and 3c did: the stored keys read back, sign, and unwrap non-extractable. */
  private async trial(): Promise<void> {
    const signKey = await this.kv.get<CryptoKey>(K_SIGN);
    const wrapKey = await this.kv.get<CryptoKey>(K_WRAP);
    if (!isCryptoKey(signKey) || !isCryptoKey(wrapKey)) throw new KeyStoreError('storage_unusable');
    if (signKey.extractable || wrapKey.extractable) throw new KeyStoreError('storage_unusable');
    await this.sign(new Uint8Array(8));
    const priv = await this.readerPrivate();
    if (priv.extractable) throw new KeyStoreError('storage_unusable');
  }
}
