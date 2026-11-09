/**
 * Document sources — resolves an AI-supplied {@link DocumentReference}
 * (`{connector, kind, id}`) to actual file bytes, through the manifest's
 * declared `documents` block (suveren-invoicing-plan.md §6/§7). The
 * CONNECTOR this calls is always the one named in the reference's own
 * `connector` field — never assumed from the calling tool's own
 * integration, so an email tool can attach a document that lives on the
 * ERP connector.
 *
 * Trust model: the read tool answers `{ filename, contentType,
 * contentBase64, sha256 }`; the connector's OWN `sha256` claim is never
 * trusted blind — this module recomputes it from the actual bytes and
 * refuses on any mismatch (the same "recompute, don't just relay" discipline
 * content-binding.ts applies to a content hash).
 */

import { structuredOrJsonText } from './preview';
import { createHash } from 'node:crypto';
import type { IntegrationManager } from './integration-manager';
import { getManifest } from './manifest-loader';
import { readPreview, unavailableReadMessage } from './preview';
import { substitute } from './request-context';
import type { DocumentReference } from './tool-gating-types';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BASE64_CHARS, DOCUMENT_READ_TIMEOUT_MS, formatMiB } from './attachment-limits';

export interface ResolvedDocument {
  filename: string;
  contentType: string;
  contentBase64: string;
  /** Gateway-computed sha256 of the decoded bytes — authoritative, never
   *  the connector's own unverified claim. Formatted as plain hex (no
   *  "sha256:" prefix — this is a local integrity check, not a protocol
   *  hash format). */
  sha256: string;
  bytes: number;
  /** Sentences the connector wrote about the saved file (system data, never AI
   *  text). Absent when there are none. */
  warnings?: string[];
  /** The manifest's `aiSupplied` flag for this kind: the file name was given by
   *  the AI. Absent when false. */
  aiSupplied?: true;
}

const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 300;

/**
 * The connector's `warnings` as display-safe sentences: strings only, control
 * and bidi characters removed, bounded. Anything else is dropped.
 */
export function cleanWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_WARNING_CHARS);
    if (t) out.push(t);
    if (out.length >= MAX_WARNINGS) break;
  }
  return out;
}

export type DocumentResolutionError =
  | { code: 'UNKNOWN_CONNECTOR'; message: string }
  | { code: 'UNDECLARED_KIND'; message: string }
  | { code: 'NOT_INTERNAL'; message: string }
  | { code: 'UNAVAILABLE'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'MALFORMED_RESULT'; message: string }
  | { code: 'TOO_LARGE'; message: string }
  | { code: 'HASH_MISMATCH'; message: string };

export type DocumentResolutionResult =
  | { ok: true; doc: ResolvedDocument }
  | { ok: false; error: DocumentResolutionError };

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolves one document reference. Pure I/O orchestration — every refusal
 * reason is returned, never thrown, so a caller resolving several
 * attachments can report each one individually.
 */
