import type { IntegrationManifest, Proposal } from '../lib/sp-client';
import { useProposalContent } from '../lib/use-proposal-content';
import { approvalSummary } from '../lib/approval-summary';
import { refNameFrom, useProposalPreview } from '../lib/preview-store';
import { useAreaCatalog } from '../lib/area-catalog';
import { areaName } from '../lib/core-objects';
import { CREATE_MANDATE_TOOL, mandateTitleParts, mandateTargetProfile } from '../lib/mandate-proposal';

/**
 * The approval's one sentence for list rows (UI spec §12.2): decrypts the
 * proposal's sealed values on this device — same path as the card — and fills
 * the manifest's summary template. Until then, or without a template, the
 * plain action name.
 */
export function ApprovalSummary({ proposal, manifests }: { proposal: Proposal; manifests: IntegrationManifest[] | undefined }) {
  const content = useProposalContent(proposal);
  // `{x|ref}` names a record once the card has read it (preview-store.ts).
  const preview = useProposalPreview(proposal.id);
  const catalog = useAreaCatalog();
  if (proposal.tool === CREATE_MANDATE_TOOL && content.toolArgs) {
    const t = mandateTitleParts(areaName(mandateTargetProfile(content.toolArgs, proposal.profileId), catalog), content.toolArgs);
    return <>{t.area} · {t.name ? <span className="av3-ai">{t.name}</span> : 'new mandate'}</>;
  }
  return <>{approvalSummary(proposal.tool, content.toolArgs, manifests, undefined, refNameFrom(preview, content.toolArgs))}</>;
}
