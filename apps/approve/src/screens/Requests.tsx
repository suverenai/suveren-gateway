import { ApprovalCard } from '@suveren/approval-card';
import { ApprovalRow } from '@suveren/approval-card/components/ApprovalRow';
import type { Proposal } from '@suveren/approval-card/types';
import { S8 } from '@suveren/approval-card/proposal-readers';
import { P } from '../texts';
import { Notice } from './Frame';

const NO_MANIFESTS: never[] = [];
const NO_TITLES: Record<string, string> = {};

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
      <div className="dash-rows" data-testid="request-list">
        {(p.proposals ?? []).map((pr) => (
          <ApprovalRow key={pr.id} proposal={pr} manifests={NO_MANIFESTS} titles={NO_TITLES} onOpen={() => p.onOpen(pr.id)} />
        ))}
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
    <div className="device-screen">
      <button type="button" className="av3-back" onClick={onBack}>{P.listBack}</button>
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
