/**
 * Content-hash verification for the ticket's "What was done" box (AU6,
 * work-plan.md "Added 2026-10-09"; approved mockup
 * temp/mockups/gateway-ux-v7.html §3).
 *
 * DUPLICATE CANONICALIZER — same reason as lib/frame.ts: the @hap/core ESM
 * bundle imports node:crypto at module level (content-binding.ts's
 * `computeContentHash` uses Node's `crypto.createHash`), which Vite rejects
 * in a browser build. `canonicalizeJcs` below is byte-for-byte lib/frame.ts's
 * own copy (itself a mirror of hap-core's `canonicalize` — RFC 8785 JCS);
 * `canonicalizeText` mirrors hap-core's content-binding.ts of the same name.
 * Both rely only on `JSON.stringify`/`Object.keys().sort()`/`String.normalize`
 * — environment-independent — so a hash computed here agrees with the one
 * the gateway (Node) computed when it archived the receipt.
 *
 * What this verifies: the LOCAL receipt archive's own `boundContent` (the
 * hash's stored preimage — see receipt-archive.ts `ArchivedReceipt.boundContent`)
 * against the receipt's signed `contentHash`. This is NOT re-deriving the hash
 * from the original tool call — the archive already holds exactly what was
 * hashed — it is confirming the archive entry has not been altered since.
 */

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Byte-for-byte mirror of hap-core's content-binding.ts canonicalizeText:
 *  Unicode NFC, CRLF/CR → LF, strip trailing per-line whitespace, strip
 *  trailing blank lines. */
function canonicalizeText(input: string): string {
  const nfc = input.normalize('NFC');
  const lf = nfc.replace(/\r\n?/g, '\n');
  const lines = lf.split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  return lines.join('\n').replace(/\n+$/, '');
}

/** Byte-for-byte mirror of hap-core's canonicalize.ts (RFC 8785 JCS) — same
 *  copy as lib/frame.ts's own `canonicalizeJcs`, duplicated here rather than
 *  imported to keep this module's only dependency on itself (see header). */
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

export type ContentBindingKind = 'jcs' | 'text';

/**
 * Mirrors hap-core's `computeContentHash`: `sha256:<hex>` over the
 * canonicalized content, by the binding's declared `kind`. Throws if `kind`
 * is `'jcs'` and `content` is a string, or `'text'` and `content` is an
 * object — the same mismatch hap-core's own `contentCanonicalBytes` refuses,
 * since it means the archive entry does not match its own declared kind.
 */
export async function computeContentHashBrowser(
  kind: ContentBindingKind,
  content: Record<string, unknown> | string,
): Promise<string> {
  if (kind === 'jcs') {
    if (typeof content === 'string') {
      throw new Error('content_binding kind="jcs" expects a record payload (object), got a string');
    }
    return `sha256:${await sha256Hex(canonicalizeJcs(content))}`;
  }
  if (typeof content !== 'string') {
    throw new Error('content_binding kind="text" expects a string, got an object');
  }
  return `sha256:${await sha256Hex(canonicalizeText(content))}`;
}
