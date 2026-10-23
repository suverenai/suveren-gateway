/**
 * ApproverProposalCard — the approval card for an above-cap action the person
 * is a required approver of (Phase 6; TR5). It is the one approval card
 * (ApprovalCard, UI spec §17) plus what only a team approval has: who must
 * approve, why it is over the limit, and the proposer who cannot approve
 * their own action.
 *
 * On approve (lib/approval-decision.ts decideAsApprover):
 *  1. POST /api/proposals/:id/approve (AS)
 *  2. the mandate's intent is fetched, decrypted and stored locally as an
 *     accountability record (best-effort)
 */
import type { ProposalLink } from '../lib/proposal-links';
import type { IntegrationManifest, Proposal } from '../lib/sp-client';
import type { ToolDisplay } from '../lib/approval-view';
import { ApprovalCard } from './ApprovalCard';
import { decideAsApprover } from '../lib/approval-decision';
import type { DecisionKind, DecisionResult } from '../lib/approval-flow';
import { useApprovalTeamInfo } from '../lib/approval-team-info';
import { isProposer as isProposerOf, visibleApprovers } from '../lib/proposal-proposer';

interface Props {
  proposal: Proposal;
  /** Declared by the acting integration's manifest — see resolveProposalLinks. */
  proposalLinks?: ProposalLink[];
  /** Labels and display kinds for the arguments (lib/approval-view.ts). */
  toolDisplay?: ToolDisplay;
  manifests?: IntegrationManifest[];
  currentUserId: string;
  mandateTitle?: string;
  /** The gateway has answered a decision on this card. */
  onDecided?: (proposalId: string, kind: DecisionKind, result: DecisionResult) => void;
  nextLabelText?: string | null;
  onBusyChange?: (busy: boolean) => void;
}

export function ApproverProposalCard({ proposal, currentUserId, onDecided, proposalLinks, toolDisplay, manifests, mandateTitle, nextLabelText, onBusyChange }: Props) {
  // TR5: the proposer must never be shown as (or able to act as) one of their
  // own action's approvers — filtered defensively even if a stale cache lists them.
  const pendingApprovers = visibleApprovers(proposal);
  const approvedBy = proposal.approvedBy ?? {};
  // AS truth, never optimistic: exactly what the proposal's own record says right now.
  const approvedCount = Object.keys(approvedBy).length;
  const alreadyApproved = currentUserId in approvedBy;
  // How many DISTINCT approvals this needs (default 1), who the approvers are
  // by name, and — from real data only — why it is above the cap.
  const team = useApprovalTeamInfo(proposal);
  const isProposer = isProposerOf(proposal, currentUserId);

  const extras = (
    <>
      {/* "Needs N approval(s) from: …" — a "X of N" count only when N > 1. */}
      <div className="approver-progress av3-quiet">
        Needs {team.requiredApprovals} approval{team.requiredApprovals === 1 ? '' : 's'} from:{' '}
        {pendingApprovers.map((uid, i) => (
          <span key={uid} className={`who${uid in approvedBy ? ' done' : ''}`} style={{ marginLeft: i === 0 ? '0.25rem' : '0.5rem', fontWeight: uid in approvedBy ? 600 : undefined }}>
            {uid in approvedBy ? '✓ ' : ''}{team.nameOf(uid)}{uid === currentUserId ? ' (you)' : ''}
            {i < pendingApprovers.length - 1 ? ',' : ''}
          </span>
        ))}
        {team.requiredApprovals > 1 && (
          <span style={{ marginLeft: '0.5rem' }}>({approvedCount} of {team.requiredApprovals})</span>
        )}
      </div>
      {/* "Above the team limit: <field> <value> (limit <cap>). Requested by <proposer>."
          Dashed outline — the "needs attention" form, no colour (UI spec §4.2.4). */}
      {team.aboveCapReason && (
        <div className="over-limit-box" data-testid="above-cap-reason">
          <b>Above the team limit:</b>{' '}
          <span>
            {team.aboveCapReason.fieldLabel}
            {team.aboveCapReason.value !== undefined ? ` ${team.aboveCapReason.value}` : ''} (limit {String(team.aboveCapReason.cap)}).{' '}
            {proposal.createdBy ? `Requested by ${team.nameOf(proposal.createdBy)}.` : ''}
          </span>
        </div>
      )}
      {/* TR5 (content/0.7/review.md "Group roles…", rule 4): the proposer of an
          above-cap action can never approve their own action — said in words,
          so the missing Approve button needs no guessing. */}
      {isProposer && (
        <p className="blocked-note av3-bold" data-testid="cant-approve-own-action">
          You can&apos;t approve your own action.
        </p>
      )}
      {alreadyApproved && (
        <p className="av3-quiet">
          You approved this action.
          {team.requiredApprovals > 1 && approvedCount < team.requiredApprovals
            ? ` Waiting on ${team.requiredApprovals - approvedCount} more approval(s).`
            : ''}
        </p>
      )}
    </>
  );

  return (
    <ApprovalCard
      proposal={proposal}
      currentUserId={currentUserId}
      manifests={manifests}
      toolDisplay={toolDisplay}
      proposalLinks={proposalLinks}
      mandateTitle={mandateTitle}
      nameOf={team.nameOf}
      nextLabelText={nextLabelText}
      onBusyChange={onBusyChange}
      topExtras={extras}
      canApprove={!isProposer}
      alreadyDecided={alreadyApproved}
      decide={(args) => decideAsApprover(proposal, args, { userId: currentUserId })}
      onDecided={(kind, result) => onDecided?.(proposal.id, kind, result)}
    />
  );
}
