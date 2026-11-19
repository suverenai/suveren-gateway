import { ApprovalCard } from '@suveren/approval-card';
import { ageLabel } from '@suveren/approval-card/lib/core-objects';
import { approvalSummary } from '@suveren/approval-card/lib/approval-summary';
import { useProposalContent } from '@suveren/approval-card/lib/use-proposal-content';
import type { Proposal } from '@suveren/approval-card/types';
import { S8 } from '@suveren/approval-card/proposal-readers';
import { P } from '../texts';
import { Notice } from './Frame';

/**
 * One request in the list. Same classes as the gateway page's rows (`av3-row`): the list row itself is a gateway-page component
 * today, not in the shared package (see the hand-over), so this is a thin copy of its markup, not a second design.
 */
export function ProposalRow({ proposal, nowMs, onOpen }: { proposal: Proposal; nowMs: number; onOpen: () => void }) {
  // Opens this phone's wrap of the sealed arguments, as the gateway page's row does; until then, the plain action name.
  const content = useProposalContent(proposal);
  return (
    <div className="av3-row" data-testid="approval-row" data-proposal-id={proposal.id}>
      <button type="button" className="appr-item-head av3-row-head" onClick={onOpen}>
        <span className="av3-type">
          <b>Action</b>
          <span>{ageLabel(proposal.createdAt * 1000, nowMs)}</span>
        </span>
        <span className="av3-row-title" data-testid="approval-row-summary">{approvalSummary(proposal.tool, content.toolArgs, undefined)}</span>
      </button>
    </div>
  );
}

export interface RequestsScreenProps {
  /** Null while the first read is out. */
  proposals: Proposal[] | null;
  error?: string;
  nowMs: number;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}

export function RequestsScreen(p: RequestsScreenProps) {
  return (
    <div className="device-screen">
      <h1>{P.listTitle}</h1>
      <p>{P.welcomeReadOnly}</p>
      {p.error && <Notice kind="error">{p.error}</Notice>}
      {p.proposals === null && !p.error && <Notice kind="info">{P.listLoading}</Notice>}
      {p.proposals !== null && p.proposals.length === 0 && !p.error && <p data-testid="list-empty">{P.listEmpty}</p>}
      <div className="ap-list" data-testid="request-list">
        {(p.proposals ?? []).map((pr) => <ProposalRow key={pr.id} proposal={pr} nowMs={p.nowMs} onOpen={() => p.onOpen(pr.id)} />)}
      </div>
      <button type="button" className="btn btn-secondary btn-full" onClick={p.onRefresh}>{P.listRefresh}</button>
    </div>
  );
}

export interface RequestDetailProps {
  proposal: Proposal;
  userId: string;
  /** The card context could not be opened: said once, above the card (S8). The arguments are still shown in full. */
  contextMissing: boolean;
  onBack: () => void;
}

/**
 * The shared approval card, read-only (stage D1): no buttons. `alreadyDecided` is the card's own way to hide them and show only the
 * note in `topExtras`; `decide` refuses, so nothing can be sent from here even by a code path the buttons do not reach.
 */
export function RequestDetail({ proposal, userId, contextMissing, onBack }: RequestDetailProps) {
  const decide = async (): Promise<never> => { throw new Error('read_only'); };
  return (
    <div className="ap-detail">
      <button type="button" className="btn btn-ghost" onClick={onBack}>{P.listBack}</button>
      <ApprovalCard
        proposal={proposal}
        currentUserId={userId}
        alreadyDecided
        decide={decide}
        topExtras={(
          <>
            <Notice kind="info">{P.readOnlyNote}</Notice>
            {contextMissing && <Notice kind="info">{S8.contextMissing}</Notice>}
          </>
        )}
      />
    </div>
  );
}
