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
 *
 * Renders the snapshot's preview/request/history data through the EXACT
 * SAME body components the live card uses (`PreviewBoxBody`,
 * `RequestContextBoxBody`) — never a second, hand-rolled rendering of the
 * same data, so the two can't drift (2026-10-14 correction: the first
 * version here reimplemented a subset and silently dropped the bound
 * values plus every non-'ok' Request/History state).
 */
import { useEffect, useState } from 'react';
import { spClient, type ShownSnapshotResponse, type Proposal, type IntegrationManifest } from '../lib/sp-client';
import { PreviewBoxBody } from './PreviewBox';
import { RequestContextBoxBody } from './RequestContextBox';
import { systemDisplayName, splitTool } from '../lib/approval-view';
import { matchShownHashEntry, shownStatus, otherApproversNote, formatReadAt } from '../lib/au10-shown-view';
import { useAuth } from '../contexts/AuthContext';
import { ObFold } from './ObjectCard';

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
      <ObFold title="What you saw" summary="only on the approving gateway" testId="au10-shown" attrs={{ 'data-shown-status': 'off-device' }}>
        <p className="ob-quiet">Only on the approving gateway — this device has no local copy.</p>
      </ObFold>
    );
  }

  const { snapshot } = resp;
  const { integrationId } = splitTool(tool);
  const systemName = systemDisplayName(integrationId, manifests);
  const readAt = formatReadAt(snapshot.readAt);
  const summary = status === 'verified' ? `read ${readAt} · verified`
    : status === 'mismatch' ? `read ${readAt} · does not match what was approved`
    : `read ${readAt}`;

  return (
    <ObFold title="What you saw" summary={summary} testId="au10-shown" attrs={{ 'data-shown-status': status }}>
      <p className="ob-lbl">Read by the gateway at {readAt}, kept on this device — not read again now.</p>

      {/* Exactly the live card's own boxes, fed from the stored snapshot —
          same components, so rendering can never drift from the card. */}
      <PreviewBoxBody resp={snapshot.preview} systemName={systemName} toolArgs={snapshot.toolArgs} sealed={snapshot.sealed} />
      <RequestContextBoxBody resp={snapshot.requestContext} />

      {status === 'verified' && (
        <p className="ob-check">&#10003; Matches the fingerprint recorded with your approval.</p>
      )}
      {status === 'mismatch' && (
        <p className="ob-check ob-check-x">&#10005; <b>This copy differs from the fingerprint recorded with your approval.</b></p>
      )}
      {status === 'unchecked' && (
        <p className="ob-quiet">
          This device's copy of what was shown, kept locally — the Authority Server does not record a
          fingerprint for you to check it against.
        </p>
      )}
      {/* AU10 §8.4 coordinator decision — several required approvers each
          record their OWN entry; only "your" entry is ever shown as
          verified/mismatch, never someone else's. */}
      {othersNote && <p className="ob-quiet" data-testid="au10-shown-others">{othersNote}</p>}
    </ObFold>
  );
}
