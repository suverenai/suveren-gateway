/**
 * UI spec §15.2 — "Email with an attachment": a sealed box per attachment
 * (filename, size, "from <connector>" + what it is, short fingerprint — a
 * live PDF preview only when the gateway happened to hand this box the
 * bytes, which the sealed meta itself never carries — see the module doc
 * comment) and a sealed box per inserted value ("From <system> — inserted
 * by the gateway", value in `--prov-system`). Reuses DocumentPreviewBox's
 * CSS (`.document-preview-box` et al., `--prov-sealed` frame) for the
 * attachment box and `.preview-box.preview-box-sys` (`--prov-system` frame)
 * for the insert box — same tokens/classes as §15.1's document preview and
 * AU8's system-provenance boxes, never a new hue.
 *
 * Absent entirely when the call sealed neither (the common case — most
 * gated tools declare no attachmentsArg/insertFields at all); the caller
 * (ApprovalBody.tsx / the ticket view) is expected to pass whatever
 * `extractAttachmentsSealed` returned without checking emptiness itself.
 */
import { shortFingerprint, documentDataUrl } from '../lib/document-preview';
import { humanFileSize, type SealedAttachmentDisplay, type SealedInsertDisplay } from '../lib/attachment-sealed';
import { systemDisplayName } from '../lib/approval-view';
import type { IntegrationManifest } from '../lib/sp-client';

export interface AttachmentsSealedBoxProps {
  attachments: SealedAttachmentDisplay[];
  inserts: SealedInsertDisplay[];
  manifests?: IntegrationManifest[];
  /**
   * An attachment's own bytes, keyed by its sealed sha256 — ONLY ever
   * populated when this exact file is ALSO the subject of another box this
   * same card already fetched bytes for (e.g. the invoice this email
   * attaches, shown moments earlier on the invoice-issuing card's own §15.1
   * preview — AU8's cross-reference is not wired yet, so this is always
   * empty today; see the task report). Never fetched here — this component
   * does no I/O of its own, by design (the sealed meta never carries bytes).
   */
  knownBytesBySha256?: Record<string, { contentBase64: string; contentType: string }>;
}

function AttachmentBox({ a, manifests, knownBytesBySha256 }: {
  a: SealedAttachmentDisplay;
  manifests?: IntegrationManifest[];
  knownBytesBySha256?: Record<string, { contentBase64: string; contentType: string }>;
}) {
  const systemName = systemDisplayName(a.connector, manifests);
  const known = knownBytesBySha256?.[a.sha256];
  const dataUrl = known ? documentDataUrl({ contentType: known.contentType, contentBase64: known.contentBase64 }) : null;

  return (
    <div className="document-preview-box" data-testid="attachment-sealed">
      <h4>Attachment</h4>
      <div className="document-preview-body">
        {dataUrl && a.contentType === 'application/pdf' ? (
          <object data={dataUrl} type={a.contentType} className="document-preview-frame" aria-label={`Preview of ${a.filename}`}>
            <p className="preview-note">This browser can&apos;t preview the PDF inline.</p>
          </object>
        ) : null}
        <div className="document-preview-meta">
          <div className="document-preview-filename">{a.filename}</div>
          <div className="preview-note">{humanFileSize(a.bytes)}</div>
          <div className="preview-note">
            <span className="src-tag-value src-tag-system-cell">from {systemName}</span>
          </div>
          <div className="preview-note">
            Fingerprint <span className="id-raw" title={a.sha256}>{shortFingerprint(a.sha256)}</span>
          </div>
          {dataUrl && <a href={dataUrl} target="_blank" rel="noreferrer">Open full preview</a>}
        </div>
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

export function AttachmentsSealedBox({ attachments, inserts, manifests, knownBytesBySha256 }: AttachmentsSealedBoxProps) {
  if (attachments.length === 0 && inserts.length === 0) return null;
  return (
    <>
      {attachments.map((a) => (
        <AttachmentBox key={`${a.connector}:${a.kind}:${a.id}`} a={a} manifests={manifests} knownBytesBySha256={knownBytesBySha256} />
      ))}
      {inserts.map((i) => (
        <InsertBox key={`${i.placeholder}:${i.connector}:${i.kind}:${i.id}`} i={i} manifests={manifests} />
      ))}
    </>
  );
}
