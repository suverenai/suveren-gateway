/**
 * E2E Encryption — HPKE broadcast pattern.
 *
 * Suite: DhkemX25519HkdfSha256 + HkdfSha256 + Aes256Gcm  (RFC 9180)
 *
 * Broadcast pattern:
 *   1. Generate a random 32-byte Content Encryption Key (CEK).
 *   2. AES-256-GCM-encrypt the intent plaintext with the CEK (one bulk ciphertext).
 *   3. HPKE-seal the CEK once per recipient — produces a compact {ct, enc} wrap.
 *
 * Decrypt (per recipient):
 *   1. HPKE-open the CEK using the recipient's private key + enc.
 *   2. AES-256-GCM-decrypt the bulk ciphertext with the CEK.
 *
 * All binary values are Uint8Array throughout; callers serialise to/from base64
 * at the API boundary (e.g. in routes/authority.ts).
 */

import {
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
  Aes256Gcm,
} from '@hpke/core';
import { canonicalizeText } from '@hap/core';

// ─── Suite singleton ─────────────────────────────────────────────────────────

function getSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface KeyPair {
  privateKey: Uint8Array; // raw X25519 private key, 32 bytes
  publicKey: Uint8Array;  // raw X25519 public key, 32 bytes
}

/** HPKE per-recipient key wrap: ct = sealed CEK bytes, enc = HPKE encapsulated key */
export interface RecipientWrap {
  ct: Uint8Array;
  enc: Uint8Array;
}

export interface EncryptedIntent {
  /** AES-256-GCM ciphertext of the intent (includes GCM auth tag, prepended 12-byte IV) */
  intentCiphertext: Uint8Array;
  /** Per-recipient HPKE-sealed CEK, keyed by userId */
  encryptedKeys: Record<string, RecipientWrap>;
}

// ─── Key generation / serialisation ─────────────────────────────────────────

/**
 * Generate a fresh X25519 HPKE key pair.
 * Returns raw bytes — the vault stores them as base64.
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const suite = getSuite();
  const ckp = await suite.kem.generateKeyPair();
  const privBuf = await suite.kem.serializePrivateKey(ckp.privateKey);
  const pubBuf = await suite.kem.serializePublicKey(ckp.publicKey);
  return {
    privateKey: new Uint8Array(privBuf),
    publicKey: new Uint8Array(pubBuf),
  };
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt `intent` for all listed recipients.
 *
 * Uses the broadcast pattern: one CEK, one bulk ciphertext, one HPKE wrap
 * per recipient. Recipients that are not in the list cannot decrypt.
 *
 * @param intent    Plaintext intent string (UTF-8).
 * @param recipients  Array of { userId, publicKey (raw 32 bytes) }.
 */
export async function encryptForRecipients(
  intent: string,
  recipients: Array<{ userId: string; publicKey: Uint8Array }>,
): Promise<EncryptedIntent> {
  if (recipients.length === 0) {
    throw new Error('encryptForRecipients: recipients array must not be empty');
  }

  const suite = getSuite();

  // 1. Random 32-byte CEK.
  const cek = crypto.getRandomValues(new Uint8Array(32));

  // 2. AES-256-GCM-encrypt the intent with the CEK.
  //    We use Node's WebCrypto (globalThis.crypto) which is available in Node 20+.
  const aesKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(intent);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintextBytes,
  );

  // Prepend IV so the ciphertext is self-contained.
  const intentCiphertext = new Uint8Array(12 + cipherBuf.byteLength);
  intentCiphertext.set(iv, 0);
  intentCiphertext.set(new Uint8Array(cipherBuf), 12);

  // 3. HPKE-seal the CEK for each recipient.
  const encryptedKeys: Record<string, RecipientWrap> = {};

  for (const { userId, publicKey } of recipients) {
    const recipientCryptoKey = await suite.kem.deserializePublicKey(publicKey);

    const senderCtx = await suite.createSenderContext({
      recipientPublicKey: recipientCryptoKey,
    });

    // seal() encrypts the CEK bytes — the HPKE AEAD protects them.
    const wrappedCek = await senderCtx.seal(cek);

    encryptedKeys[userId] = {
      ct: new Uint8Array(wrappedCek),
      enc: new Uint8Array(senderCtx.enc),
    };
  }

  return { intentCiphertext, encryptedKeys };
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted intent for a specific recipient.
 *
 * @param encrypted     The EncryptedIntent object from encryptForRecipients.
 * @param myUserId      The recipient's userId (must be in encryptedKeys).
 * @param myPrivateKey  The recipient's raw X25519 private key bytes.
 */
export async function decryptIntent(
  encrypted: EncryptedIntent,
  myUserId: string,
  myPrivateKey: Uint8Array,
): Promise<string> {
  const wrap = encrypted.encryptedKeys[myUserId];
  if (!wrap) {
    throw new Error(`decryptIntent: no key wrap found for userId "${myUserId}"`);
  }

  const suite = getSuite();

  // 1. Reconstruct the HPKE recipient context and recover the CEK.
  const recipientCryptoKey = await suite.kem.deserializePrivateKey(myPrivateKey);
  const recipientCtx = await suite.createRecipientContext({
    recipientKey: recipientCryptoKey,
    enc: wrap.enc,
  });

  const cekBuf = await recipientCtx.open(wrap.ct);
  const cek = new Uint8Array(cekBuf);

  // 2. AES-256-GCM-decrypt the bulk ciphertext.
  if (encrypted.intentCiphertext.length < 13) {
    throw new Error('decryptIntent: intentCiphertext is too short (missing IV)');
  }
  const iv = encrypted.intentCiphertext.slice(0, 12);
  const ciphertext = encrypted.intentCiphertext.slice(12);

  const aesKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertext,
  );

  return new TextDecoder().decode(plainBuf);
}

// ─── Intent hash ─────────────────────────────────────────────────────────────

/**
 * SHA-256 hex digest of the canonical intent string.
 * Applies canonicalizeText (Unicode NFC + LF endings + trailing-whitespace
 * strip) before hashing, consistent with computeIntentHash in hap-core.
 * Returns bare hex (no "sha256:" prefix) — preserved for callers.
 *
 * Note: this function is exported but has no callers in the gateway codebase
 * outside of its own test. It is NOT used for gate_content_hashes.intent
 * (that path goes through the UI's hashGateContent / MCP's computeIntentHash).
 */
export async function intentHash(intent: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeText(intent));
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
