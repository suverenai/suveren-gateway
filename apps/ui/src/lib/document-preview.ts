/**
 * UI spec §15.1 — "The PDF as it will be issued" box: pure, shape-checked
 * extraction of a document-preview read's structured result into display
 * data. Generic across connectors by SHAPE, not tool name: any read a
 * manifest declares `kind: "document"` on (tool-gating-types.ts
 * `PreviewReadConfig.kind`) is expected to answer with
 * `{ filename, contentType, contentBase64, sha256, pages? }` — the same
 * shape the ERP connector's own `preview_invoice`/`get_document` answer
 * with (suveren-invoicing-plan.md §7) — but this module never assumes
 * which connector or tool produced it.
 *
 * Deliberately has no React/DOM import — `document-preview.test.ts` covers
 * it directly; `DocumentPreviewBox.tsx` only maps its output to JSX.
 */

export interface DocumentPreviewData {
  filename: string;
  contentType: string;
  contentBase64: string;
  sha256: string;
  /** Absent when the connector's read doesn't report a page count (e.g.
   *  `get_document`, which reads the already-archived file). */
  pages?: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Shape guard for a document-preview read's `structured` result. Narrow on
 * purpose — a connector that answers with extra fields still passes; one
 * missing a required field does not, so a malformed answer degrades to "no
 * preview" rather than rendering a broken box.
 */
export function isDocumentPreviewBody(body: unknown): body is DocumentPreviewData {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b.filename)) return false;
  if (!isNonEmptyString(b.contentType)) return false;
  if (!isNonEmptyString(b.contentBase64)) return false;
  if (!isNonEmptyString(b.sha256)) return false;
  if (b.pages !== undefined && typeof b.pages !== 'number') return false;
  return true;
}

/**
 * The short fingerprint shown on the card (mockup: "a41f…9c2e") — first 4
 * and last 4 characters of the hex digest, never the full value (that
 * stays available via the title attribute / "Open full preview").
 * Hashes shorter than 9 characters are returned unabridged rather than
 * producing an overlapping or empty middle.
 */
export function shortFingerprint(sha256: string): string {
  if (sha256.length <= 9) return sha256;
  return `${sha256.slice(0, 4)}…${sha256.slice(-4)}`;
}

/** A `data:` URL for the browser's own PDF renderer (`<object>`/`<iframe>`)
 *  — no blob URL lifecycle to manage, at the cost of ~33% size overhead
 *  versus a blob; acceptable for an invoice-sized PDF (see
 *  suveren-invoicing-plan.md §7's "no heavy new dependency" decision). */
export function documentDataUrl(doc: Pick<DocumentPreviewData, 'contentType' | 'contentBase64'>): string {
  return `data:${doc.contentType};base64,${doc.contentBase64}`;
}

/** "1 page" / "3 pages" — singular only at exactly 1. */
export function pageCountLabel(pages: number | undefined): string | undefined {
  if (pages === undefined) return undefined;
  return pages === 1 ? '1 page' : `${pages} pages`;
}
