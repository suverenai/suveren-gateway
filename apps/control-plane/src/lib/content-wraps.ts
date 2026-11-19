/**
 * The pieces of proposal encryption that hap-core's `encryptProposalContent` does not expose (device-keys plan 5,
 * build step 8): opening the content key from one wrap (to wrap it again for a device added later), wrapping it
 * to one more key, and the card context, a second ciphertext under a key derived from the content key.
 *
 * Content encryption itself stays hap-core's, byte for byte (rule 3). Nothing here logs, and no error text
 * carries a key, a wrap or a plaintext.
 *
 * Card context (plan 5):
 *   key  = HKDF-SHA256(content key, salt empty, info = "suveren-context"), 32 bytes
 *   AEAD = AES-256-GCM, fresh 12-byte IV, ciphertext = base64url(IV ‖ ct ‖ tag)
 *   AAD  = "context" ‖ 0x00 ‖ proposalContentHash   (so it cannot be moved to another proposal)
 * It is not part of the content fingerprint: v0.8 defines the content as exactly the arguments.
 */
import { hkdfSync, randomBytes } from 'node:crypto';
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from '@hpke/core';
import { canonicalize, fromBase64Url, toBase64Url } from '@hap/core';

export const CONTEXT_INFO = 'suveren-context';
const MAX_CONTEXT_PLAINTEXT_BYTES = 40 * 1024;

export type ContextErrorCode = 'context_unreadable' | 'context_invalid' | 'context_too_large';

export class ContextError extends Error {
  constructor(readonly code: ContextErrorCode) {
    super(code);
    this.name = 'ContextError';
  }
}

/** What the card needs beyond the arguments. The gateway's own data, never the AI's text (plan 5). */
export interface CardContext {
  /** The connector's display rules for this tool. */
  display: unknown;
  /** The mapping from arguments to `executionContext`. */
  execution_mapping: unknown;
  /** The AU10 snapshot (a record the gateway read itself), or null. */
  linked_record: unknown;
  gateway_version: string;
}

const suite = () => new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

/** HPKE-open the content key from one wrap (base64url `ct`, `enc`) with a reading private key. */
export async function openContentKey(wrap: { ct: string; enc: string }, privateKey: Uint8Array): Promise<Uint8Array> {
  const s = suite();
  const recipient = await s.createRecipientContext({
    recipientKey: await s.kem.deserializePrivateKey(privateKey),
    enc: fromBase64Url(wrap.enc),
  });
  const cek = new Uint8Array(await recipient.open(fromBase64Url(wrap.ct)));
  if (cek.length !== 32) throw new Error('content key has the wrong length');
  return cek;
}

/** HPKE-wrap the content key to one more reading public key (a device added later). */
export async function sealContentKey(cek: Uint8Array, publicKey: Uint8Array): Promise<{ ct: string; enc: string }> {
  const s = suite();
  const sender = await s.createSenderContext({ recipientPublicKey: await s.kem.deserializePublicKey(publicKey) });
  const ct = new Uint8Array(await sender.seal(cek));
  return { ct: toBase64Url(ct), enc: toBase64Url(new Uint8Array(sender.enc)) };
}

function contextKey(cek: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', cek, new Uint8Array(0), CONTEXT_INFO, 32));
}

/** `"context" ‖ 0x00 ‖ proposalContentHash`: binds the context to ONE proposal. */
export function contextAad(proposalContentHash: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from('context', 'utf8'), Buffer.from([0]), Buffer.from(proposalContentHash, 'utf8')]));
}

async function aesKey(cek: Uint8Array, usage: 'encrypt' | 'decrypt'): ReturnType<typeof crypto.subtle.importKey> {
  return crypto.subtle.importKey('raw', contextKey(cek), { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Seal the card context: JCS of the object, then the construction in the file header. Returns base64url. */
export async function sealContext(cek: Uint8Array, context: CardContext, proposalContentHash: string): Promise<string> {
  const jcs = Buffer.from(canonicalize(context as unknown as Record<string, unknown>), 'utf8');
  if (jcs.length > MAX_CONTEXT_PLAINTEXT_BYTES) throw new ContextError('context_too_large');
  const iv = new Uint8Array(randomBytes(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: contextAad(proposalContentHash) }, await aesKey(cek, 'encrypt'), jcs));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

/**
 * Open the card context of ONE proposal. A context sealed for another proposal (its hash is in the associated
 * data), a tampered one, one under another key and one that is not a context object all fail the same way:
 * `context_unreadable`; the card is then shown without it, and the arguments stay shown in full.
 */
export async function openContext(cek: Uint8Array, ciphertext: string, proposalContentHash: string): Promise<CardContext> {
  let plain: Uint8Array;
  try {
    const bytes = fromBase64Url(ciphertext);
    if (bytes.length < 12 + 16) throw new Error('short');
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: contextAad(proposalContentHash) }, await aesKey(cek, 'decrypt'), bytes.subarray(12)));
  } catch {
    throw new ContextError('context_unreadable');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { throw new ContextError('context_invalid'); }
  const o = parsed as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o) || typeof o.gateway_version !== 'string'
    || !('display' in o) || !('execution_mapping' in o) || !('linked_record' in o)) {
    throw new ContextError('context_invalid');
  }
  return o as unknown as CardContext;
}
