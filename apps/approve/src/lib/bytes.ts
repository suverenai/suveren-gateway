/**
 * Small typed helpers around WebCrypto's BufferSource. Under TypeScript 5.9's DOM typings a `Uint8Array` that may sit on a
 * shared buffer is not accepted where WebCrypto wants a BufferSource; a fresh copy is.
 */

/** A copy on a plain ArrayBuffer: what WebCrypto accepts. */
export function own(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(u);
}

/** The bytes as an exact-length ArrayBuffer (what HPKE's `enc` and `ct` parameters take). */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return new Uint8Array(u).buffer;
}

/** A CryptoKey, told by its shape (the `CryptoKey` global is not there in every runtime this code is tested in). */
export function isCryptoKey(x: unknown): x is CryptoKey {
  return typeof x === 'object' && x !== null
    && typeof (x as CryptoKey).type === 'string'
    && typeof (x as CryptoKey).extractable === 'boolean'
    && typeof (x as CryptoKey).algorithm === 'object';
}
