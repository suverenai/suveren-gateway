/**
 * UI spec §15.1 — the approval card's sealed "The PDF as it will be
 * issued" box, for a `create_invoice`/`create_credit_note`-shaped proposal
 * whose manifest declares a `kind: "document"` preview read (e.g. the ERP
 * connector's own `preview_invoice` — suveren-invoicing-plan.md §7).
 *
 * Renders the real PDF via the browser's own viewer (`<object>` on a
 * `blob:` URL) rather than a generated thumbnail image — no heavy new
 * dependency, per the plan's decision; see `lib/document-preview.ts` for
 * the pure data shaping this component only maps to JSX.
 *
 * Absent entirely when the connector declares no document preview (e.g.
 * simulation mode, or create_credit_note today — the ERP connector has no
 * preview_credit_note) — the caller (`RenderedCreationView.tsx`) simply
 * does not render this component in that case.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { documentBytes, documentDataUrl, pageCountLabel, shortFingerprint, type DocumentPreviewData } from '../lib/document-preview';

/**
 * A `blob:` URL for the document. Browsers refuse to open a `data:` URL as a
 * top-level page (Chrome, Safari: a new tab stays blank — found 2026-10-18 on
 * the first real invoice), so "Open full preview" must point at a blob. Falls
 * back to the data URL where blobs are unavailable (tests without a DOM).
 */
function useDocumentUrl(doc: DocumentPreviewData): string {
  const url = useMemo(() => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') {
      return documentDataUrl(doc);
    }
    return URL.createObjectURL(new Blob([documentBytes(doc)], { type: doc.contentType }));
  }, [doc.contentBase64, doc.contentType]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

export interface DocumentPreviewBoxProps {
  doc: DocumentPreviewData;
  /** Who rendered it, for "Rendered by {systemName}…" — falls back to a
   *  system-agnostic phrasing when absent (e.g. a ticket snapshot that
   *  didn't carry it). */
  systemName?: string;
  /** UI spec §15.2 — the attachment box reuses this same component under
   *  the heading "Attachment" instead of §15.1's own. Defaults to §15.1's
   *  original heading so that caller is unaffected. */
  heading?: string;
  /** UI spec §15.2 — "from <connector> — <label>", shown right under the
   *  filename (before the fingerprint). Absent for §15.1's own caller. */
  sourceLine?: ReactNode;
  /** Overrides the default "Rendered by X…" trailing note; pass `null` to
   *  omit it entirely (§15.2's attachment box has nothing invoice-specific
   *  to say there). `undefined` (the default) keeps §15.1's own text. */
  trailingNote?: ReactNode | null;
}

export function DocumentPreviewBox({ doc, systemName, heading, sourceLine, trailingNote }: DocumentPreviewBoxProps) {
  const dataUrl = useDocumentUrl(doc);
  const pages = pageCountLabel(doc.pages);
  const renderedBy = systemName ? `Rendered by ${systemName}` : 'Rendered';
  const defaultTrailingNote = (
    <>{renderedBy} from the template and the values above. Not issued yet — no number is used until you approve.</>
  );

  return (
    <div className="document-preview-box" data-testid="document-preview">
      <h4>{heading ?? 'The PDF as it will be issued'}</h4>
      <div className="document-preview-body">
        <object
          data={dataUrl}
          type={doc.contentType}
          className="document-preview-frame"
          aria-label={`Preview of ${doc.filename}`}
        >
          <p className="preview-note">
            This browser can&apos;t preview the PDF inline. <a href={dataUrl} target="_blank" rel="noreferrer">Open full preview</a>.
          </p>
        </object>
        <div className="document-preview-meta">
          <div className="document-preview-filename">{doc.filename}</div>
          {pages && <div className="preview-note">{pages}</div>}
          {sourceLine && <div className="preview-note">{sourceLine}</div>}
          <div className="preview-note">
            Fingerprint <span className="id-raw" title={doc.sha256}>{shortFingerprint(doc.sha256)}</span>
          </div>
          <a href={dataUrl} target="_blank" rel="noreferrer">Open full preview</a>
          {(trailingNote !== null) && <p className="preview-note">{trailingNote ?? defaultTrailingNote}</p>}
        </div>
      </div>
    </div>
  );
}
