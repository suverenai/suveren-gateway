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
import { Fragment, useEffect, useState } from 'react';
import { spClient, type PreviewResponse } from '../lib/sp-client';
import { previewBoxView } from '../lib/approval-preview-view';
import { RenderedPreviewView as RenderedBody } from './RenderedPreviewView';
import { RenderedCreationView, SystemBoxes } from './RenderedCreationView';
import type { RecordChange } from '../lib/record-change';

/** An update shown as its change: the changed fields old → new, what else is
 *  sent, and the record's unchanged fields folded (never as if they changed). */
function RecordChangeView({ change, systemName }: { change: RecordChange; systemName: string }) {
  return (
    <>
      <table className="compare-table" data-testid="change-table">
        <thead><tr><th /><th>Now (from {systemName})</th><th>New</th></tr></thead>
        <tbody>
          {change.lines.map((l) => (
            <tr key={l.key} data-testid="change-row">
              <td className="compare-label">{l.label}</td>
              <td className="compare-now">{l.now}</td>
              <td className="compare-new">{l.next}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {change.also.length > 0 && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.4rem 0' }} data-testid="change-also">
          {change.also.map((a) => (
            <Fragment key={a.key}>
              <dt style={{ color: 'var(--text-tertiary)' }}>{a.label}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-word' }}><span className="src-tag-value src-tag-sealed-cell">{a.value}</span></dd>
            </Fragment>
          ))}
        </dl>
      )}
      {change.unchanged.totalFields > 0 && (
        <details className="change-unchanged" data-testid="change-unchanged">
          <summary>Unchanged in {systemName} ({change.unchanged.fields.length + change.unchanged.moreFields.length}) <span className="src-tag src-tag-system">from the system</span></summary>
          <RenderedBody rendered={change.unchanged} />
        </details>
      )}
    </>
  );
}

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
  /** Render the display-only system boxes after the preview (default). The
   *  approval card (UI spec §17) places them itself, outside the sealed tile. */
  systemBoxes?: boolean;
  /** Fields of a single-read preview body to leave out (the card shows them elsewhere). */
  omitKeys?: readonly string[];
  /** Leave the "read by the gateway" source line out (the card shows it under Technical details). */
  hideNote?: boolean;
}

/** `resp` without the named fields of its structured body (a copy; never mutates). */
function withoutKeys(resp: PreviewResponse, keys: readonly string[] | undefined): PreviewResponse {
  if (!keys?.length || resp.status !== 'ok' || !('body' in resp) || !resp.body.structured) return resp;
  const structured = Object.fromEntries(Object.entries(resp.body.structured).filter(([k]) => !keys.includes(k)));
  return { ...resp, body: { ...resp.body, structured }, ...(resp.fields ? { fields: resp.fields.filter((f) => !keys.includes(f)) } : {}) } as PreviewResponse;
}

/** The pure, resolved-data render — same output for the live card and the
 *  ticket's "What you saw" snapshot. See the module doc comment. */
export function PreviewBoxBody({ resp: rawResp, systemName, toolArgs, sealed, systemBoxes = true, omitKeys, hideNote = false }: PreviewBoxBodyProps) {
  const resp = withoutKeys(rawResp, omitKeys);
  const view = previewBoxView(resp, systemName, toolArgs ?? undefined);
  const tone = resp.status === 'ok' ? (view.stale ? 'stale' : 'ok') : resp.status;

  // No preview declared: the card shows what will be sent, open, right above —
  // so this is only a short note, not a box competing with the content.
  if (tone === 'none') {
    return (
      <p className="sr-only" data-testid="approval-preview" data-preview-status="none">{view.note}</p>
    );
  }

  return (
    <>
    <div className={`preview-box preview-box-${tone}`} data-testid="approval-preview" data-preview-status={tone}>
      <h4>
        {view.heading}
        {(view.creation || view.change) && (
          sealed
            ? <><span className="src-tag src-tag-sealed">sealed</span></>
            : <span className="src-tag src-tag-sealed">sealed</span>
        )}
      </h4>
      {view.creation && <RenderedCreationView view={view.creation} systemName={systemName} />}
      {view.change && <RecordChangeView change={view.change} systemName={systemName} />}
      {view.rendered && <RenderedBody rendered={view.rendered} />}
      {view.note && !hideNote && <p className="preview-note">{view.note}</p>}
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
    {systemBoxes && view.creation && <SystemBoxes view={view.creation} />}
    </>
  );
}

interface Props {
  proposalId: string;
  systemName: string;
  toolArgs?: Record<string, unknown> | null;
  sealed?: boolean;
  /** See {@link PreviewBoxBodyProps.systemBoxes}. */
  systemBoxes?: boolean;
  omitKeys?: readonly string[];
  hideNote?: boolean;
  /** Told the box's state once known (ok | stale | none | unavailable | not_found)
   *  so the card can decide whether the bound values are shown open. */
  onTone?: (tone: string) => void;
  /** AU10 §8.4 — told the RAW response every time it changes (including
   *  `null` while loading, and a synthesized `unavailable` on fetch
   *  failure), so the card can assemble the exact "what you saw" snapshot
   *  from the SAME data this box renders — never a second read. */
  onData?: (resp: PreviewResponse | null) => void;
}

/** The live preview fetch for one proposal, and the tone/data it reports to
 *  the card. Separate from the render so the card can place the box where its
 *  content belongs (inside the sealed tile, or after it) without a refetch. */
export function useProposalPreview(
  proposalId: string,
  systemName: string,
  toolArgs: Record<string, unknown> | null | undefined,
  onTone?: (tone: string) => void,
  onData?: (resp: PreviewResponse | null) => void,
  /** False while the card cannot read the proposal yet: nothing is fetched. */
  enabled = true,
): PreviewState {
  const [resp, setResp] = useState<PreviewResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setResp(null);
    setFailed(false);
    if (!enabled) return;
    spClient.getProposalPreview(proposalId)
      .then((r) => { if (live) setResp(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [proposalId, enabled]);

  // The preview fetch itself failed (network/auth, not a connector answer).
  // Decision 2: the bound values are shown elsewhere on the card regardless —
  // this box never blocks Approve/Reject, it only has less to say. Counted as
  // "unavailable" on data-preview-status — the e2e harness only distinguishes
  // what it can act on (none/unavailable/not_found/ok/stale), not WHY the
  // fetch itself never answered.
  useEffect(() => {
    if (!enabled) return;
    if (failed) { onTone?.('unavailable'); onData?.({ status: 'unavailable', reason: 'connector_error' }); return; }
    if (!resp) { onData?.(null); return; }
    const v = previewBoxView(resp, systemName, toolArgs ?? undefined);
    onTone?.(resp.status === 'ok' ? (v.stale ? 'stale' : 'ok') : resp.status);
    onData?.(resp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resp, failed, systemName, onTone, onData, enabled]);

  return { resp, failed };
}

export interface PreviewState { resp: PreviewResponse | null; failed: boolean }

type ShowProps = Omit<PreviewBoxBodyProps, 'resp'> & { state: PreviewState };

/** Loading / failed / resolved — the box for a {@link useProposalPreview} state. */
export function PreviewBoxShow({ state, ...rest }: ShowProps) {
  if (state.failed) {
    return (
      <div className="preview-box preview-box-unavailable" data-testid="approval-preview" data-preview-status="unavailable">
        <h4>Preview not available</h4>
        <p className="preview-note">Preview not available on this gateway.</p>
      </div>
    );
  }
  if (!state.resp) {
    return (
      <div className="preview-box preview-box-loading" data-testid="approval-preview" data-preview-status="loading" aria-busy="true">
        Reading from {rest.systemName}…
      </div>
    );
  }
  return <PreviewBoxBody resp={state.resp} {...rest} />;
}

export function PreviewBox({ proposalId, systemName, toolArgs, sealed, systemBoxes, omitKeys, hideNote, onTone, onData }: Props) {
  const state = useProposalPreview(proposalId, systemName, toolArgs, onTone, onData);
  return <PreviewBoxShow state={state} systemName={systemName} toolArgs={toolArgs} sealed={sealed} systemBoxes={systemBoxes} omitKeys={omitKeys} hideNote={hideNote} />;
}
