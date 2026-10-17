/**
 * UI spec §15.2 — "Email with an attachment": pure extraction of the
 * `_attachmentsSealed` meta key (attachment-resolution.ts's
 * `ATTACHMENTS_SEALED_META_KEY`, gateway side) from a proposal's or a
 * ticket's toolArgs, into display-ready shapes. Never bytes — the sealed
 * meta is fingerprint-only by construction (filename/contentType/sha256),
 * same discipline as document-preview.ts's `DocumentPreviewData`.
 *
 * Deliberately has no React/DOM import — `AttachmentsSealedBox.tsx` only
 * maps this module's output to JSX, same split as document-preview.ts /
 * DocumentPreviewBox.tsx.
 */

/** Mirrors the gateway's `SealedAttachment` (attachment-resolution.ts) — kept
 *  local rather than imported, since apps/ui does not depend on apps/mcp-server. */
export interface SealedAttachmentDisplay {
  connector: string;
  kind: string;
  id: string;
  filename: string;
  contentType: string;
  sha256: string;
  bytes: number;
}

/** Mirrors the gateway's `SealedInsert`. */
export interface SealedInsertDisplay {
  placeholder: string;
  connector: string;
  kind: string;
  id: string;
  value: string;
}

export interface AttachmentsSealedMeta {
  attachments: SealedAttachmentDisplay[];
  inserts: SealedInsertDisplay[];
}

/** The meta key itself — same constant as the gateway's
 *  ATTACHMENTS_SEALED_META_KEY (attachment-resolution.ts), duplicated here
 *  rather than imported for the same cross-package reason as the types
 *  above. Kept in exactly one place in THIS package (this module) so a
 *  rename only needs one edit on this side. */
export const ATTACHMENTS_SEALED_META_KEY = '_attachmentsSealed';

function isSealedAttachment(v: unknown): v is SealedAttachmentDisplay {
  if (v === null || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return typeof a.connector === 'string' && typeof a.kind === 'string' && typeof a.id === 'string'
    && typeof a.filename === 'string' && typeof a.contentType === 'string' && typeof a.sha256 === 'string'
    && typeof a.bytes === 'number';
}

function isSealedInsert(v: unknown): v is SealedInsertDisplay {
  if (v === null || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  return typeof i.placeholder === 'string' && typeof i.connector === 'string' && typeof i.kind === 'string'
    && typeof i.id === 'string' && typeof i.value === 'string';
}

/**
 * Shape-checked extraction from a call's toolArgs. Narrow on purpose — a
 * malformed/legacy shape degrades to "nothing sealed" (empty arrays) rather
 * than rendering broken boxes; never throws.
 */
export function extractAttachmentsSealed(toolArgs: Record<string, unknown> | null | undefined): AttachmentsSealedMeta {
  const empty: AttachmentsSealedMeta = { attachments: [], inserts: [] };
  if (!toolArgs) return empty;
  const raw = toolArgs[ATTACHMENTS_SEALED_META_KEY];
  if (raw === null || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const attachments = Array.isArray(r.attachments) ? r.attachments.filter(isSealedAttachment) : [];
  const inserts = Array.isArray(r.inserts) ? r.inserts.filter(isSealedInsert) : [];
  return { attachments, inserts };
}

/** "48 KB" / "1.2 MB" — one significant decimal above 1 KB, whole bytes below. */
export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface LimitCheckLike {
  key: string;
  label: string;
  ok: boolean;
  valueText: string;
  limitText: string;
}

/**
 * UI spec §4.2.2/§15.2 — the checks-line entry an attached document adds:
 * "attachment from an allowed source". Always `ok: true` by the time a card
 * shows it — the gateway already refused the whole call (attachment-
 * policy.ts) before any proposal/ticket carrying this meta could exist, so
 * there is nothing left for the approver to check here; this is the SAME
 * computed-not-AI-supplied discipline every other checks-line entry follows
 * (§4.2.2 — "Computed by the gateway... never AI-supplied"), just always
 * passing by construction.
 */
export function attachmentCheckEntries(toolArgs: Record<string, unknown> | null | undefined): LimitCheckLike[] {
  const sealed = extractAttachmentsSealed(toolArgs);
  if (sealed.attachments.length === 0) return [];
  return [{ key: 'attachment-source', label: 'attachment from an allowed source', ok: true, valueText: '', limitText: '' }];
}
