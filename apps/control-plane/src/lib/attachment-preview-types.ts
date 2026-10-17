/**
 * UI spec §15.2 — the approval/ticket card's attachment preview. Mirrors
 * mcp-server's document-source.ts `AttachmentPreviewStatus` (duplicated
 * rather than imported — control-plane does not depend on
 * @suveren/mcp-server, same cross-package reason apps/ui/src/lib/
 * attachment-sealed.ts duplicates the sealed-meta shapes).
 */

export type AttachmentPreviewResult =
  | { status: 'ok'; filename: string; contentType: string; contentBase64: string; sha256: string; bytes: number }
  | { status: 'changed'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'error'; message: string };

export interface SealedAttachmentRef {
  connector: string;
  kind: string;
  id: string;
  sha256: string;
}

/** Mirrors apps/mcp-server/src/lib/attachment-resolution.ts's
 *  `ATTACHMENTS_SEALED_META_KEY` — same duplication reason as above. */
export const ATTACHMENTS_SEALED_META_KEY = '_attachmentsSealed';

/**
 * Finds the sealed attachment entry on `toolArgs`/an archived call's own
 * arguments whose SEALED sha256 is `sha256` — never trusts a caller-named
 * connector/kind/id directly (the AI never reaches this route at all, but
 * even the UI only ever supplies the fingerprint it is already showing; the
 * connector/kind/id to re-resolve come from the proposal/ticket's OWN sealed
 * meta, looked up here). `null` when there is no such entry — the caller
 * must not forward anything to the MCP server in that case.
 */
export function findSealedAttachment(
  toolArgs: Record<string, unknown> | null | undefined,
  sha256: string,
): SealedAttachmentRef | null {
  if (!toolArgs) return null;
  const raw = toolArgs[ATTACHMENTS_SEALED_META_KEY];
  if (raw === null || typeof raw !== 'object') return null;
  const attachments = (raw as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    if (a === null || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (
      r.sha256 === sha256 &&
      typeof r.connector === 'string' &&
      typeof r.kind === 'string' &&
      typeof r.id === 'string'
    ) {
      return { connector: r.connector, kind: r.kind, id: r.id, sha256 };
    }
  }
  return null;
}
