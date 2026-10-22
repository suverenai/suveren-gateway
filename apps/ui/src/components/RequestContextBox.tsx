/**
 * AU10 — "Request" + "History" blocks on the approval card
 * (doc/au10-request-context.md §3; mockup temp/au10-mockup/index.html).
 * Fetches the gateway-internal read for one proposal and renders it through
 * the pure, tested lib/request-context-view.ts — this component only maps
 * that output to JSX, same split PreviewBox.tsx uses for AU8.
 *
 * Neither block ever gates Approve/Reject — a missing/invalid/unreachable
 * read always degrades to a visible note, never a block (doc §0).
 *
 * The RESOLVED-data rendering lives in {@link RequestContextBoxBody} (a pure
 * function of `resp`, no fetch) so the ticket view's "What you saw"
 * (TicketWhatYouSaw.tsx, AU10 §8.4) can render the SAME markup from a
 * stored snapshot instead of reimplementing it — "so it can't drift"
 * (doc §8.4), including every non-'ok' state ("No request linked.", "no
 * customer link", etc.) the live card shows.
 */
import { useEffect, useState } from 'react';
import { spClient, type RequestContextResponse } from '../lib/sp-client';
import { requestBlockView, historyBlockView } from '../lib/request-context-view';

function RequestInner({ req }: { req: ReturnType<typeof requestBlockView> }) {
  return req.state !== 'ok' ? (
    <p className="au10-req-state">{req.note}</p>
  ) : (
    <>
      {req.implicitNote && (
        <p className="au10-req-meta" style={{ marginTop: '-0.1rem' }}>{req.implicitNote}</p>
      )}
      {req.metaLine && <p className="au10-req-meta">{req.metaLine}</p>}
      {req.title && <p className="au10-req-meta"><b>{req.title}</b></p>}
      {req.bodyFirst && <p className="au10-req-quote">{req.bodyFirst}</p>}
      {req.bodyMore && (
        <details>
          <summary>Show more</summary>
          <p className="au10-req-quote">{req.bodyMore}</p>
        </details>
      )}
      {req.attribution && <p className="au10-req-attrib">{req.attribution}</p>}
      {req.chain.length > 0 && (
        <details className="au10-chain">
          <summary>Earlier in this thread ({req.chain.length})</summary>
          {req.chain.map((c, i) => (
            <div className="au10-chain-item" key={i}>
              {(c.author || c.at) && (
                <p className="au10-req-meta">
                  {c.author ? <>from <b>{c.author}</b></> : null}{c.author && c.at ? ' · ' : ''}{c.at}
                </p>
              )}
              {c.title && <p className="au10-req-meta"><b>{c.title}</b></p>}
              {c.body && <p className="au10-req-quote">{c.body}</p>}
              {c.author && <p className="au10-req-attrib">— from {c.author}, not checked</p>}
            </div>
          ))}
        </details>
      )}
    </>
  );
}

function HistoryInner({ hist }: { hist: ReturnType<typeof historyBlockView> }) {
  return hist.state !== 'ok' ? (
    <p className="au10-hist-state">{hist.note}</p>
  ) : (
    <>
      {hist.matchNotes.map((note, i) => (
        <p className="preview-note" key={i} style={{ marginTop: 0 }}>{note}</p>
      ))}
      <ul className="au10-hist-list">
        {hist.items.map((item, i) => (
          <li className="au10-hist-item" key={i}>
            <div className="au10-hist-head">
              <span>
                {item.aiWritten && <span className="au10-dot au10-dot-ai" />}
                {item.headLabel}
              </span>
              <span>{item.at}</span>
            </div>
            {item.title && <div className="au10-hist-title">{item.title}</div>}
            {item.body && <div className="au10-hist-body">{item.body}</div>}
            <p className="au10-hist-attrib">{item.attribution}</p>
          </li>
        ))}
      </ul>
      {hist.unreachableNote && <p className="preview-note">{hist.unreachableNote}</p>}
    </>
  );
}

/** The pure, resolved-data render — same output for the live card and the
 *  ticket's "What you saw" snapshot. See the module doc comment. */
