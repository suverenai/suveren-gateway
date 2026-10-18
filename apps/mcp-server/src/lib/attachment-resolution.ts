/**
 * Attachment/insert resolution — the orchestration tool-proxy.ts (automatic
 * mode) and commitments.ts (review mode) call for a write tool whose gating
 * declares `attachmentsArg` and/or `insertFields` (suveren-invoicing-plan.md
 * §6/§7). Split into two phases so review mode can show + seal a proposal
 * WITHOUT building the final byte payload, and only build it after approval:
 *
 *   - {@link resolveAttachmentsAndInserts} ("resolve for display"): shape-
 *     checks the `attachments`/`insert` arguments (refuse bytes/typed values
 *     smuggled in — attachment-reference.ts), policy-checks each attachment
 *     reference against the SELECTED mandate's own `allowed_attachment_sources`
 *     scope value (attachment-policy.ts), resolves every reference
 *     (document-source.ts / insert-values.ts — computing/verifying each
 *     document's sha256 and each value's host), substitutes resolved insert
 *     values into the declared text fields (insert-values.ts's
 *     `applyInserts` — THIS is what content binding later hashes, so the
 *     sealed text already carries the final, inserted copy), and strips the
 *     reference-only `attachments`/`insert` keys. It does NOT embed any
 *     attachment bytes into the outgoing call — only fingerprints
 *     (filename/contentType/sha256/bytes) travel in the returned `sealed`
 *     block, meant to be merged into the outgoing args as a `_`-prefixed meta
 *     field (same convention as `_imagePreview`/`_source`) purely for local
 *     display/storage — see tool-proxy.ts's call site for exactly how it's
 *     attached.
 *   - {@link finalizeAttachmentsForExecution}: given args already carrying
 *     that sealed meta, RE-resolves each attachment/insert reference fresh
 *     and refuses if a fingerprint/value no longer matches what was sealed
 *     (the document or the read value changed since this was shown to a
 *     human), then builds the transport-specific outgoing payload (a `field`
 *     array, or a built MIME message base64url-encoded into `raw` —
 *     mime-message.ts).
 *
 * The automatic path (no approval gap) calls both back to back, immediately.
 * The review path calls only the first at proposal-submission time (so the
 * proposal/ticket never carries attachment bytes) and the second — via
 * commitments.ts's `executeCommitted` — only after a human approves, right
 * before the downstream tool call.
 *
 * A single refusal reason is returned as soon as any step fails — no partial
 * resolution, no "attach what you can."
 */

import type { IntegrationManager } from './integration-manager';
import { getManifest } from './manifest-loader';
import { getProfile } from '@hap/core';
import {
  validateDocumentReferences,
  validateInsertReferences,
} from './attachment-reference';
import { isAttachmentSourceAllowed } from './attachment-policy';
import { resolveDocumentReference, type ResolvedDocument } from './document-source';
import { resolveInsertValue, applyInserts, type ResolvedInsert } from './insert-values';
import { buildMimeMessage, toBase64Url } from './mime-message';
import type { DiscoveredTool } from './integration-manager';

export interface SealedAttachment {
  connector: string;
  kind: string;
  id: string;
  filename: string;
  contentType: string;
  sha256: string;
  bytes: number;
}

export interface SealedInsert {
  placeholder: string;
  connector: string;
  kind: string;
  /** The record id this value was read from — kept so execution time can
   *  re-resolve the SAME value (finalizeAttachmentsForExecution) rather
   *  than trusting the sealed `value` string alone. */
  id: string;
  value: string;
}

export interface AttachmentResolutionOk {
  ok: true;
  args: Record<string, unknown>;
  sealed?: { attachments: SealedAttachment[]; inserts: SealedInsert[] };
  /**
   * "mime-raw" transport only: rebuilds the MIME message from the CURRENT
   * args. The message folds the text into `raw`, so anything the gateway adds
   * to the text after finalize — the ticket link (receipt-footer.ts) — must be
   * followed by this, or the sent message silently drops it.
   */
  rebuildTransport?: (args: Record<string, unknown>) => Record<string, unknown>;
}

export interface AttachmentResolutionRefusal {
  ok: false;
  message: string;
}

export type AttachmentResolutionResult = AttachmentResolutionOk | AttachmentResolutionRefusal;

/**
 * "Resolve for display" — resolves `tool`'s own `attachmentsArg`/
 * `insertFields` (if declared) against `args`, against the SELECTED
 * mandate's own allowed-sources scope value. A fast, allocation-free no-op
 * (`{ ok: true, args }` unchanged) when the tool declares neither — every
 * other gated tool is unaffected. Does not embed attachment bytes into the
 * returned args — see {@link finalizeAttachmentsForExecution} for that.
 */
