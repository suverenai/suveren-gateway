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

// ─── UI spec §15.2/§15.3 — live attachment preview ─────────────────────────
// The bytes shown on the card never travel on the proposal/ticket itself
// (only the fingerprint does — SealedAttachmentDisplay above); they are
// fetched live, through the gateway, from the SOURCE each time the card is
// open (apps/mcp-server/src/lib/document-source.ts `resolveAttachmentPreview`,
// reached via control-plane's `/proposal-status/:id/attachment-preview/:sha256`
// or `/api/evidence/receipt/:id/attachment-preview/:sha256`). This module
// only shapes the already-fetched result for display — never does the fetch
// itself (same split as every other lib/*.ts here).

/** Mirrors the gateway's `AttachmentPreviewStatus` (document-source.ts) —
 *  duplicated for the same cross-package reason as `SealedAttachmentDisplay`
 *  above. */
export type AttachmentPreviewResult =
  | { status: 'ok'; filename: string; contentType: string; contentBase64: string; sha256: string; bytes: number }
  | { status: 'changed'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'error'; message: string };

/** A manifest's own `documents` declaration — only the part the UI needs
 *  (the display label template); never the read tool/args, which stay
 *  server-side. */
export interface DocumentManifestLike {
  id: string;
  documents?: Record<string, { label?: string }>;
}

/**
 * UI spec §15.2 — "from <connector> — <label>". Substitutes the ONLY
 * recognized placeholder, `{id}`, into the source manifest's
 * `documents.<kind>.label` template (e.g. `"issued invoice {id}"` ->
 * `"issued invoice 2026-0003"`). Returns `undefined` when the connector
 * declares no `documents.<kind>` at all, or no `label` on it — an
 * attachment that isn't a declared document kind (or one with no label)
 * just shows "from <connector>" with nothing after it, and gets no "same
 * file as issued..." checks-line entry (see `attachmentSameFileCheck`).
 */
export function documentLabel(
  manifests: DocumentManifestLike[] | undefined,
  connector: string,
  kind: string,
  id: string,
): string | undefined {
  const template = manifests?.find((m) => m.id === connector)?.documents?.[kind]?.label;
  if (!template) return undefined;
  return template.replace(/\{id\}/g, id);
}

/**
 * UI spec §15.2 — the checks-line entry "same file as issued <label>",
 * derived from the LIVE preview fetch's own comparison against the sealed
 * fingerprint (never recomputed here — `preview.status` already IS that
 * comparison's result, from `resolveAttachmentPreview`). `null` while the
 * fetch hasn't resolved yet, has no document label to name, or answered
 * with something other than a clean match/mismatch (`unavailable`/
 * `not_found`/`error`) — there is nothing positive OR negative to assert in
 * those cases, so nothing is shown rather than a check that didn't really run.
 */
export function attachmentSameFileCheck(
  label: string | undefined,
  preview: AttachmentPreviewResult | 'loading' | undefined,
): LimitCheckLike | null {
  if (!label || !preview || preview === 'loading') return null;
  if (preview.status === 'ok') {
    return { key: 'attachment-same-file', label: `same file as issued ${label}`, ok: true, valueText: '', limitText: '' };
  }
  if (preview.status === 'changed') {
    return { key: 'attachment-same-file', label: 'attachment changed since it was sealed', ok: false, valueText: '', limitText: '' };
  }
  return null;
}
