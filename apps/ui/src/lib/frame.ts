/**
 * Bounds / scope / profile hash computation for the Authority UI.
 *
 * Uses SubtleCrypto (browser) instead of Node crypto.
 *
 * This file is a DUPLICATE CANONICALIZER. The UI signs a bounds_hash, a
 * scope_hash, and (v0.7) a profile_hash that the Authority Server (hap-core,
 * Node) recomputes and verifies, so the two must produce identical bytes for
 * identical input — a one-character disagreement means nothing the human
 * authorizes here will ever verify there. It exists because the @hap/core
 * ESM bundle imports node:crypto at module level (computeIntentHash and
 * friends), which Vite rejects in a browser build; only its TYPES are
 * imported below. Keep the logic in `canonicalRecords` byte-identical to
 * hap-core's `canonicalRecords` in src/frame.ts, and `canonicalizeJcs`
 * byte-identical to hap-core's `canonicalize` in src/canonicalize.ts — both
 * aligned with protocol.md → *Bounds & Scope Canonicalization* / *Profile
 * hash*. The shared answer key is
 * content/0.7/vectors/canonical-bounds-and-scope.json (see frame.test.ts).
 */

import type { AgentProfile, AgentBoundsParams, AgentScopeParams } from '@hap/core';

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
 * Thrown when a value cannot be canonicalized at all — currently only a raw
 * LF/CR inside a value. Mirrors hap-core's `CanonicalValueError`, including the
 * protocol error code, so the UI refuses the same input the AS would refuse
 * instead of signing a hash the AS will reject.
 */
export class CanonicalValueError extends Error {
  readonly code: 'BOUNDS_INVALID_VALUE' | 'SCOPE_INVALID_VALUE';
  readonly field: string;

  constructor(code: 'BOUNDS_INVALID_VALUE' | 'SCOPE_INVALID_VALUE', field: string, message: string) {
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
  code: 'BOUNDS_INVALID_VALUE' | 'SCOPE_INVALID_VALUE',
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
 * Compute bounds hash client-side.
 *
 * @throws CanonicalValueError (BOUNDS_INVALID_VALUE) if a value carries a raw LF/CR
 */
export async function computeBoundsHashBrowser(
  params: AgentBoundsParams,
  profile: AgentProfile
): Promise<string> {
  const schema = profile.boundsSchema;
  if (!schema) throw new Error('Profile has no boundsSchema');
  const canonical = canonicalRecords(
    params as Record<string, string | number | undefined>,
    schema.keyOrder,
    'BOUNDS_INVALID_VALUE',
  );
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Compute scope hash client-side (renamed from `computeContextHashBrowser`
 * in v0.7 — hap-core's `AgentProfile.contextSchema` -> `scopeSchema`).
 * If the profile has no scopeSchema or it has no keys, hashes the empty
 * string — protocol.md → *Scope*: "Empty scope ... is permitted; the hash
 * is still computed and included."
 *
 * @throws CanonicalValueError (SCOPE_INVALID_VALUE) if a value carries a raw LF/CR
 */
export async function computeScopeHashBrowser(
  params: AgentScopeParams,
  profile: AgentProfile
): Promise<string> {
  const canonical = profile.scopeSchema
    ? canonicalRecords(
        params as Record<string, string | number | undefined>,
        profile.scopeSchema.keyOrder,
        'SCOPE_INVALID_VALUE',
      )
    : '';
  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Browser-safe port of hap-core's `canonicalize` (src/canonicalize.ts) —
 * RFC 8785 JSON Canonicalization. Byte-identical to the Node version: both
 * rely only on `JSON.stringify`, `Object.keys`, `Array`, and `String` sort,
 * which are environment-independent. See that file's doc comment for why
 * this one can't be imported directly (the @hap/core ESM bundle pulls in
 * node:crypto-importing modules at the top level, which Vite rejects).
 */
function canonicalizeJcs(value: unknown): string {
  if (value === undefined) {
    throw new Error('canonicalize: undefined is not serializable');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`canonicalize: ${value} is not a valid JSON number`);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((el) => (el === undefined ? 'null' : canonicalizeJcs(el)));
    return '[' + items.join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + canonicalizeJcs(v));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Compute the v0.7 `profile_hash` client-side — sha256 of the JCS
 * serialization of the profile JSON exactly as the AS provisioned it
 * (protocol.md → *Profile hash*), mirroring hap-core's `computeProfileHash`.
 * The UI fetches the profile verbatim from `GET /api/profiles/:id`, so
 * hashing the PARSED object here agrees with the AS's own computation
 * regardless of either side's key order or whitespace.
 */
export async function computeProfileHashBrowser(profile: unknown): Promise<string> {
  const hash = await sha256(canonicalizeJcs(profile));
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