export function RequestContextBoxBody({ resp }: { resp: RequestContextResponse }) {
  const req = requestBlockView(resp.request);
  const hist = historyBlockView(resp.history);

  return (
    <>
      <div
        className={`preview-box preview-box-ai`}
        data-testid="au10-request"
        data-request-status={req.state}
      >
        <h4>
          Request
          {/* AU10 F3 — the SAME tag regardless of implicit/explicit: an
              implicit link (manifest sourceFromArg, e.g. in_reply_to) is
              still the AI's own choice of what it's replying to — not
              checked, same as an explicit _source (contract + mockup case 5).
              Only present for state 'ok' — "No request linked." etc. get no tag. */}
          {req.tag && <span className="src-tag src-tag-ai">{req.tag}</span>}
        </h4>
        <RequestInner req={req} />
      </div>

      <div
        className={`preview-box ${hist.state === 'unreachable' ? 'preview-box-unreachable' : 'preview-box-sys'}`}
        data-testid="au10-history"
        data-history-status={hist.state}
      >
        <h4>
          History
          {/* AU10 F2 — shown in EVERY state (not just ok): the reader must
              always know who produced this block, even when there's nothing
              to show (no customer link, not reachable, nothing recent). */}
          <span className="src-tag src-tag-system">{hist.label}</span>
        </h4>
        <HistoryInner hist={hist} />
      </div>
    </>
  );
}

const CHEV = (
  <svg className="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
);

/** One line for the folded History row: how many entries, or why there are none. */
export function historySummary(hist: ReturnType<typeof historyBlockView>): string {
  if (hist.state !== 'ok') return hist.note;
  const n = hist.items.length;
  const latest = hist.items[0];
  return `${n} ${n === 1 ? 'entry' : 'entries'}${latest?.at ? ` · latest ${latest.at}` : ''}`;
}

/** One line for the folded Request row. */
export function requestSummary(req: ReturnType<typeof requestBlockView>): string {
  if (req.state !== 'ok') return req.note ?? '';
  return req.title ?? req.metaLine ?? '';
}

/**
 * UI spec §17.3 — Request and History as two folded rows (one line each,
 * chevron, no frames). Same data and the same wording as the boxes above;
 * only the form differs. `order` places them among the card's other rows.
 */
export function RequestContextFolds({ resp }: { resp: RequestContextResponse }) {
  const req = requestBlockView(resp.request);
  const hist = historyBlockView(resp.history);
  return (
    <>
      <details className="av3-fold" style={{ order: 12 }} data-testid="au10-request" data-request-status={req.state}>
        <summary>
          <span className="h">Request</span>
          <span className="one">{requestSummary(req)}</span>
          {CHEV}
        </summary>
        <div className="av3-fold-body">
          {req.tag && <p className="au10-req-meta"><span className="src-tag src-tag-ai" style={{ marginLeft: 0 }}>{req.tag}</span></p>}
          <RequestInner req={req} />
        </div>
      </details>
      <details className="av3-fold" style={{ order: 13 }} data-testid="au10-history" data-history-status={hist.state}>
        <summary>
          <span className="h">History</span>
          <span className="one">{historySummary(hist)}</span>
          {CHEV}
        </summary>
        <div className="av3-fold-body">
          <p className="au10-req-meta"><span className="src-tag src-tag-system" style={{ marginLeft: 0 }}>{hist.label}</span></p>
          <HistoryInner hist={hist} />
        </div>
      </details>
    </>
  );
}

interface Props {
  proposalId: string;
  /** AU10 §8.4 — told the RAW response every time it changes (including
   *  `null` while loading/unavailable), so the card can assemble the exact
   *  "what you saw" snapshot from the SAME data this box renders. */
  onData?: (resp: RequestContextResponse | null) => void;
  /** 'folds' = the approval card's two folded rows (UI spec §17.3); default = the boxes. */
  layout?: 'boxes' | 'folds';
}

export function RequestContextBox({ proposalId, onData, layout = 'boxes' }: Props) {
  const [resp, setResp] = useState<RequestContextResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setResp(null);
    setFailed(false);
    spClient.getProposalRequestContext(proposalId)
      .then((r) => { if (live) setResp(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [proposalId]);

  useEffect(() => {
    onData?.(failed ? null : resp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resp, failed, onData]);

  if (failed || !resp) {
    // Never a block — same spirit as PreviewBox's own loading/unavailable
    // fallback. Kept minimal: this box only ever ADDS information.
    return null;
  }

  return layout === 'folds' ? <RequestContextFolds resp={resp} /> : <RequestContextBoxBody resp={resp} />;
}
