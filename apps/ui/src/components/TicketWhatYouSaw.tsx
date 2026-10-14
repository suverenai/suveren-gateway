/**
 * TicketWhatYouSaw — "What you saw", the ticket's companion box to
 * TicketWhatWasDone (AU6) for a committed (review-mode) proposal
 * (doc/au10-request-context.md §4 + §8.4; mockup
 * temp/au10-mockup/index.html variant 6).
 *
 * Fetches this device's own local snapshot (`GET
 * /proposal-status/:id/shown-snapshot`) — never a fresh read of the
 * downstream systems, which could show something that has since changed
 * (the mockup's own point: CRM stock moved from 4 to 0 after approval, and
 * this box still shows exactly what was read at decision time) — AND the
 * proposal itself, to read its `shownHashes` map (one entry PER DECIDER;
 * suveren-as proposal-store.ts). Compares the local snapshot's hash against
 * THIS gateway's signed-in user's own entry (lib/au10-shown-view.ts
 * `matchShownHashEntry`) — never claims "verified" without that check
 * actually running, same discipline as lib/ticket-what-was-done.ts.
 */
import { useEffect, useState } from 'react';
import { spClient, type ShownSnapshotResponse, type Proposal, type IntegrationManifest } from '../lib/sp-client';
import { previewBoxView } from '../lib/approval-preview-view';
import { requestBlockView, historyBlockView } from '../lib/request-context-view';
import { RenderedPreviewView as RenderedBody } from './RenderedPreviewView';
import { RenderedCreationView } from './RenderedCreationView';
import { systemDisplayName, splitTool } from '../lib/approval-view';
import { matchShownHashEntry, shownStatus, otherApproversNote, formatReadAt } from '../lib/au10-shown-view';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  proposalId: string;
  tool: string;
  manifests?: IntegrationManifest[];
}

export function TicketWhatYouSaw({ proposalId, tool, manifests }: Props) {
  const { user, domain } = useAuth();
  const [resp, setResp] = useState<ShownSnapshotResponse | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setResp(null);
    setProposal(null);
    setFailed(false);
    Promise.all([spClient.getShownSnapshot(proposalId), spClient.getProposal(proposalId)])
      .then(([snapshotResp, prop]) => { if (live) { setResp(snapshotResp); setProposal(prop); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [proposalId]);

  if (failed || !resp || !proposal) return null; // never a block — same spirit as the live card's boxes

  const offDevice = resp.status === 'off_device';
  const { entry, otherCount } = matchShownHashEntry(proposal.shownHashes, user?.id ?? '', domain);
  const status = shownStatus({
    offDevice,
    recordedHash: entry?.hash,
    localHash: resp.status === 'ok' ? resp.shownHash : undefined,
  });
  const othersNote = otherApproversNote(otherCount);

  if (offDevice) {
    return (
      <div className="ticket-box ticket-shown-off-device" data-testid="au10-shown" data-shown-status="off-device">
        <h4>What you saw</h4>
        <p className="ticket-done-note">Only on the approving gateway — this device has no local copy.</p>
      </div>
    );
  }

  const { snapshot } = resp;
  const { integrationId } = splitTool(tool);
  const systemName = systemDisplayName(integrationId, manifests);
  const previewView = previewBoxView(snapshot.preview, systemName);
  const request = requestBlockView(snapshot.requestContext.request);
  const history = historyBlockView(snapshot.requestContext.history);

  return (
    <div className={`ticket-box ticket-shown-${status}`} data-testid="au10-shown" data-shown-status={status}>
      <h4>
        What you saw (read {formatReadAt(snapshot.readAt)})
        {status === 'verified' && <span className="src-tag src-tag-sealed">verified</span>}
        {status === 'mismatch' && <span className="src-tag src-tag-danger">does not match what was approved</span>}
      </h4>

      {previewView.creation && (
        <>
          <div className="ticket-sub-head">{previewView.heading} — as shown</div>
          <RenderedCreationView view={previewView.creation} />
        </>
      )}
      {previewView.rendered && (
        <>
          <div className="ticket-sub-head">{previewView.heading} — as shown</div>
          <RenderedBody rendered={previewView.rendered} />
        </>
      )}

      {request.state === 'ok' && (
        <>
          <div className="ticket-sub-head">Request — {request.tag}</div>
          {request.metaLine && <p className="au10-req-meta">{request.metaLine}{request.title ? ` — "${request.title}"` : ''}</p>}
        </>
      )}

      {history.state === 'ok' && (
        <>
          <div className="ticket-sub-head">History — read by the gateway</div>
          <ul className="au10-hist-list">
            {history.items.map((item, i) => (
              <li className="au10-hist-item" key={i}>
                <div className="au10-hist-head"><span>{item.headLabel}</span><span>{item.at}</span></div>
                {item.title && <div className="au10-hist-title">{item.title}</div>}
                <p className="au10-hist-attrib">{item.attribution}</p>
              </li>
            ))}
          </ul>
        </>
      )}

      {status === 'verified' && (
        <p className="ticket-done-note ticket-done-note-ok">
          &#10003; This exact context is bound by hash — any change after the fact would break the ticket.
        </p>
      )}
      {status === 'mismatch' && (
        <p className="ticket-done-note ticket-done-note-bad">
          &#9888; This does NOT match what the Authority Server recorded for this decision.
        </p>
      )}
      {status === 'unchecked' && (
        <p className="ticket-done-note ticket-done-note-neutral">
          This device's copy of what was shown, kept locally — the Authority Server for this ticket does not
          record a hash for you to check it against.
        </p>
      )}
      {/* AU10 §8.4 coordinator decision — several required approvers each
          record their OWN entry; only "your" entry is ever shown as
          verified/mismatch, never someone else's. */}
      {othersNote && <p className="ticket-done-note ticket-done-note-neutral" data-testid="au10-shown-others">{othersNote}</p>}
    </div>
  );
}
