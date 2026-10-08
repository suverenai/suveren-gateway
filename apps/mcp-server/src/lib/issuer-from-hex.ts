/**
 * hap-core 0.12's verifyMandateSignature / verifyTicketSignature resolve the
 * verification key from the artifact's own `issuer` did:key, restricted via
 * an optional `trustedIssuers` allowlist — they no longer accept a raw
 * public key (protocol.md -> *Ticket Verification* step 1, applied
 * identically to mandates). Every caller in this codebase that used to hold
 * a raw Ed25519 public key hex (the AS's live key, or one archived alongside
 * a ticket/mandate at archive time) needs the equivalent did:key to pass as
 * `trustedIssuers`. One place for that conversion.
 */
import { encodeDidKey } from '@hap/core';

export function issuerFromPublicKeyHex(publicKeyHex: string): string {
  return encodeDidKey(Buffer.from(publicKeyHex, 'hex'));
}
