import { useEffect, useState } from 'react';
import { spClient, type IntegrationManifest, type Proposal } from '../lib/sp-client';
import { useProposalContent } from '../lib/use-proposal-content';
import { ticketHeadline } from '../lib/ticket-what-was-done';

/** One proposal fetch per page load, shared by every ticket that came from it. */
const proposals = new Map<string, Promise<Proposal | null>>();
function loadProposal(id: string): Promise<Proposal | null> {
  let p = proposals.get(id);
  if (!p) {
    p = spClient.getProposal(id).catch(() => null);
    proposals.set(id, p);
  }
  return p;
}

/**
 * One fetch of the automatic tickets' headline values for the whole list
 * (`GET /api/evidence/headlines`, this device's archive). Fetched again only
 * for a ticket issued after the last fetch — a new ticket arriving while the
 * page is open — never per row. A failed fetch is not kept, so the next
 * ticket tries again; until then the past-tense label stands.
 */
let headlines: { fetchedAtMs: number; map: Promise<Record<string, Record<string, unknown>>> } | null = null;
function loadHeadlines(ticketTimestampSec: number): Promise<Record<string, Record<string, unknown>>> {
  if (!headlines || ticketTimestampSec * 1000 > headlines.fetchedAtMs) {
    const entry = {
      fetchedAtMs: Date.now(),
      map: spClient.getTicketHeadlines().catch(() => {
        if (headlines === entry) headlines = null;
        return {};
      }),
    };
    headlines = entry;
  }
  return headlines.map;
}

function FromProposal({ proposal, tool, manifests, label }: { proposal: Proposal; tool: string; manifests: IntegrationManifest[]; label: string }) {
  const content = useProposalContent(proposal);
  return <>{ticketHeadline({ tool, manifests, label, approved: true, proposalArgs: content.toolArgs })}</>;
}

/**
 * A ticket's headline (UI spec §13.4): for an approved ticket, the sentence
 * the approver saw — built from the proposal's sealed values on this device
 * and the manifest's summary template ("Payment link of €0.10: Suveren test
 * charge"). For an automatic ticket, the same sentence from what this
 * gateway sent (§14). Otherwise — not readable here, older than §14, no
 * template — the manifest's past-tense label ("Payment link created").
 */
export function TicketHeadline({ ticketId, timestamp, proposalId, tool, manifests, label }: {
  ticketId: string;
  timestamp: number;
  proposalId?: string;
  tool: string;
  manifests: IntegrationManifest[];
  label: string;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sentArgs, setSentArgs] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let live = true;
    setProposal(null);
    setSentArgs(null);
    if (proposalId) loadProposal(proposalId).then(p => { if (live) setProposal(p); });
    else loadHeadlines(timestamp).then(m => { if (live) setSentArgs(m[ticketId] ?? null); });
    return () => { live = false; };
  }, [proposalId, ticketId, timestamp]);
  if (proposalId) {
    if (!proposal) return <>{label}</>;
    return <FromProposal proposal={proposal} tool={tool} manifests={manifests} label={label} />;
  }
  return <>{ticketHeadline({ tool, manifests, label, approved: false, sentArgs })}</>;
}