export async function resolveAttachmentsAndInserts(
  integrationManager: IntegrationManager,
  tool: Pick<DiscoveredTool, 'integrationId' | 'namespacedName' | 'gating'>,
  profileId: string,
  args: Record<string, unknown>,
  /**
   * The SELECTED authorization's own resolved value for
   * attachment-policy.ts's `ATTACHMENT_SOURCES_FIELD` scope field, when one
   * is available (undefined for a profile that doesn't declare it, or a
   * mandate that leaves it unset — isAttachmentSourceAllowed then refuses
   * every attachment, fail-closed).
   */
  allowedSourcesValue?: string,
): Promise<AttachmentResolutionResult> {
  const attachmentsArg = tool.gating?.attachmentsArg;
  const insertFields = tool.gating?.insertFields;
  if (!attachmentsArg && !insertFields?.length) return { ok: true, args };

  const refsResult = attachmentsArg ? validateDocumentReferences(args[attachmentsArg]) : { ok: true as const, refs: [] };
  if (!refsResult.ok) {
    return { ok: false, message: `Refused: ${tool.namespacedName}'s attachments ${refsResult.error.message}` };
  }
  const insertResult = validateInsertReferences(args.insert);
  if (!insertResult.ok) {
    return { ok: false, message: `Refused: ${tool.namespacedName}'s insert ${insertResult.error.message}` };
  }

  const sealedAttachments: SealedAttachment[] = [];
  if (refsResult.refs.length > 0) {
    const profile = getProfile(profileId);
    for (const ref of refsResult.refs) {
      const policy = isAttachmentSourceAllowed(profileId, profile, allowedSourcesValue, ref);
      if (!policy.allowed) {
        return { ok: false, message: `Refused: attachment "${ref.connector}:${ref.kind}" is not allowed. ${policy.reason}` };
      }
      const resolved = await resolveDocumentReference(integrationManager, ref);
      if (!resolved.ok) {
        return { ok: false, message: `Refused: could not resolve attachment "${ref.connector}:${ref.kind}/${ref.id}" — ${resolved.error.message}` };
      }
      sealedAttachments.push({
        connector: ref.connector,
        kind: ref.kind,
        id: ref.id,
        filename: resolved.doc.filename,
        contentType: resolved.doc.contentType,
        sha256: resolved.doc.sha256,
        bytes: resolved.doc.bytes,
      });
    }
  }

  const sealedInserts: SealedInsert[] = [];
  const resolvedInserts: ResolvedInsert[] = [];
  if (insertResult.refs.length > 0) {
    for (const ref of insertResult.refs) {
      const resolved = await resolveInsertValue(integrationManager, ref);
      if (!resolved.ok) {
        return { ok: false, message: `Refused: could not resolve insert "${ref.connector}:${ref.kind}/${ref.id}" for "${ref.placeholder}" — ${resolved.error.message}` };
      }
      resolvedInserts.push(resolved.insert);
      sealedInserts.push({ placeholder: ref.placeholder, connector: ref.connector, kind: ref.kind, id: ref.id, value: resolved.insert.value });
    }
  }

  let outgoing: Record<string, unknown> = { ...args };

  if (insertFields?.length) {
    // Always run — even with ZERO resolved inserts — so a stray
    // `{{placeholder}}` left in the text with no `insert` entry at all is
    // caught (applyInserts' own "placeholder in the text, no insert"
    // refusal), not just the "insert supplied but doesn't match" case.
    const fields: Record<string, string> = {};
    for (const field of insertFields) {
      fields[field] = typeof args[field] === 'string' ? (args[field] as string) : '';
    }
    const applied = applyInserts(fields, resolvedInserts);
    if (!applied.ok) {
      return { ok: false, message: `Refused: ${tool.namespacedName}'s insert — ${applied.error.message}` };
    }
    outgoing = { ...outgoing, ...applied.fields };
  } else if (insertResult.refs.length > 0) {
    // `insert` was supplied but this tool declares no insertable fields at all.
    return { ok: false, message: `Refused: ${tool.namespacedName} does not declare any insertable text fields.` };
  }

  if (attachmentsArg) delete outgoing[attachmentsArg];
  delete outgoing.insert;

  // NOTE: no transport payload is built here — see finalizeAttachmentsForExecution.
  // `sealedAttachments` carries fingerprints only, never bytes.

  return {
    ok: true,
    args: outgoing,
    ...(sealedAttachments.length > 0 || sealedInserts.length > 0
      ? { sealed: { attachments: sealedAttachments, inserts: sealedInserts } }
      : {}),
  };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v));
  if (typeof value === 'string' && value) return [value];
  return [];
}

