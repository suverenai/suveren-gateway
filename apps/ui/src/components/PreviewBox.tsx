/**
 * The approval card's "From <System>, before it runs" box (AU5,
 * work-plan.md "Added 2026-10-09"). Fetches the gateway-internal preview for
 * one proposal and renders it through the pure, tested
 * lib/approval-preview-view.ts + lib/preview-render.ts — this component only
 * maps that output to JSX, never parses the response itself.
 *
 * Every branch keeps the bound values visible elsewhere on the card and
 * Approve/Reject enabled (decisions 2–3, temp/briefs/au3-au5-brief.md) — this
 * box only ever ADDS information, never gates the buttons.
 */
import { Fragment, useEffect, useState } from 'react';
import { spClient, type PreviewResponse } from '../lib/sp-client';
import { previewBoxView } from '../lib/approval-preview-view';
import type { PreviewFieldRow, RenderedPreview } from '../lib/preview-render';

function FieldRows({ rows }: { rows: PreviewFieldRow[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.4rem 0' }}>
      {rows.map((r) => (
        <Fragment key={r.key}>
          <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{r.label}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-word' }}>
            {r.lines ? (
              <div>{r.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
            ) : r.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function RenderedBody({ rendered }: { rendered: RenderedPreview }) {
  if (rendered.kind === 'empty') {
    return <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', margin: '0.4rem 0' }}>No fields returned.</p>;
  }
  if (rendered.kind === 'text') {
    return <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', margin: '0.4rem 0' }}>{rendered.text}</div>;
  }
  return (
    <>
      <FieldRows rows={rendered.fields} />
      {rendered.moreFields.length > 0 && (
        <details style={{ fontSize: '0.8rem' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)' }}>All fields ({rendered.totalFields})</summary>
          <FieldRows rows={rendered.moreFields} />
        </details>
      )}
    </>
  );
}

interface Props {
  proposalId: string;
  systemName: string;
}

export function PreviewBox({ proposalId, systemName }: Props) {
  const [resp, setResp] = useState<PreviewResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setResp(null);
    setFailed(false);
    spClient.getProposalPreview(proposalId)
      .then((r) => { if (live) setResp(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [proposalId]);

  // The preview fetch itself failed (network/auth, not a connector answer).
  // Decision 2: the bound values are shown elsewhere on the card regardless —
  // this box never blocks Approve/Reject, it only has less to say.
  if (failed) {
    return (
      <div className="preview-box preview-box-unavailable">
        <h4>Preview not available</h4>
        <p className="preview-note">Preview not available on this gateway.</p>
      </div>
    );
  }

  if (!resp) {
    return (
      <div className="preview-box preview-box-loading" aria-busy="true">
        Reading from {systemName}…
      </div>
    );
  }

  const view = previewBoxView(resp, systemName);
  const tone = resp.status === 'ok' ? (view.stale ? 'stale' : 'ok') : resp.status;

  return (
    <div className={`preview-box preview-box-${tone}`}>
      <h4>{view.heading}</h4>
      {view.rendered && <RenderedBody rendered={view.rendered} />}
      <p className="preview-note">{view.note}</p>
      {view.versionNote && !view.stale && <p className="preview-note">{view.versionNote}</p>}
      {view.stale && (
        <div className="preview-stale">
          <h5>{view.stale.heading}</h5>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
            <dt>{view.stale.approvedLabel}</dt>
            <dd><RenderedBody rendered={view.stale.approvedRendered} /></dd>
            <dt>{view.stale.currentLabel}</dt>
            <dd><RenderedBody rendered={view.stale.currentRendered} /></dd>
          </dl>
        </div>
      )}
    </div>
  );
}
