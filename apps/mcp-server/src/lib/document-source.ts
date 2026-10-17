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

import { createHash } from 'node:crypto';
import type { IntegrationManager } from './integration-manager';
import { getManifest } from './manifest-loader';
import { readPreview } from './preview';
import { substitute } from './request-context';
import type { DocumentReference } from './tool-gating-types';

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
}

export type DocumentResolutionError =
  | { code: 'UNKNOWN_CONNECTOR'; message: string }
  | { code: 'UNDECLARED_KIND'; message: string }
  | { code: 'NOT_INTERNAL'; message: string }
  | { code: 'UNAVAILABLE'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'MALFORMED_RESULT'; message: string }
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
  const read = await readPreview(integrationManager, ref.connector, docConfig.tool, args);
  if (read.status === 'not_found') {
    return { ok: false, error: { code: 'NOT_FOUND', message: read.message ?? `No document "${ref.kind}"/"${ref.id}" on "${ref.connector}".` } };
  }
  if (read.status !== 'ok') {
    return { ok: false, error: { code: 'UNAVAILABLE', message: read.message ?? `Connector "${ref.connector}" could not be reached.` } };
  }

  const body = read.body.structured;
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

  let bytes: Buffer;
  try {
    bytes = Buffer.from(contentBase64, 'base64');
  } catch {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: '"contentBase64" is not valid base64.' } };
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

  return { ok: true, doc: { filename, contentType, contentBase64, sha256: computedSha256, bytes: bytes.byteLength } };
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
