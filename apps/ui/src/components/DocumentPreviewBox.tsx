/**
 * UI spec §15.1 — the approval card's sealed "The PDF as it will be
 * issued" box, for a `create_invoice`/`create_credit_note`-shaped proposal
 * whose manifest declares a `kind: "document"` preview read (e.g. the ERP
 * connector's own `preview_invoice` — suveren-invoicing-plan.md §7).
 *
 * Renders the real PDF via the browser's own viewer (`<object>` on a
 * `data:` URL) rather than a generated thumbnail image — no heavy new
 * dependency, per the plan's decision; see `lib/document-preview.ts` for
 * the pure data shaping this component only maps to JSX.
 *
 * Absent entirely when the connector declares no document preview (e.g.
 * simulation mode, or create_credit_note today — the ERP connector has no
 * preview_credit_note) — the caller (`RenderedCreationView.tsx`) simply
 * does not render this component in that case.
 */
import { documentDataUrl, pageCountLabel, shortFingerprint, type DocumentPreviewData } from '../lib/document-preview';

export interface DocumentPreviewBoxProps {
  doc: DocumentPreviewData;
  /** Who rendered it, for "Rendered by {systemName}…" — falls back to a
   *  system-agnostic phrasing when absent (e.g. a ticket snapshot that
   *  didn't carry it). */
  systemName?: string;
}

export function DocumentPreviewBox({ doc, systemName }: DocumentPreviewBoxProps) {
  const dataUrl = documentDataUrl(doc);
  const pages = pageCountLabel(doc.pages);
  const renderedBy = systemName ? `Rendered by ${systemName}` : 'Rendered';

  return (
    <div className="document-preview-box" data-testid="document-preview">
      <h4>The PDF as it will be issued</h4>
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
          <div className="preview-note">
            Fingerprint <span className="id-raw" title={doc.sha256}>{shortFingerprint(doc.sha256)}</span>
          </div>
          <a href={dataUrl} target="_blank" rel="noreferrer">Open full preview</a>
          <p className="preview-note">
            {renderedBy} from the template and the values above. Not issued yet — no number is used until you approve.
          </p>
        </div>
      </div>
    </div>
  );
}
