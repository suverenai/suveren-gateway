/**
 * Frame / bounds / context hash computation for the Authority UI.
 *
 * Uses SubtleCrypto (browser) instead of Node crypto.
 *
 * This file is a DUPLICATE CANONICALIZER. The UI signs a bounds_hash and a
 * context_hash that the Authority Server (hap-core, Node) recomputes and
 * verifies, so the two must produce identical bytes for identical input — a
 * one-character disagreement means nothing the human authorizes here will ever
 * verify there. It exists because the @hap/core ESM bundle imports node:crypto
 * at module level (computeIntentHash and friends), which Vite rejects in a
 * browser build; only its TYPES are imported below. Keep the logic in
 * `canonicalRecords` byte-identical to hap-core's `canonicalRecords` in
 * src/frame.ts, and keep both aligned with protocol.md → *Bounds & Scope
 * Canonicalization*. The shared answer key is
 * content/0.7/vectors/canonical-bounds-and-scope.json (see frame.test.ts).
 */

import type { AgentProfile, AgentFrameParams, AgentBoundsParams, AgentContextParams } from '@hap/core';

/**
 * Browser-safe re-implementation of hap-core's canonicalizeText.
 * Must stay in sync with the hap-core definition:
 *   Unicode NFC + CRLF/CR → LF + strip trailing whitespace per line + strip trailing newlines.
 * We inline this here because the full @hap/core ESM bundle imports node:crypto at the module
 * level (for computeIntentHash etc.) which Vite rejects in browser builds.
 */
function canonicalizeText(input: string): string {
  const nfc = input.normalize('NFC');
  const lf = nfc.replace(/\r\n?/g, '\n');
  const lines = lf.split('\n').map(line => line.replace(/[ \t]+$/, ''));
  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Compute SHA-256 hash in the browser.
 */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute frame hash client-side using the same canonical form as hap-core.
 */
export async function computeFrameHashBrowser(
  params: AgentFrameParams,
  profile: AgentProfile
): Promise<string> {
  if (!profile.frameSchema) {
    throw new Error('Profile is missing frameSchema; cannot compute frame hash');
  }
  const lines = profile.frameSchema.keyOrder.map(
    (key) => `${key}=${String(params[key])}`
  );
  const canonical = lines.join('\n');
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Thrown when a value cannot be canonicalized at all — currently only a raw
 * LF/CR inside a value. Mirrors hap-core's `CanonicalValueError`, including the
 * protocol error code, so the UI refuses the same input the AS would refuse
 * instead of signing a hash the AS will reject.
 */
export class CanonicalValueError extends Error {
  readonly code: 'BOUNDS_INVALID_VALUE' | 'CONTEXT_INVALID_VALUE';
  readonly field: string;

  constructor(code: 'BOUNDS_INVALID_VALUE' | 'CONTEXT_INVALID_VALUE', field: string, message: string) {
    super(message);
    this.name = 'CanonicalValueError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Percent-encode a value per protocol.md → *Value encoding*.
 *
 * Over the value's UTF-8 bytes, as `%` + two UPPERCASE hex digits:
 *   - `=` (0x3D) — otherwise it would be read as the key/value separator
 *   - `%` (0x25) — so the encoding is self-inverse
 *   - every byte outside printable ASCII 0x20–0x7E
 *
 * LF and CR are deliberately NOT in this list: they are refused below, so
 * encoding them is unreachable.
 *
 * Encoding happens at canonicalization time only — what the UI stores and
 * displays stays the human's original bytes.
 */
function percentEncodeCanonicalValue(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let out = '';
  for (const b of bytes) {
    if (b === 0x3d || b === 0x25 || b < 0x20 || b > 0x7e) {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

/**
 * The one place `key=value` records are built for bounds and context.
 * Byte-for-byte mirror of hap-core's `canonicalRecords`:
 *   - keys in the schema's keyOrder, never alphabetical
 *   - a value carrying a raw LF/CR is REFUSED (never stripped or encoded)
 *   - `=`, `%`, and any byte outside 0x20–0x7E are percent-encoded (UPPERCASE)
 *   - numbers use `String()`, the shortest round-trippable form (`String(20.0)`
 *     === "20")
 *   - a key with no value is OMITTED entirely — it emits no record, so an
 *     optional bound the human never set (the UI hides several) never hashes
 *     the JavaScript artifact "undefined", and "no limit set" stays distinct
 *     from an empty value, which renders as `key=`
 */
function canonicalRecords(
  params: Record<string, string | number | undefined>,
  keyOrder: string[],
  code: 'BOUNDS_INVALID_VALUE' | 'CONTEXT_INVALID_VALUE',
): string {
  const lines: string[] = [];

  for (const key of keyOrder) {
    const value = params[key];
    if (value === undefined || value === null) continue;

    const raw = String(value);
    if (raw.includes('\n') || raw.includes('\r')) {
      throw new CanonicalValueError(
        code,
        key,
        `Value for "${key}" contains a raw newline or carriage return. ` +
          'Refusing: a hash over stripped or normalized input would not represent what was authorized.',
      );
    }

    lines.push(`${key}=${percentEncodeCanonicalValue(raw)}`);
  }

  return lines.join('\n');
}

/**
 * Compute bounds hash client-side (v0.4).
 * Falls back to frameSchema if boundsSchema is not present.
 *
 * @throws CanonicalValueError (BOUNDS_INVALID_VALUE) if a value carries a raw LF/CR
 */
export async function computeBoundsHashBrowser(
  params: AgentBoundsParams,
  profile: AgentProfile
): Promise<string> {
  const schema = profile.boundsSchema ?? profile.frameSchema;
  if (!schema) throw new Error('Profile has no boundsSchema or frameSchema');
  const canonical = canonicalRecords(
    params as Record<string, string | number | undefined>,
    schema.keyOrder,
    'BOUNDS_INVALID_VALUE',
  );
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Compute context hash client-side (v0.4).
 * If the profile has no contextSchema or it has no keys, hashes the empty string.
 *
 * @throws CanonicalValueError (CONTEXT_INVALID_VALUE) if a value carries a raw LF/CR
 */
export async function computeContextHashBrowser(
  params: AgentContextParams,
  profile: AgentProfile
): Promise<string> {
  const canonical = profile.contextSchema
    ? canonicalRecords(
        params as Record<string, string | number | undefined>,
        profile.contextSchema.keyOrder,
        'CONTEXT_INVALID_VALUE',
      )
    : '';
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Hash gate content (text) for gate_content_hashes.
 *
 * v0.5: canonicalizes the text (Unicode NFC + LF endings + trailing-whitespace
 * strip) before hashing so the result is byte-identical to the server-side
 * computeIntentHash from hap-core used in the MCP gatekeeper.
 *
 * Uses SubtleCrypto (browser-safe). Does NOT import computeIntentHash which
 * is Node-only.
 */
export async function hashGateContent(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeText(text));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(buf));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
