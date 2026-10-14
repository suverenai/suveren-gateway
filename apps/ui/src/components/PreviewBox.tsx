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
 *
 * The RESOLVED-data rendering lives in {@link PreviewBoxBody} (a pure
 * function of `resp`/`systemName`/`toolArgs`/`sealed`, no fetch, no loading
 * state) so the ticket view's "What you saw" (TicketWhatYouSaw.tsx, AU10
 * §8.4) can render the SAME markup from a stored snapshot instead of
 * reimplementing it — "so it can't drift" (doc §8.4).
 */
import { useEffect, useState } from 'react';
import { spClient, type PreviewResponse } from '../lib/sp-client';
import { previewBoxView } from '../lib/approval-preview-view';
import { RenderedPreviewView as RenderedBody } from './RenderedPreviewView';
import { RenderedCreationView } from './RenderedCreationView';

export interface PreviewBoxBodyProps {
  resp: PreviewResponse;
  systemName: string;
  /** AU8 — the proposal's own bound args, needed ONLY to render a several-
   *  reads ("What will be created") preview; absent/undecrypted is fine
   *  (that preview then renders with nothing to merge, same as no reads). */
  toolArgs?: Record<string, unknown> | null;
  /** AU8 follow-up — PE1's own `content.sealed`, so the "What will be
   *  created" box can show the same sealed + "end-to-end encrypted" marker
   *  the "What will be sent" box shows (ApprovalBody.tsx), instead of
   *  inventing a second convention for it. */
  sealed?: boolean;
}

/** The pure, resolved-data render — same output for the live card and the
 *  ticket's "What you saw" snapshot. See the module doc comment. */
export function PreviewBoxBody({ resp, systemName, toolArgs, sealed }: PreviewBoxBodyProps) {
  const view = previewBoxView(resp, systemName, toolArgs ?? undefined);
  const tone = resp.status === 'ok' ? (view.stale ? 'stale' : 'ok') : resp.status;

  // No preview declared: the card shows what will be sent, open, right above —
  // so this is only a short note, not a box competing with the content.
  if (tone === 'none') {
    return (
      <p className="preview-note" data-testid="approval-preview" data-preview-status="none">{view.note}</p>
    );
  }

  return (
    <div className={`preview-box preview-box-${tone}`} data-testid="approval-preview" data-preview-status={tone}>
      <h4>
        {view.heading}
        {view.creation && (
          sealed
            ? <><span className="src-tag src-tag-sealed">sealed</span> <span className="lock-tag">end-to-end encrypted</span></>
            : <span className="src-tag src-tag-sealed">sealed</span>
        )}
      </h4>
      {view.creation && <RenderedCreationView view={view.creation} />}
      {view.rendered && <RenderedBody rendered={view.rendered} />}
      <p className="preview-note">{view.note}</p>
      {view.versionNote && !view.stale && <p className="preview-note">{view.versionNote}</p>}
      {view.stale && (
        <div className="preview-stale">
          <h5>{view.stale.heading}</h5>
          {view.stale.unchangedNote ? (
            <p className="preview-note">{view.stale.unchangedNote}</p>
          ) : (
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
              <dt>{view.stale.approvedLabel}</dt>
              <dd><RenderedBody rendered={view.stale.approvedRendered!} /></dd>
              <dt>{view.stale.currentLabel}</dt>
              <dd><RenderedBody rendered={view.stale.currentRendered!} /></dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  proposalId: string;
  systemName: string;
  toolArgs?: Record<string, unknown> | null;
  sealed?: boolean;
  /** Told the box's state once known (ok | stale | none | unavailable | not_found)
   *  so the card can decide whether the bound values are shown open. */
  onTone?: (tone: string) => void;
  /** AU10 §8.4 — told the RAW response every time it changes (including
   *  `null` while loading, and a synthesized `unavailable` on fetch
   *  failure), so the card can assemble the exact "what you saw" snapshot
   *  from the SAME data this box renders — never a second read. */
  onData?: (resp: PreviewResponse | null) => void;
}

export function PreviewBox({ proposalId, systemName, toolArgs, sealed, onTone, onData }: Props) {
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
  // this box never blocks Approve/Reject, it only has less to say. Counted as
  // "unavailable" on data-preview-status — the e2e harness only distinguishes
  // what it can act on (none/unavailable/not_found/ok/stale), not WHY the
  // fetch itself never answered.
  useEffect(() => {
    if (failed) { onTone?.('unavailable'); onData?.({ status: 'unavailable', reason: 'connector_error' }); return; }
    if (!resp) { onData?.(null); return; }
    const v = previewBoxView(resp, systemName, toolArgs ?? undefined);
    onTone?.(resp.status === 'ok' ? (v.stale ? 'stale' : 'ok') : resp.status);
    onData?.(resp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resp, failed, systemName, onTone, onData]);

  if (failed) {
    return (
      <div className="preview-box preview-box-unavailable" data-testid="approval-preview" data-preview-status="unavailable">
        <h4>Preview not available</h4>
        <p className="preview-note">Preview not available on this gateway.</p>
      </div>
    );
  }

  if (!resp) {
    return (
      <div className="preview-box preview-box-loading" data-testid="approval-preview" data-preview-status="loading" aria-busy="true">
        Reading from {systemName}…
      </div>
    );
  }

  return <PreviewBoxBody resp={resp} systemName={systemName} toolArgs={toolArgs} sealed={sealed} />;
}
