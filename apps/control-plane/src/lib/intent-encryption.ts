/**
 * Encrypt an intent for a set of approvers (HPKE broadcast, RFC 9180) and compute
 * the disclosure hash the AS cross-checks — one implementation for the
 * /api/encrypt-intent route (the sign page) and the gateway's own mandate
 * creation (lib/mandate-ceremony.ts).
 */
import { computeIntentDisclosureHash } from '@hap/core';
import { encryptForRecipients } from './e2e-crypto';

export interface EncryptedIntentWire {
  intentCiphertext: string;
  encryptedKeys: Record<string, { ct: string; enc: string }>;
  approversFrozen: string[];
  intentDisclosureHash: string;
}

/** Throws on an invalid recipient key (not base64, not 32 bytes). */
export async function encryptIntentForRecipients(
  intent: string,
  recipients: Array<{ userId: string; publicKey: string }>,
): Promise<EncryptedIntentWire> {
  const parsed = recipients.map(({ userId, publicKey }) => {
    const bytes = new Uint8Array(Buffer.from(publicKey, 'base64'));
    if (bytes.length !== 32) throw new Error(`publicKey for userId "${userId}" must be 32 bytes (X25519); got ${bytes.length}`);
    return { userId, publicKey: bytes };
  });
  const encrypted = await encryptForRecipients(intent, parsed);
  const encryptedKeys: Record<string, { ct: string; enc: string }> = {};
  for (const [userId, wrap] of Object.entries(encrypted.encryptedKeys)) {
    encryptedKeys[userId] = { ct: Buffer.from(wrap.ct).toString('base64'), enc: Buffer.from(wrap.enc).toString('base64') };
  }
  const intentCiphertext = Buffer.from(encrypted.intentCiphertext).toString('base64');
  const approversFrozen = parsed.map(r => r.userId);
  return { intentCiphertext, encryptedKeys, approversFrozen, intentDisclosureHash: computeIntentDisclosureHash(intentCiphertext, approversFrozen) };
}
