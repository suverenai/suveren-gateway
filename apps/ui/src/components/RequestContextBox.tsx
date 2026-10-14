/**
 * AU10 — "Request" + "History" blocks on the approval card
 * (doc/au10-request-context.md §3; mockup temp/au10-mockup/index.html).
 * Fetches the gateway-internal read for one proposal and renders it through
 * the pure, tested lib/request-context-view.ts — this component only maps
 * that output to JSX, same split PreviewBox.tsx uses for AU8.
 *
 * Neither block ever gates Approve/Reject — a missing/invalid/unreachable
 * read always degrades to a visible note, never a block (doc §0).
 */
import { useEffect, useState } from 'react';
import { spClient, type RequestContextResponse } from '../lib/sp-client';
import { requestBlockView, historyBlockView } from '../lib/request-context-view';

interface Props {
  proposalId: string;
}

export function RequestContextBox({ proposalId }: Props) {
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

  if (failed || !resp) {
    // Never a block — same spirit as PreviewBox's own loading/unavailable
    // fallback. Kept minimal: this box only ever ADDS information.
    return null;
  }

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
        {req.state !== 'ok' ? (
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
        )}
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
        {hist.state !== 'ok' ? (
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
        )}
      </div>
    </>
  );
}
