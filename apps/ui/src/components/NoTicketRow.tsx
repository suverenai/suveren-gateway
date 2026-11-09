/**
 * A row in the Tickets list for an action that was asked for and approved but
 * never got a ticket: the Authority Server refused it. Dashed outline = asked
 * for, never issued. Same sentence as the approval's result, so the reason is
 * the same wherever it is found. Source: the proposal's own `refusal`
 * (the same list the Approvals page reads) — no new endpoint.
 */
import type { IntegrationManifest, Proposal } from '../lib/sp-client';
import { ApprovalSummary } from './ApprovalSummary';
import { useRefusalSentence } from './RefusalResult';
import { useAreaCatalog } from '../lib/area-catalog';
import { resolveAreaName } from '../lib/area';

export function NoTicketRow({ proposal, manifests }: { proposal: Proposal; manifests: IntegrationManifest[] }) {
  const catalog = useAreaCatalog();
  const sentence = useRefusalSentence(proposal, manifests);
  if (!proposal.refusal || !sentence) return null;
  const at = new Date(proposal.refusal.at * 1000);
  return (
    <div className="no-ticket-row" data-testid="no-ticket-row" data-proposal-id={proposal.id}>
      <div className="no-ticket-l1">
        <span className="no-ticket-title"><ApprovalSummary proposal={proposal} manifests={manifests} /></span>
        <span className="no-ticket-pill">No ticket</span>
      </div>
      <div className="no-ticket-l2">
        {resolveAreaName(proposal.profileId, catalog)} · {at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · refused by the Authority Server
      </div>
      <div className="no-ticket-why"><b aria-hidden="true">&#10005;</b><span>{sentence}</span></div>
    </div>
  );
}
