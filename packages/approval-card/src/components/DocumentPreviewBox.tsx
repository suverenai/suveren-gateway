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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { documentBytes, documentDataUrl, pageCountLabel, shortFingerprint, type DocumentPreviewData } from '../lib/document-preview';
import { blobType, cleanDisplayText, decideShown, previewKind, type ShownPreview } from '../lib/attachment-media';

/**
 * A `blob:` URL for the document. Browsers refuse to open a `data:` URL as a
 * top-level page (Chrome, Safari: a new tab stays blank — found 2026-10-18 on
 * the first real invoice), so "Open full preview" must point at a blob. Falls
 * back to the data URL where blobs are unavailable (tests without a DOM).
 */
function useDocumentUrl(doc: DocumentPreviewData, enabled: boolean): string | null {
  const url = useMemo(() => {
    if (!enabled) return null;
    // The blob gets the allowed, normalised type — never the connector's raw
    // claim — so a file that says "text/html" can never be opened as a page.
    const type = blobType(doc.contentType) ?? doc.contentType;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') {
      return documentDataUrl({ contentBase64: doc.contentBase64, contentType: type });
    }
    return URL.createObjectURL(new Blob([documentBytes(doc)], { type }));
  }, [doc.contentBase64, doc.contentType, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

/**
 * Decides, from the bytes themselves, whether and how a file is shown — see
 * lib/attachment-media.ts. A legacy caller (the invoice's own PDF, no sealed
 * fingerprint) keeps the plain PDF path with no async step.
 */
function useShown(doc: DocumentPreviewData, sealedSha256: string | undefined): ShownPreview | 'checking' {
  const legacyPdf = sealedSha256 === undefined && previewKind(doc.contentType) === 'pdf';
  const [shown, setShown] = useState<ShownPreview | 'checking'>('checking');
  useEffect(() => {
    if (legacyPdf) return;
    let live = true;
    setShown('checking');
    decideShown(doc.contentType, documentBytes(doc), sealedSha256)
      .then((r) => { if (live) setShown(r); })
      .catch(() => { if (live) setShown({ status: 'not_shown', reason: 'This file could not be checked, so it is not shown.' }); });
    return () => { live = false; };
  }, [doc.contentBase64, doc.contentType, sealedSha256, legacyPdf]);
  return legacyPdf ? { status: 'ok', kind: 'pdf' } : shown;
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
  /** The fingerprint that was sealed. When given, the bytes are hashed in the
   *  browser and shown only if they match it. */
  sealedSha256?: string;
  /** Shown under the file name (e.g. "file name given by the AI"). */
  filenameNote?: ReactNode;
  /** Connector warnings, system data (blue box). Fixed sentences written by the connector. */
  warnings?: string[];
}

export function DocumentPreviewBox({ doc, systemName, heading, sourceLine, trailingNote, sealedSha256, filenameNote, warnings }: DocumentPreviewBoxProps) {
  const shown = useShown(doc, sealedSha256);
  const ok = shown !== 'checking' && shown.status === 'ok' ? shown : null;
  const dataUrl = useDocumentUrl(doc, ok !== null);
  const pages = pageCountLabel(doc.pages);
  const renderedBy = systemName ? `Rendered by ${systemName}` : 'Rendered';
  const defaultTrailingNote = (
    <>{renderedBy} from the template and the values above. Not issued yet — no number is used until you approve.</>
  );
  const kind = ok?.kind;
  const stacked = kind === 'image' || kind === 'video' || kind === 'text';
  const filename = cleanDisplayText(doc.filename);

  let body: ReactNode = null;
  if (shown === 'checking') {
    body = <p className="preview-note" data-testid="document-checking">Checking the file…</p>;
  } else if (shown.status === 'mismatch') {
    // UI spec — red only for a failed check, always ✕ + bold.
    body = (
      <p className="preview-note" data-testid="document-mismatch" style={{ color: 'var(--check-failed)', fontWeight: 700 }}>
        &#10005; the file does not match what was sealed, so it is not shown
      </p>
    );
  } else if (shown.status === 'not_shown') {
    body = <p className="preview-note" data-testid="document-not-shown">{shown.reason}</p>;
  } else if (dataUrl) {
    if (kind === 'image') {
      // <img> never runs scripts from the file; no referrer, no alt text from the file.
      body = <img className="document-preview-media" src={dataUrl} alt="" referrerPolicy="no-referrer" data-testid="document-image" />;
    } else if (kind === 'video') {
      body = (
        <video className="document-preview-media" src={dataUrl} controls preload="metadata" playsInline data-testid="document-video">
          <p className="preview-note">This browser can&apos;t play the video inline.</p>
        </video>
      );
    } else if (kind === 'text' && shown.text) {
      // Put on the page as a text node: never parsed as markup, Markdown is not rendered.
      body = (
        <>
          <pre className="document-preview-text" tabIndex={0} data-testid="document-text">{shown.text.text}</pre>
          {shown.text.truncated && <p className="preview-note">Showing the first characters only.</p>}
        </>
      );
    } else {
      body = (
        <object
          data={dataUrl}
          type={doc.contentType}
          className="document-preview-frame"
          aria-label={`Preview of ${filename}`}
        >
          <p className="preview-note">
            This browser can&apos;t preview the PDF inline. <a href={dataUrl} target="_blank" rel="noreferrer">Open full preview</a>.
          </p>
        </object>
      );
    }
  }

  return (
    <div className="document-preview-box" data-testid="document-preview">
      <h4>{heading ?? 'The PDF as it will be issued'}</h4>
      <div className={`document-preview-body${stacked ? ' document-preview-body-stacked' : ''}`}>
        {body}
        <div className="document-preview-meta">
          <div className="document-preview-filename">{filename}</div>
          {filenameNote && <div className="preview-note">{filenameNote}</div>}
          {pages && <div className="preview-note">{pages}</div>}
          {sourceLine && <div className="preview-note">{sourceLine}</div>}
          <div className="preview-note">
            Fingerprint <span className="id-raw" title={doc.sha256}>{shortFingerprint(doc.sha256)}</span>
          </div>
          {dataUrl && <a href={dataUrl} target="_blank" rel="noreferrer">Open full preview</a>}
          {(trailingNote !== null) && <p className="preview-note">{trailingNote ?? defaultTrailingNote}</p>}
        </div>
      </div>
      {warnings && warnings.length > 0 && <DocumentWarnings warnings={warnings} systemName={systemName} />}
    </div>
  );
}

/** Connector warnings: system data, same blue treatment as other values the system supplied. */
export function DocumentWarnings({ warnings, systemName }: { warnings: string[]; systemName?: string }) {
  const clean = warnings.map((w) => cleanDisplayText(w, 300)).filter(Boolean);
  if (clean.length === 0) return null;
  return (
    <div className="document-warnings" data-testid="document-warnings">
      <div className="document-warnings-head">{systemName ? `From ${systemName}` : 'From the system'} — {clean.length === 1 ? 'warning' : 'warnings'}</div>
      <ul>
        {clean.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </div>
  );
}
