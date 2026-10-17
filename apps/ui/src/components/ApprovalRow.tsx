import { useEffect, useRef, type ReactNode } from 'react';
import type { IntegrationManifest, Proposal } from '../lib/sp-client';
import { areaName, systemName, waitingLabel, deadlineLabel } from '../lib/core-objects';
import { useAreaCatalog } from '../lib/area-catalog';
import { ObjectLine, MandateLine } from './ObjectLine';
import { ApprovalSummary } from './ApprovalSummary';

interface Props {
  proposal: Proposal;
  manifests: IntegrationManifest[];
  titles: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  /** Shown under the summary only when other people are involved (team). */
  who?: string;
  /** The full approval card, rendered in place when open. */
  children: ReactNode;
}

/**
 * One approval as a row of the Approvals overview (UI spec §12.2): a solid
 * tab on the left, the "area · system · waiting …" line and the summary.
 * A click opens the full card in place; the deadline shows only inside the
 * last 24 hours.
 */
export function ApprovalRow({ proposal, manifests, titles, open, onToggle, who, children }: Props) {
  const now = Date.now();
  const due = deadlineLabel(proposal.expiresAt, now);
  const catalog = useAreaCatalog();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  return (
    <div ref={ref} className={`appr-item${open ? ' is-open' : ''}`} data-testid="approval-row" data-proposal-id={proposal.id}>
      <button type="button" className="appr-item-head" aria-expanded={open} onClick={onToggle}>
        <div className="appr-item-main">
          <ObjectLine
            profileId={proposal.profileId}
            area={areaName(proposal.profileId, catalog)}
            system={systemName(proposal.tool, manifests)}
            time={waitingLabel(proposal.createdAt, now)}
          />
          <div className="appr-item-sum" data-testid="approval-row-summary"><ApprovalSummary proposal={proposal} manifests={manifests} /></div>
          <MandateLine title={proposal.authorizationId ? titles[proposal.authorizationId] : undefined} area={areaName(proposal.profileId, catalog)} />
          {due && <div className="obj-due">{due}</div>}
          {who && <div className="appr-item-who">{who}</div>}
        </div>
        <span className="appr-item-chev" aria-hidden="true">›</span>
      </button>
      {open && <div className="appr-item-body">{children}</div>}
    </div>
  );
}
