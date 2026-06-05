/**
 * Content binding (HAP v0.5 Content Provenance) — gateway side.
 *
 * When a gated tool's profile declares `content_binding`, the Gatekeeper hashes
 * the action's content and passes ONLY the hash to the SP (see postReceipt's
 * contentHash). The SP signs it into the receipt; it never sees the content.
 * Anyone holding the content can later recompute this hash and check it against
 * the signed receipt — Level 2 proof that this exact content was authorized.
 *
 * Canonicalization is delegated to @humanagencyp/hap-core's `computeContentHash`
 * (the single source of truth a verifier pins): RFC-8785 JCS for `kind:"jcs"`,
 * NFC/LF/trim for `kind:"text"`.
 */

import { computeContentHash, getProfile, type ContentBinding } from '@hap/core';
import type { DiscoveredTool } from './integration-manager';
import { detectContentField } from './receipt-footer';

/** Read the profile's content_binding declaration, if any. */
function getContentBinding(profileId: string): ContentBinding | undefined {
  return getProfile(profileId)?.content_binding;
}

export interface ComputedContentHash {
  contentHash: string;
  contentBinding: { version: string; kind: 'jcs' | 'text' };
}

/**
 * Compute the content hash for a gated tool call, or `undefined` when the
 * profile declares no binding (the common case — only records/customers, and
 * later the communicative profiles, opt in).
 *
 * `toolArgs` MUST be the agent's content BEFORE any footer is appended:
 *  - jcs  → the whole record payload is hashed (structured writes have no body).
 *  - text → the auto-detected content field is hashed pre-footer.
 */
export function computeContentBinding(
  profileId: string,
  tool: DiscoveredTool | undefined,
  toolArgs: Record<string, unknown>,
): ComputedContentHash | undefined {
  const binding = getContentBinding(profileId);
  if (!binding) return undefined;

  let contentHash: string;
  if (binding.kind === 'jcs') {
    contentHash = computeContentHash(binding, toolArgs); // whole record payload
  } else {
    // text: hash only the user-facing content field, pre-footer.
    const field = tool ? detectContentField(tool) : null;
    if (!field) return undefined; // no text field on this tool → nothing to bind
    const raw = typeof toolArgs[field] === 'string' ? (toolArgs[field] as string) : '';
    contentHash = computeContentHash(binding, raw);
  }

  return {
    contentHash,
    contentBinding: { version: binding.version, kind: binding.kind },
  };
}

/**
 * Store provenance (Content Provenance §4.1): record the authorizing receipt id
 * alongside the written artifact, so a row can be reconciled against the AS's
 * signed receipt list (deleted/edited/fabricated rows are all caught).
 *
 * Injected into the outgoing tool args ONLY when the downstream tool opts in by
 * declaring a `receipt_id` field in its input schema — the same decoupled,
 * schema-driven approach the footer uses to find its content field. Structured
 * (Category-B) stores like records/customers declare it; communicative tools
 * (email/calendar) don't, so they're untouched.
 */
export function attachReceiptId(
  tool: DiscoveredTool,
  args: Record<string, unknown>,
  receiptId: string,
): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  if (!schema?.properties || !('receipt_id' in schema.properties)) return args;
  return { ...args, receipt_id: receiptId };
}
