/**
 * UI spec §15.2 — "Email with an attachment": a sealed box per attachment
 * (live first-page preview + "Open", filename, size, "from <connector> —
 * <document label>" (`--prov-system`), short fingerprint) and a sealed box
 * per inserted value ("From <system> — inserted by the gateway", value in
 * `--prov-system`). The attachment's preview reuses DocumentPreviewBox
 * (§15.1's own component) — same classes/tokens, never a new hue — under
 * its own heading ("Attachment") and source line.
 *
 * The preview bytes are fetched LIVE through `fetchPreview` (never stored on
 * the proposal/ticket — the sealed meta this component receives only ever
 * carries fingerprints; see lib/attachment-sealed.ts's module doc comment),
 * once per attachment, on mount. A caller that passes no `fetchPreview`
 * (none today) gets the sealed fields with no preview — never an error.
 *
 * Absent entirely when the call sealed neither an attachment nor an insert
 * (the common case — most gated tools declare no attachmentsArg/
 * insertFields at all); the caller (ApprovalBody.tsx / the ticket view) is
 * expected to pass whatever `extractAttachmentsSealed` returned without
 * checking emptiness itself.
 */
import { useEffect, useState } from 'react';
import { DocumentPreviewBox } from './DocumentPreviewBox';
import {
  humanFileSize,
  documentLabel,
  attachmentSameFileCheck,
  type SealedAttachmentDisplay,
  type SealedInsertDisplay,
  type AttachmentPreviewResult,
  type LimitCheckLike,
} from '../lib/attachment-sealed';
import { shortFingerprint } from '../lib/document-preview';
import { systemDisplayName } from '../lib/approval-view';
import type { IntegrationManifest } from '../lib/sp-client';

export interface AttachmentsSealedBoxProps {
  attachments: SealedAttachmentDisplay[];
  inserts: SealedInsertDisplay[];
  manifests?: IntegrationManifest[];
  /** UI spec §15.2 — fetches one attachment's live preview by its sealed
   *  sha256 (control-plane's `/proposal-status/:id/attachment-preview/:sha256`
   *  for a pending proposal, `/api/evidence/receipt/:id/attachment-preview/:sha256`
   *  for an opened ticket — see ApprovalBody.tsx / TicketWhatWasDone.tsx for
   *  which one each passes). Omitted entirely: no live preview is fetched,
   *  the sealed fields alone are shown. */
  fetchPreview?: (sha256: string) => Promise<AttachmentPreviewResult>;
  /** Told the FULL set of checks-line entries every one of this card's
   *  attachments currently contributes ("same file as …"), every
   *  time any of their own preview fetches resolve — same pattern as
   *  PreviewBox's `onTone`/`onData`. Never called when there is nothing to
   *  add (an empty array still counts as "told"). */
  onChecks?: (checks: LimitCheckLike[]) => void;
}

function AttachmentBox({ a, manifests, preview }: {
  a: SealedAttachmentDisplay;
  manifests?: IntegrationManifest[];
  preview: AttachmentPreviewResult | 'loading' | undefined;
}) {
  const systemName = systemDisplayName(a.connector, manifests);
  const label = documentLabel(manifests, a.connector, a.kind, a.id);
  const sourceLine = (
    <>
      <span className="src-tag-value src-tag-system-cell">from {systemName}</span>
      {label ? <> — {label}</> : null}
    </>
  );

  if (preview && preview !== 'loading' && preview.status === 'ok') {
    return (
      <DocumentPreviewBox
        doc={{ filename: preview.filename, contentType: preview.contentType, contentBase64: preview.contentBase64, sha256: preview.sha256 }}
        heading="Attachment"
        sourceLine={sourceLine}
        trailingNote={null}
      />
    );
  }

  // Loading, or a preview that came back changed/unavailable/not_found/error
  // — never show bytes that might not be the sealed ones; the sealed fields
  // (filename/size/fingerprint) are always safe to show regardless, since
  // they are exactly what was shown and signed at the time this was sealed.
  return (
    <div className="document-preview-box" data-testid="attachment-sealed">
      <h4>Attachment</h4>
      <div className="document-preview-meta">
        <div className="document-preview-filename">{a.filename}</div>
        <div className="preview-note">{humanFileSize(a.bytes)}</div>
        <div className="preview-note">{sourceLine}</div>
        <div className="preview-note">
          Fingerprint <span className="id-raw" title={a.sha256}>{shortFingerprint(a.sha256)}</span>
        </div>
        {!preview || preview === 'loading' ? (
          <div className="preview-note">Loading preview…</div>
        ) : preview.status === 'changed' ? (
          // UI spec — red only for a failed check, always ✕ + bold.
          <p className="preview-note" data-testid="attachment-changed" style={{ color: 'var(--check-failed)', fontWeight: 700 }}>
            &#10005; changed since it was sealed
          </p>
        ) : (
          <div className="preview-note">Preview not available.</div>
        )}
      </div>
    </div>
  );
}

function InsertBox({ i, manifests }: { i: SealedInsertDisplay; manifests?: IntegrationManifest[] }) {
  const systemName = systemDisplayName(i.connector, manifests);
  return (
    <div className="preview-box preview-box-sys" data-testid="insert-sealed">
      <h4>From {systemName} — inserted by the gateway</h4>
      <div style={{ color: 'var(--prov-system)', fontWeight: 600, wordBreak: 'break-word' }}>{i.value}</div>
    </div>
  );
}

export function AttachmentsSealedBox({ attachments, inserts, manifests, fetchPreview, onChecks }: AttachmentsSealedBoxProps) {
  const [previews, setPreviews] = useState<Record<string, AttachmentPreviewResult | 'loading'>>({});

  useEffect(() => {
    if (!fetchPreview) return;
    let live = true;
    for (const a of attachments) {
      setPreviews((prev) => (prev[a.sha256] ? prev : { ...prev, [a.sha256]: 'loading' }));
      fetchPreview(a.sha256)
        .then((result) => { if (live) setPreviews((prev) => ({ ...prev, [a.sha256]: result })); })
        .catch(() => { if (live) setPreviews((prev) => ({ ...prev, [a.sha256]: { status: 'unavailable', message: 'Could not fetch the preview.' } })); });
    }
    return () => { live = false; };
    // Re-fetch only when the set of sealed attachments itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments.map((a) => a.sha256).join(','), fetchPreview]);

  useEffect(() => {
    if (!onChecks) return;
    const checks = attachments
      .map((a) => attachmentSameFileCheck(documentLabel(manifests, a.connector, a.kind, a.id), previews[a.sha256]))
      .filter((c): c is LimitCheckLike => c !== null);
    onChecks(checks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, manifests, previews, onChecks]);

  if (attachments.length === 0 && inserts.length === 0) return null;
  return (
    <>
      {attachments.map((a) => (
        <AttachmentBox key={`${a.connector}:${a.kind}:${a.id}`} a={a} manifests={manifests} preview={previews[a.sha256]} />
      ))}
      {inserts.map((i) => (
        <InsertBox key={`${i.placeholder}:${i.connector}:${i.kind}:${i.id}`} i={i} manifests={manifests} />
      ))}
    </>
  );
}
