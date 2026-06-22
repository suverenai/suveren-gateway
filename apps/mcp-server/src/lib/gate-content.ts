/**
 * Gate Content Hash Verification — ensures plaintext gate content matches attestation hashes.
 *
 * v0.4: single `intent` hash.
 * v0.5: uses canonicalizeText (Unicode NFC + LF endings + trim trailing whitespace) before
 *       hashing, matching the creation-time hash produced by the browser UI.
 */

import { computeIntentHash } from '@hap/core';
import { decodeAttestationBlob } from '@hap/core';
import type { GateContent } from './gate-store';
import type { CachedAuthorization } from './attestation-cache';

/**
 * Hash a gate content string using SHA-256 over the canonical form.
 * Returns format: sha256:<hex>
 *
 * Delegates to hap-core's computeIntentHash which applies canonicalizeText
 * (Unicode NFC + LF line endings + trailing-whitespace strip) before hashing.
 * Must be byte-identical to the browser-side hashGateContent in apps/ui/src/lib/frame.ts.
 */
export function hashGateContent(text: string): string {
  return computeIntentHash(text);
}

/**
 * Verify that gate content plaintext matches the intent hash in the attestation.
 */
export function verifyGateContentHashes(
  content: GateContent,
  auth: CachedAuthorization
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (auth.attestations.length === 0) {
    return { valid: false, errors: ['No attestations available to verify against'] };
  }

  const attestation = decodeAttestationBlob(auth.attestations[0].blob);
  const expectedHashes = attestation.payload.gate_content_hashes;

  if (!expectedHashes?.intent) {
    return { valid: false, errors: ['Attestation does not contain intent hash'] };
  }

  if (!content.intent) {
    return { valid: false, errors: ['Missing intent content'] };
  }

  const actual = hashGateContent(content.intent);
  if (actual !== expectedHashes.intent) {
    errors.push(`Hash mismatch for "intent": expected ${expectedHashes.intent}, got ${actual}`);
  }

  return { valid: errors.length === 0, errors };
}
