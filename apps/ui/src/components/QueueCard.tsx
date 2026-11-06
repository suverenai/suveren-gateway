/**
 * The approval card for one entry of the "For me" queue — the real card,
 * unchanged. Shared by the Approvals page and the approval panel so the two
 * show exactly the same thing: what is bound plus the gateway's own local
 * data, never text the AI wrote for the approver.
 */
import { ReviewApprovalCard } from './ActionCard';
import { ApproverProposalCard } from './ApproverProposalCard';
import { useApprovalQueue } from '../contexts/ApprovalQueueContext';
import type { QueueEntry } from '../lib/approval-queue';
import type { DecisionKind, DecisionResult } from '../lib/approval-flow';

interface Props {
  entry: QueueEntry;
  onDecided: (proposalId: string, kind: DecisionKind, result: DecisionResult) => void;
  nextLabelText?: string | null;
  onBusyChange?: (busy: boolean) => void;
}

export function QueueCard({ entry, onDecided, nextLabelText, onBusyChange }: Props) {
  const { manifests, toolDisplay, titles, userId } = useApprovalQueue();
  const { proposal } = entry;
  // The tool is namespaced `<integrationId>__<tool>`, the only link back to the connector that produced it.
  const proposalLinks = manifests.find((m) => m.id === proposal.tool.split('__')[0])?.proposalLinks;
  const mandateTitle = proposal.authorizationId ? titles[proposal.authorizationId] : undefined;
  return entry.route === 'queue' ? (
    <ReviewApprovalCard
      key={entry.id}
      proposal={proposal}
      manifests={manifests}
      toolDisplay={toolDisplay[proposal.tool]}
      proposalLinks={proposalLinks}
      currentUserId={userId}
      mandateTitle={mandateTitle}
      onDecided={onDecided}
      nextLabelText={nextLabelText}
      onBusyChange={onBusyChange}
    />
  ) : (
    <ApproverProposalCard
      key={entry.id}
      proposal={proposal}
      currentUserId={userId}
      manifests={manifests}
      toolDisplay={toolDisplay[proposal.tool]}
      proposalLinks={proposalLinks}
      mandateTitle={mandateTitle}
      onDecided={onDecided}
      nextLabelText={nextLabelText}
      onBusyChange={onBusyChange}
    />
  );
}
