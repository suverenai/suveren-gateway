/**
 * Outgoing argument encoding — transport-safety for BOUND values.
 *
 * A content binding hashes what the human approved. If the transport then
 * mangles one of those values on the way out, the receipt still verifies
 * against the approved bytes but the RECIPIENT — holding the mangled copy —
 * cannot reproduce it. The binding raises a false alarm on honest mail, which
 * is worse than no binding: it teaches people that mismatches are noise.
 *
 * Live case: an email subject containing an em-dash arrived as
 * `Content binding test Ã¢Â€Â” email@0.5`. RFC 5322 headers are ASCII-only, and
 * non-ASCII must be sent as an RFC 2047 encoded-word. The Gmail connector
 * writes `Subject: <raw utf-8>` (its body is fine — that part declares
 * charset=UTF-8), so the bytes are re-read as Latin-1 and double-encoded.
 *
 * The fix is GENERIC, not per-connector: the engine implements the encodings,
 * a manifest declares which argument needs which one — the same shape as
 * `contentField`, `blockedArgs` and `executionMapping`. A connector that
 * transmits headers declares `argEncoding: { subject: "rfc2047" }`; a future
 * connector needing a different transform declares that instead.
 *
 * ORDER MATTERS. This runs LAST, after the content hash and after the
 * verification footer:
 *
 *   hash the approved args  →  receipt  →  append footer  →  encode  →  send
 *
 * Encoding before hashing would bind the wire form rather than what the human
 * approved, and every verifier would then need to reproduce the transport's
 * quirks instead of just reading their mail.
 */

import type { DiscoveredTool } from './integration-manager';

/** Encodings the engine knows how to apply. Declared per-argument by a manifest. */
export type ArgEncoding = 'rfc2047';

/**
 * RFC 2047 encoded-word, Q-encoding, UTF-8.
 *
 * Pure ASCII is returned UNCHANGED — encoding it would alter mail that works
 * today for no benefit, and most subjects are ASCII.
 *
 * Q over B (base64) is deliberate. B expands everything by 4/3, so a normal
 * German subject overruns the 76-char header limit; Q leaves ASCII literal and
 * expands only the non-ASCII bytes, keeping realistic subjects inside it.
 */
export function rfc2047Encode(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;

  const CHARSET = '=?UTF-8?Q?';
  const SUFFIX = '?=';
  // RFC 2047: an encoded word MUST NOT exceed 75 characters in total.
  const MAX_PAYLOAD = 75 - CHARSET.length - SUFFIX.length;

  // Per-character Q-encoding. Encode anything that is not a plain printable
  // ASCII character, plus the characters Q-encoding reserves ('=', '?', '_').
  const atoms: string[] = [];
  for (const char of value) {
    if (char === ' ') {
      atoms.push('_');
      continue;
    }
    if (/^[A-Za-z0-9!*+\-/]$/.test(char)) {
      atoms.push(char);
      continue;
    }
    // Encode each UTF-8 byte. Iterating by code point keeps multi-byte
    // characters intact, so a split never lands mid-character.
    const bytes = Buffer.from(char, 'utf8');
    let encoded = '';
    for (const byte of bytes) encoded += '=' + byte.toString(16).toUpperCase().padStart(2, '0');
    atoms.push(encoded);
  }

  // Pack atoms into encoded words, never splitting an atom (which would split a
  // character or a =XX escape).
  const words: string[] = [];
  let current = '';
  for (const atom of atoms) {
    if (current.length + atom.length > MAX_PAYLOAD) {
      if (current) words.push(CHARSET + current + SUFFIX);
      current = atom;
    } else {
      current += atom;
    }
  }
  if (current) words.push(CHARSET + current + SUFFIX);

  return words.join(' ');
}

const ENCODERS: Record<ArgEncoding, (value: string) => string> = {
  rfc2047: rfc2047Encode,
};

/**
 * Apply the tool's declared `argEncoding` to outgoing arguments.
 *
 * Returns `args` unchanged when the tool declares nothing (the common case) —
 * so a connector that needs no transform is untouched, and this cannot alter
 * mail that already works.
 */
export function encodeOutgoingArgs(
  tool: DiscoveredTool | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const declared = tool?.gating?.argEncoding;
  if (!declared) return args;

  let out: Record<string, unknown> | null = null;
  for (const [field, encoding] of Object.entries(declared)) {
    const encoder = ENCODERS[encoding as ArgEncoding];
    // An unknown encoding is a manifest bug. Leave the value alone rather than
    // guess — silently mangling an outgoing value is the failure being fixed.
    if (!encoder) {
      console.error(
        `[Suveren MCP] Warning: ${tool?.namespacedName} declares argEncoding "${encoding}" ` +
          `for "${field}", which this gateway does not implement. Sending the value unencoded.`,
      );
      continue;
    }
    const value = args[field];
    if (typeof value !== 'string') continue;
    const encoded = encoder(value);
    if (encoded === value) continue;
    out ??= { ...args };
    out[field] = encoded;
  }
  return out ?? args;
}