export async function resolveDocumentReference(
  integrationManager: IntegrationManager,
  ref: DocumentReference,
): Promise<DocumentResolutionResult> {
  const manifest = getManifest(ref.connector);
  if (!manifest) {
    return { ok: false, error: { code: 'UNKNOWN_CONNECTOR', message: `"${ref.connector}" is not a known connector.` } };
  }
  const docConfig = manifest.documents?.[ref.kind];
  if (!docConfig) {
    return {
      ok: false,
      error: {
        code: 'UNDECLARED_KIND',
        message: `Connector "${ref.connector}" declares no document kind "${ref.kind}".`,
      },
    };
  }
  // Defence in depth — manifest-loader.ts already refuses to load a manifest
  // whose `documents` names a tool that isn't `internal: true`; this is the
  // second, independent check at resolution time (same posture as tool-
  // proxy.ts's own internal-tool refusal).
  const toolEntry = manifest.toolGating?.overrides?.[docConfig.tool] as { internal?: boolean } | null | undefined;
  if (!toolEntry?.internal) {
    return {
      ok: false,
      error: {
        code: 'NOT_INTERNAL',
        message: `Connector "${ref.connector}"'s document read "${docConfig.tool}" is not marked internal — refusing to call it for a document reference.`,
      },
    };
  }

  const args = substitute(docConfig.args, { id: ref.id });
  const read = await readPreview(integrationManager, ref.connector, docConfig.tool, args, DOCUMENT_READ_TIMEOUT_MS);
  if (read.status === 'not_found' || read.status === 'refused') {
    return { ok: false, error: { code: 'NOT_FOUND', message: read.message ?? `No document "${ref.kind}"/"${ref.id}" on "${ref.connector}".` } };
  }
  if (read.status !== 'ok') {
    const message = unavailableReadMessage(integrationManager, read, ref.connector, docConfig.tool, `documents.${ref.kind}`);
    return { ok: false, error: { code: 'UNAVAILABLE', message } };
  }

  const body = structuredOrJsonText(read.body);
  if (!body || typeof body !== 'object') {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: `Document read for "${ref.connector}:${ref.kind}" returned no structured result.` } };
  }
  const { filename, contentType, contentBase64, sha256: claimedSha256 } = body as Record<string, unknown>;
  if (typeof filename !== 'string' || !filename) {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: 'Document result is missing "filename".' } };
  }
  if (typeof contentType !== 'string' || !contentType) {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: 'Document result is missing "contentType".' } };
  }
  if (typeof contentBase64 !== 'string' || !contentBase64) {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: 'Document result is missing "contentBase64".' } };
  }

  if (contentBase64.length > MAX_ATTACHMENT_BASE64_CHARS) {
    return { ok: false, error: { code: 'TOO_LARGE', message: `The document is larger than ${formatMiB(MAX_ATTACHMENT_BYTES)}, the most one attachment may be.` } };
  }
  // Buffer.from never throws on bad base64; it skips what it cannot read. So the
  // bytes hashed below are the DECODED bytes, and the base64 handed on is
  // re-encoded from those same bytes — the connector's own string is dropped.
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.byteLength === 0) {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: '"contentBase64" is not valid base64.' } };
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: { code: 'TOO_LARGE', message: `The document is ${formatMiB(bytes.byteLength)}, larger than the ${formatMiB(MAX_ATTACHMENT_BYTES)} one attachment may be.` } };
  }
  const computedSha256 = sha256Hex(bytes);
  if (typeof claimedSha256 === 'string' && claimedSha256.length > 0 && claimedSha256 !== computedSha256) {
    return {
      ok: false,
      error: {
        code: 'HASH_MISMATCH',
        message: `Connector "${ref.connector}" claimed sha256 ${claimedSha256} for "${ref.kind}:${ref.id}" but the bytes hash to ${computedSha256}.`,
      },
    };
  }

  const warnings = cleanWarnings((body as Record<string, unknown>).warnings);
  return {
    ok: true,
    doc: {
      filename,
      contentType,
      contentBase64: bytes.toString('base64'),
      sha256: computedSha256,
      bytes: bytes.byteLength,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(docConfig.aiSupplied === true ? { aiSupplied: true as const } : {}),
    },
  };
}

/**
 * Re-resolves the SAME reference and compares against a previously-sealed
 * sha256 — the execution-time check (suveren-invoicing-plan.md §6: "refuses
 * if a sha differs from the sealed one"). Mirrors preview.ts's
 * `previewChangedSinceSubmission`: any failure to positively confirm the
 * document is UNCHANGED is treated as changed — fail closed.
 */
export async function documentChangedSinceSealing(
  integrationManager: IntegrationManager,
  ref: DocumentReference,
  sealedSha256: string,
): Promise<boolean> {
  const result = await resolveDocumentReference(integrationManager, ref);
  if (!result.ok) return true;
  return result.doc.sha256 !== sealedSha256;
}

/**
 * UI spec §15.2 — the approval/ticket card's live attachment preview. The
 * bytes shown on the card are never stored on the proposal/ticket (only the
 * fingerprint reference is sealed there — see attachment-resolution.ts's
 * `SealedAttachment`); this re-resolves THROUGH THE GATEWAY, read-only, the
 * exact same way `resolveDocumentReference` always has, and refuses to hand
 * back bytes that no longer match what was sealed — a mismatch is reported
 * as `changed`, never served under the old fingerprint (showing a DIFFERENT
 * document as if it still matched would be worse than showing nothing).
 */
export type AttachmentPreviewStatus =
  | ({ status: 'ok' } & ResolvedDocument)
  | { status: 'changed'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'error'; message: string };

export async function resolveAttachmentPreview(
  integrationManager: IntegrationManager,
  ref: DocumentReference,
  sealedSha256: string,
): Promise<AttachmentPreviewStatus> {
  const result = await resolveDocumentReference(integrationManager, ref);
  if (!result.ok) {
    switch (result.error.code) {
      case 'NOT_FOUND':
        return { status: 'not_found', message: result.error.message };
      case 'UNKNOWN_CONNECTOR':
      case 'UNDECLARED_KIND':
      case 'NOT_INTERNAL':
        // Manifest-shape problems — never expected once a call already
        // sealed this same reference, but fail descriptively, not silently.
        return { status: 'error', message: result.error.message };
      default:
        // UNAVAILABLE / HASH_MISMATCH (the connector's OWN claim vs its
        // bytes) / MALFORMED_RESULT — the connector could not be read from
        // cleanly right now.
        return { status: 'unavailable', message: result.error.message };
    }
  }
  if (result.doc.sha256 !== sealedSha256) {
    return {
      status: 'changed',
      message: `"${result.doc.filename}" (${ref.connector}:${ref.kind}/${ref.id}) changed since it was sealed — its fingerprint no longer matches.`,
    };
  }
  return { status: 'ok', ...result.doc };
}
