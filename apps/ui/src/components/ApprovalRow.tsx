import type { IntegrationManifest, Proposal } from '../lib/sp-client';
import { areaName, ageLabel, deadlineLabel } from '../lib/core-objects';
import { useAreaCatalog } from '../lib/area-catalog';
import { useProposalPreview } from '../lib/preview-store';
import { standOut } from '../lib/approval-row';
import { showMandateLine } from '../lib/area';
import { ApprovalSummary } from './ApprovalSummary';
import { useProposalContent } from '../lib/use-proposal-content';
import { mandateTargetProfile } from '../lib/mandate-proposal';

interface Props {
  proposal: Proposal;
  manifests: IntegrationManifest[];
  titles: Record<string, string>;
  /** The card for this row is on screen beside the list (wide windows). */
  selected?: boolean;
  onOpen: () => void;
  /** Shown only when other people are involved (team). */
  who?: string;
}

const CREATE_MANDATE_TOOL = 'setup__create_mandate';

/**
 * One approval in the list (UI spec §17.1): type line, title, one line (the
 * mandate and the one thing that stands out). No lines between rows — each
 * row is a surface on the sunken page. A click opens the card.
 */
export function ApprovalRow({ proposal, manifests, titles, selected = false, onOpen, who }: Props) {
  const now = Date.now();
  const due = deadlineLabel(proposal.expiresAt, now);
  const catalog = useAreaCatalog();
  const preview = useProposalPreview(proposal.id);
  const flag = standOut(preview);
  const content = useProposalContent(proposal);
  const isMandate = proposal.tool === CREATE_MANDATE_TOOL;
  // A mandate proposal is about the area it names, not the Delegation ("Setup") it rides on.
  const area = areaName(isMandate ? mandateTargetProfile(content.toolArgs, proposal.profileId) : proposal.profileId, catalog);
  const mandateTitle = proposal.authorizationId ? titles[proposal.authorizationId] : undefined;
  const mandate = showMandateLine(mandateTitle, area) ? mandateTitle : undefined;
  const meta = [mandate, flag?.text].filter(Boolean);
  return (
    <div
      className={`av3-row${selected ? ' is-selected' : ''}`}
      data-testid="approval-row"
      data-proposal-id={proposal.id}
    >
      <button type="button" className="appr-item-head av3-row-head" aria-current={selected || undefined} onClick={onOpen}>
        <span className="av3-type">
          {isMandate ? <span className="av3-mtag">Mandate</span> : <b>Action</b>}
          <span>{area}</span>
          <span>{ageLabel(proposal.createdAt * 1000, now)}</span>
        </span>
        <span className="av3-row-title" data-testid="approval-row-summary"><ApprovalSummary proposal={proposal} manifests={manifests} /></span>
        {(meta.length > 0 || who || due) && (
          <span className="av3-row-meta">
            {mandate && <span>{mandate}</span>}
            {flag && <b className={flag.status === 'fail' ? 'av3-flag-fail' : undefined}>{flag.text}</b>}
            {due && <span>{due}</span>}
            {who && <span>{who}</span>}
          </span>
        )}
      </button>
    </div>
  );
}
