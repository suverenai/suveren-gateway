import { useEffect, useState } from 'react';
import { spClient, type IntegrationManifest, type Proposal } from '../lib/sp-client';
import { useProposalContent } from '../lib/use-proposal-content';
import { sealedSummary } from '../lib/approval-summary';

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

function FromProposal({ proposal, tool, manifests, label }: { proposal: Proposal; tool: string; manifests: IntegrationManifest[]; label: string }) {
  const content = useProposalContent(proposal);
  return <>{sealedSummary(tool, content.toolArgs, manifests) ?? label}</>;
}

/**
 * A ticket's headline (UI spec §12.2): for an approved ticket, the same
 * sentence the approver saw — built from the proposal's sealed values on this
 * device and the manifest's summary template ("Payment link of €0.10: Suveren
 * test charge"). Otherwise — automatic, not readable here, no template — the
 * manifest's past-tense label ("Payment link created").
 */
export function TicketHeadline({ proposalId, tool, manifests, label }: {
  proposalId?: string;
  tool: string;
  manifests: IntegrationManifest[];
  label: string;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  useEffect(() => {
    let live = true;
    setProposal(null);
    if (proposalId) loadProposal(proposalId).then(p => { if (live) setProposal(p); });
    return () => { live = false; };
  }, [proposalId]);
  if (!proposal) return <>{label}</>;
  return <FromProposal proposal={proposal} tool={tool} manifests={manifests} label={label} />;
}