/**
 * Finalizes a call already carrying `ATTACHMENTS_SEALED_META_KEY` (set by
 * {@link resolveAttachmentsAndInserts}) into the actual outgoing payload:
 * re-resolves every sealed attachment/insert reference FRESH and refuses if
 * anything no longer matches what was sealed (the document changed, or the
 * inserted value changed, since this was shown to a human — item 2/3 of
 * "emails carry documents by reference"), then builds the transport-
 * specific payload (field array or MIME `raw`).
 *
 * A no-op (`{ ok: true, args }` unchanged) when `args` carries no sealed
 * meta, or an empty one — nothing to finalize. Safe to call unconditionally
 * before executing ANY gated write.
 */
export async function finalizeAttachmentsForExecution(
  integrationManager: IntegrationManager,
  integrationId: string,
  args: Record<string, unknown>,
): Promise<AttachmentResolutionResult> {
  const sealed = (args as Record<string, unknown>)[ATTACHMENTS_SEALED_META_KEY] as
    | { attachments: SealedAttachment[]; inserts: SealedInsert[] }
    | undefined;
  if (!sealed || (sealed.attachments.length === 0 && sealed.inserts.length === 0)) {
    return { ok: true, args };
  }

  const resolvedDocs: ResolvedDocument[] = [];
  for (const a of sealed.attachments) {
    const resolved = await resolveDocumentReference(integrationManager, { connector: a.connector, kind: a.kind, id: a.id });
    if (!resolved.ok) {
      return {
        ok: false,
        message: `Refused: could not re-resolve attachment "${a.filename}" (${a.connector}:${a.kind}/${a.id}) at execution — ${resolved.error.message}`,
      };
    }
    if (resolved.doc.sha256 !== a.sha256) {
      return {
        ok: false,
        message: `Refused: attachment "${a.filename}" (${a.connector}:${a.kind}/${a.id}) changed since this was approved — its fingerprint no longer matches.`,
      };
    }
    resolvedDocs.push(resolved.doc);
  }

  for (const i of sealed.inserts) {
    const resolved = await resolveInsertValue(integrationManager, { connector: i.connector, kind: i.kind, id: i.id, placeholder: i.placeholder });
    if (!resolved.ok) {
      return {
        ok: false,
        message: `Refused: could not re-resolve the inserted value for "${i.placeholder}" (${i.connector}:${i.kind}/${i.id}) at execution — ${resolved.error.message}`,
      };
    }
    if (resolved.insert.value !== i.value) {
      return {
        ok: false,
        message: `Refused: the value inserted for "${i.placeholder}" (${i.connector}:${i.kind}/${i.id}) changed since this was approved.`,
      };
    }
  }

  let outgoing: Record<string, unknown> = { ...args };
  if (resolvedDocs.length > 0) {
    const manifest = getManifest(integrationId);
    const transport = manifest?.attachments;
    if (!transport) {
      // Validated at manifest-load time (invalidManifestAttachmentsReason) —
      // this is defence in depth, not expected to be reachable.
      return { ok: false, message: `Refused: "${integrationId}" declares no attachments transport.` };
    }
    if (transport.transport === 'field') {
      outgoing[transport.arg] = resolvedDocs.map(d => ({
        filename: d.filename,
        contentType: d.contentType,
        contentBase64: d.contentBase64,
      }));
    } else {
      const arg = transport.arg;
      const attachments = resolvedDocs.map(d => ({ filename: d.filename, contentType: d.contentType, contentBase64: d.contentBase64 }));
      const withRaw = (a: Record<string, unknown>): Record<string, unknown> => ({
        ...a,
        [arg]: toBase64Url(buildMimeMessage({
          to: toStringArray(a.to),
          cc: toStringArray(a.cc),
          subject: typeof a.subject === 'string' ? a.subject : '',
          bodyText: typeof a.body === 'string' ? a.body : '',
          attachments,
        })),
      });
      return { ok: true, args: withRaw(outgoing), rebuildTransport: withRaw };
    }
  }

  return { ok: true, args: outgoing };
}

/** Meta key `resolveAttachmentsAndInserts` attaches for local display only
 *  (the ticket view's "what was on the card") — never a valid argument on
 *  the downstream tool. Same convention/removal pattern as AU10's
 *  `_source` (request-context.ts's `stripSourceLink`). */
export const ATTACHMENTS_SEALED_META_KEY = '_attachmentsSealed';

export function stripAttachmentsSealedMeta<T extends Record<string, unknown>>(args: T): T {
  if (!(ATTACHMENTS_SEALED_META_KEY in args)) return args;
  const { [ATTACHMENTS_SEALED_META_KEY]: _omit, ...rest } = args;
  return rest as T;
}
