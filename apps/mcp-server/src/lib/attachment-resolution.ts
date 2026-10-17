/**
 * Attachment/insert resolution — the single orchestration point tool-
 * proxy.ts calls for a write tool whose gating declares `attachmentsArg`
 * and/or `insertFields` (suveren-invoicing-plan.md §6/§7). Turns the AI's
 * references into the final outgoing call:
 *
 *   1. shape-check the `attachments`/`insert` arguments (refuse bytes/typed
 *      values smuggled in, never silently drop them — attachment-
 *      reference.ts);
 *   2. policy-check each attachment reference against the mandate's
 *      allowed sources (attachment-policy.ts — today always refuses, no
 *      shipped profile declares the scope field yet);
 *   3. resolve every reference (document-source.ts / insert-values.ts),
 *      computing/verifying each document's sha256 and each value's host;
 *   4. substitute resolved values into the declared text fields
 *      (insert-values.ts's `applyInserts`) — THIS is what content binding
 *      later hashes, so the sealed text already carries the final, inserted
 *      copy;
 *   5. build the transport-specific outgoing payload (a `field` array, or a
 *      built MIME message base64url-encoded into `raw` — mime-message.ts)
 *      and remove the reference-only `attachments`/`insert` keys, which are
 *      never valid arguments on the downstream tool itself.
 *
 * A single refusal reason is returned as soon as any step fails — no
 * partial resolution, no "attach what you can." The returned `sealed` block
 * is meant to be merged into the outgoing args as a `_`-prefixed meta field
 * (same convention as `_imagePreview`/`_source`), purely for local display —
 * see tool-proxy.ts's call site for exactly how it's attached.
 *
 * LIMITATION (tracked, see this task's report): called ONCE, before a
 * specific authorization is selected among several matching candidates, so
 * the policy check in step 2 cannot yet read a PARTICULAR mandate's own
 * allowed-sources value — it is always refused today because no profile
 * declares the field at all. Once a profile does, this must move to run
 * once a single authorization is chosen, so the correct mandate's value is
 * checked rather than a blanket refusal.
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
  value: string;
}

export interface AttachmentResolutionOk {
  ok: true;
  args: Record<string, unknown>;
  sealed?: { attachments: SealedAttachment[]; inserts: SealedInsert[] };
}

export interface AttachmentResolutionRefusal {
  ok: false;
  message: string;
}

export type AttachmentResolutionResult = AttachmentResolutionOk | AttachmentResolutionRefusal;

/**
 * Resolves `tool`'s own `attachmentsArg`/`insertFields` (if declared) against
 * `args`. A fast, allocation-free no-op (`{ ok: true, args }` unchanged) when
 * the tool declares neither — every other gated tool is unaffected.
 */
export async function resolveAttachmentsAndInserts(
  integrationManager: IntegrationManager,
  tool: Pick<DiscoveredTool, 'integrationId' | 'namespacedName' | 'gating'>,
  profileId: string,
  args: Record<string, unknown>,
  /**
   * The SELECTED authorization's own resolved value for
   * attachment-policy.ts's `ATTACHMENT_SOURCES_FIELD` scope field, when one
   * is available. Threaded through purely so this function is provably
   * correct end to end (tests pass a value and see an attachment resolved
   * and sent); tool-proxy.ts's current call site never supplies one — see
   * this module's header LIMITATION note — so production behaviour is
   * unchanged: every attachment is refused until that wiring lands.
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
  // Kept alongside `sealedAttachments` (same order, same length) so the
  // transport-building step below can use the actual bytes without
  // re-fetching — `sealed` is the display/local-archive summary and
  // deliberately omits `contentBase64`; this array is the one place the
  // bytes live for the rest of this call.
  const resolvedDocs: ResolvedDocument[] = [];
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
      resolvedDocs.push(resolved.doc);
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
      sealedInserts.push({ placeholder: ref.placeholder, connector: ref.connector, kind: ref.kind, value: resolved.insert.value });
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

  if (sealedAttachments.length > 0) {
    const manifest = getManifest(tool.integrationId);
    const transport = manifest?.attachments;
    if (!transport) {
      // Validated at manifest-load time (invalidManifestAttachmentsReason) —
      // this is defence in depth, not expected to be reachable.
      return { ok: false, message: `Refused: "${tool.integrationId}" declares no attachments transport.` };
    }
    if (transport.transport === 'field') {
      outgoing[transport.arg] = resolvedDocs.map(d => ({
        filename: d.filename,
        contentType: d.contentType,
        contentBase64: d.contentBase64,
      }));
    } else {
      const to = toStringArray(outgoing.to);
      const cc = toStringArray(outgoing.cc);
      const subject = typeof outgoing.subject === 'string' ? outgoing.subject : '';
      const bodyText = typeof outgoing.body === 'string' ? outgoing.body : '';
      const mime = buildMimeMessage({
        to,
        cc,
        subject,
        bodyText,
        attachments: resolvedDocs.map(d => ({ filename: d.filename, contentType: d.contentType, contentBase64: d.contentBase64 })),
      });
      outgoing[transport.arg] = toBase64Url(mime);
    }
  }

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
