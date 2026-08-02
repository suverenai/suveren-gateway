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
    // text: hash the bound field, pre-footer.
    //
    // A manifest-declared `contentField` wins over auto-detection. Detection
    // only knows a prose vocabulary (body/text/description/content), so a
    // connector binding something else — a commit SHA, a plan hash, a record id
    // — would produce NO hash and no binding, silently. The receipt would still
    // be issued and would simply prove less than it appears to, which is the
    // worst way for this to fail.
    //
    // Note this is NOT the footer's content field: the footer appends a
    // verification line to prose, and appending it to a commit SHA would
    // corrupt the value being deployed.
    const declared = tool?.gating?.contentField;
    const field = declared ?? (tool ? detectContentField(tool) : null);
    if (!field) return undefined; // nothing on this tool to bind
    const raw = typeof toolArgs[field] === 'string' ? (toolArgs[field] as string) : '';
    // A declared field that is absent or non-string at call time is a manifest
    // bug, not "nothing to bind" — binding to the empty string would look like
    // a valid binding while committing to nothing.
    //
    // This guard once applied only to manifest-declared fields. Auto-detected
    // ones need it more, not less — nothing reviewed them. Gmail's
    // `send_message` is the live case: pass `raw` and its own schema says
    // to/cc/subject/body are ignored, so the message travels in a field this
    // binding never sees while `body` is simply absent. Hashing '' there is the
    // worst available outcome — a content hash that commits to nothing, reads
    // exactly like one that binds the message, and is IDENTICAL for every such
    // call, so a receipt for one message verifies against another. Emitting no
    // binding is honest: the receipt then claims only what it can support.
    if (raw === '') return undefined;
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
