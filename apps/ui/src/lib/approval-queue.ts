/**
 * The approvals waiting for THIS person ("For me") — defined once, shared by
 * the Approvals page and the approval panel that opens by itself. Pure: no
 * React, no fetching.
 *
 * "For me" is exactly two sets:
 *   - review-mode proposals in my workspace queue (decided through that queue), and
 *   - above-limit proposals where I am one of the required approvers.
 * Never in it: proposals waiting on OTHER people, and my own above-limit
 * proposals (the proposer can never approve their own action — TR5).
 */
import type { Proposal } from './sp-client';
import { aggregateThread } from './thread-aggregator';
import { isProposer } from './proposal-proposer';

export interface QueueEntry {
  id: string;
  proposal: Proposal;
  /** 'queue' = decided through the workspace queue; 'approver' = above-limit approver route. */
  route: 'queue' | 'approver';
}

/**
 * The "For me" queue, oldest first.
 *
 * @param myProposals       the person's workspace proposals (all statuses; only pending review-mode ones count)
 * @param approverProposals proposals routed to the person as an approver (already filtered to ones they have not acted on)
 * @param decided           ids the gateway has already answered a decision for — they leave the queue at once
 */
export function buildMyQueue(
  myProposals: Proposal[],
  approverProposals: Proposal[],
  decided: ReadonlySet<string>,
  currentUserId: string | undefined,
): QueueEntry[] {
  const pendingReview = myProposals.filter(
    (p) => p.status === 'pending' && (p.pendingApprovers?.length ?? 0) === 0,
  );
  const out: QueueEntry[] = [];
  for (const item of aggregateThread(pendingReview, [], { status: 'pending' })) {
    if (item.kind === 'proposal') out.push({ id: item.proposal.id, proposal: item.proposal, route: 'queue' });
  }
  for (const p of approverProposals) {
    if (out.some((e) => e.id === p.id)) continue;
    if (isProposer(p, currentUserId)) continue; // never my own above-limit proposal
    out.push({ id: p.id, proposal: p, route: 'approver' });
  }
  return out
    .filter((e) => !decided.has(e.id))
    .sort((a, b) => a.proposal.createdAt - b.proposal.createdAt);
}

/** Drop decided ids the backend no longer lists — they have done their job (keeps the set from growing for ever). */
export function pruneDecided(decided: ReadonlySet<string>, myProposals: Proposal[], approverProposals: Proposal[]): Set<string> {
  const listed = new Set<string>();
  for (const p of myProposals) listed.add(p.id);
  for (const p of approverProposals) listed.add(p.id);
  return new Set([...decided].filter((id) => listed.has(id)));
}
