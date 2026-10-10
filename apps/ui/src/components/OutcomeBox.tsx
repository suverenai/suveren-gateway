/**
 * "What really happened" after an AS-"executed" proposal (AU4/AU5,
 * work-plan.md "Added 2026-10-09") — the AS marks a proposal "executed" once
 * the ticket is issued, even when the connector then refused the call or the
 * record changed underneath it. This reads the local execution journal via
 * `GET /proposals/:id/outcome` and shows the real outcome when it differs.
 *
 * Renders nothing for 'none'/'intent'/'done' — the rest of the card (receipt,
 * status badge) already tells that story; this component only ADDS the
 * refusal/changed case the AS's own status hides.
 */
import { useEffect, useState } from 'react';
import { spClient, type OutcomeResponse } from '../lib/sp-client';
import { outcomeBoxView } from '../lib/approval-preview-view';

interface Props {
  proposalId: string;
  systemName: string;
}

export function OutcomeBox({ proposalId, systemName }: Props) {
  const [outcome, setOutcome] = useState<OutcomeResponse | null>(null);

  useEffect(() => {
    let live = true;
    setOutcome(null);
    spClient.getProposalOutcome(proposalId)
      .then((o) => { if (live) setOutcome(o); })
      .catch(() => { /* best-effort — the AS's own status still shows */ });
    return () => { live = false; };
  }, [proposalId]);

  if (!outcome) return null;
  const view = outcomeBoxView(outcome, systemName);
  if (!view) return null;

  return (
    <div className="outcome-box">
      <h4>{view.heading}</h4>
      <p className="outcome-note">{view.note}</p>
    </div>
  );
}
