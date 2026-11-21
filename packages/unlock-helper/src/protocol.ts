/**
 * The wire protocol between the gateway and the native unlock helper (DESIGN.md section 3).
 * One JSON object per line on the helper's stdin (requests) and stdout (responses).
 * All binary fields are base64url without padding.
 */

export const PROTOCOL_VERSION = 1;

/** Who must be present at each key use. Fixed when the key is created. */
export type Policy = 'user-presence' | 'biometry-current-set' | 'biometry-any';

export type ErrorCode =
  | 'bad_request'          // malformed or out-of-range input
  | 'unsupported'          // unknown op
  | 'no_secure_hardware'   // no Secure Enclave / TPM, or no way to verify a person
  | 'no_biometry'          // a fingerprint is needed and none is enrolled or usable
  | 'biometry_locked'      // Touch ID locked out; the computer's login password unlocks it
  | 'user_cancelled'       // the person cancelled the prompt
  | 'auth_failed'          // the person was not recognised
  | 'interaction_required' // a touch is needed and prompts are switched off
  | 'key_invalid'          // the key blob cannot be used here (other computer, fingerprints changed, damaged)
  | 'unwrap_failed'        // the wrap does not open (other key, other account, damaged)
  | 'digest_mismatch'      // digest is not the SHA-256 of the object given
  | 'caller_refused'       // the helper does not serve this caller; it exits after sending this
  | 'internal'
  // Raised by the client, never by the helper:
  | 'helper_missing' | 'helper_exited' | 'timeout' | 'bad_response';

export interface HelloInfo {
  helper: string;
  version: string;
  protocol: number;
  platform: 'macos' | 'windows';
  backend: string;           // "secure-enclave" | "tpm" | …
  secureHardware: boolean;
  biometry: boolean;
  userPresence: boolean;
}

export interface KeyInfo {
  /** Opaque. Store it beside the vault; it is useless on another computer. */
  keyBlob: string;
  /** Uncompressed P-256 point (65 bytes, 0x04 || X || Y). */
  publicKey: string;
  policy: Policy;
}

export interface SignResult {
  /** ASN.1 DER ECDSA signature, the `signature` of hap-core's platform check proof. */
  signature: string;
  publicKey: string;
}

export const MAX_REASON_CHARS = 120;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Same rule as the helper: 1..120 characters, NFC, no control / format / line / paragraph separators. */
export function isValidReason(s: string): boolean {
  const n = Array.from(s).length;
  if (n < 1 || n > MAX_REASON_CHARS) return false;
  if (s.normalize('NFC') !== s) return false;
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);
}
