import type { IntegrationManifest, Proposal } from '../lib/sp-client';
import { useProposalContent } from '../lib/use-proposal-content';
import { approvalSummary } from '../lib/approval-summary';

/**
 * The approval's one sentence for list rows (UI spec §12.2): decrypts the
 * proposal's sealed values on this device — same path as the card — and fills
 * the manifest's summary template. Until then, or without a template, the
 * plain action name.
 */
export function ApprovalSummary({ proposal, manifests }: { proposal: Proposal; manifests: IntegrationManifest[] | undefined }) {
  const content = useProposalContent(proposal);
  return <>{approvalSummary(proposal.tool, content.toolArgs, manifests)}</>;
}
