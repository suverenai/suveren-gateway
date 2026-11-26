/**
 * The approval panel on the phone (DEC-86): the same mechanism as the gateway page. A waiting approval opens full screen by itself,
 * the head is the gateway's (shared `ApprovalPanelHead`: "Waiting for you", ‹ k of N ›, the "Open automatically" setting, ✕ Later),
 * and the card is the shared card in the gateway's `apr-body` / `apr-stage`: the middle scrolls, the decision buttons stay at the
 * bottom. The rules (what opens, when, what comes next) are the shared ones (`@suveren/approval-card/lib/approval-panel`); App.tsx
 * feeds them. On a phone the head is always the compact one.
 */
import { CardSkeleton } from '@suveren/approval-card/components/ApprovalCard';
import type { ReactNode } from 'react';
import { BrandRow } from '@suveren/approval-card/components/BrandMark';
import { ApprovalPanelHead } from '@suveren/approval-card/components/ApprovalPanelHead';
import type { Proposal } from '@suveren/approval-card/types';
import { RequestCard, type RequestCardProps } from './Requests';
import { Notice } from './Frame';
import { P } from '../texts';

export interface RequestPanelProps {
  /** k of N; null when the shown id is not in the list. */
  position: { index: number } | null;
  total: number;
  prevId: string | null;
  nextId: string | null;
  onMove: (id: string) => void;
  onLater: () => void;
  autoOpen: boolean | null;
  onToggleAuto: () => void;
  /** A decision is out: the head moves nothing (UI review: nav locked during signing). */
  locked?: boolean;
  /** The approval on screen; null while it is read. */
  shown: { proposal: Proposal; card: Omit<RequestCardProps, 'proposal'> } | null;
  /** Instead of a proposal: another kind of waiting item drawn by its own card (a computer's change request, or a mandate to give, stage D3). */
  other?: { key: string; node: ReactNode } | null;
  error?: string;
}

export function RequestPanel(p: RequestPanelProps) {
  return (
    <aside className="apr-panel is-open ap-panel" aria-label="Approval waiting for you" data-apr-ui data-testid="approval-panel">
      <ApprovalPanelHead
        compact
        position={p.position}
        total={p.total}
        prevId={p.prevId}
        nextId={p.nextId}
        onMove={p.onMove}
        onLater={p.onLater}
        autoOpen={p.autoOpen}
        onToggleAuto={p.onToggleAuto}
        locked={p.locked}
        brand={<BrandRow badge="Approvals" />}
      />
      <div className="apr-body">
        {p.error && <Notice kind="error">{p.error}</Notice>}
        {/* DEC-98: while the approval is read, the card's own layout greyed out (named for screen readers). */}
        {!p.shown && !p.other && !p.error && (
          <div className="card av3-card" role="status" aria-label={P.listLoading} data-testid="panel-card-skeleton"><CardSkeleton /></div>
        )}
        {!p.shown && p.other && (
          <div className="apr-stage" key={p.other.key} data-item-key={p.other.key}>
            {p.other.node}
          </div>
        )}
        {p.shown && (
          <div className="apr-stage" key={p.shown.proposal.id} data-proposal-id={p.shown.proposal.id}>
            <RequestCard proposal={p.shown.proposal} {...p.shown.card} />
          </div>
        )}
      </div>
    </aside>
  );
}
