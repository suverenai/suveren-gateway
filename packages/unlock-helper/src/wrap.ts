import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The vault key's second wrap, made HERE in Node (DESIGN.md 3.2): ECIES to the wrap key's public half, so the
 * helper never receives the plaintext vault key and only ever UNWRAPS, behind a touch. Same bytes as
 * macos/Sources/UnlockCore/Wrap.swift; a test proves the helper opens what this makes.
 *
 *   wrapped = 0x01 || ephemeralPublicKey (65) || nonce (12) || ciphertext (32) || tag (16)
 *   key     = HKDF-SHA256(ECDH(ephemeralPrivate, wrapPublic), salt = ephemeralPublic || wrapPublic, info = "suveren-unlock-wrap-v1")
 *   AES-256-GCM, authenticated data = UTF-8 of `aad`
 */
const INFO = Buffer.from('suveren-unlock-wrap-v1');

export function wrapVaultKey(a: { publicKey: string; vaultKey: Uint8Array; aad: string }): string {
  const wrapPub = Buffer.from(a.publicKey, 'base64url');
  if (wrapPub.length !== 65 || wrapPub[0] !== 4) throw Object.assign(new Error('The wrap key is not a P-256 point.'), { code: 'bad_request' });
  if (a.vaultKey.length !== 32) throw Object.assign(new Error('vaultKey must be 32 bytes.'), { code: 'bad_request' });
  const eph = createECDH('prime256v1');
  eph.generateKeys();
  const ephPub = eph.getPublicKey(null, 'uncompressed');
  let secret: Buffer;
  try { secret = eph.computeSecret(wrapPub); } catch { throw Object.assign(new Error('The wrap key is not on the curve.'), { code: 'bad_request' }); }
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.concat([ephPub, wrapPub]), INFO, 32));
  secret.fill(0);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(a.aad));
  const ct = Buffer.concat([c.update(a.vaultKey), c.final()]);
  key.fill(0);
  return Buffer.concat([Buffer.from([1]), ephPub, nonce, ct, c.getAuthTag()]).toString('base64url');
}
