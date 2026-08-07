import type { Proposal } from './sp-client';

/**
 * What "waiting for me" means — defined once.
 *
 * The dashboard renders these as attention rows and the tab badge counts them.
 * When those two disagree the product looks broken in the most corrosive way:
 * the tab says something needs you, the page shows nothing. Same predicate,
 * both places. See also lib/auth-status.ts, which does this for authorizations.
 */
export function isPendingProposal(p: Proposal): boolean {
  return p.status === 'pending';
}

/**
 * Domain proposals still pending, plus the above-cap proposals routed to me as
 * an approver. The approver inbox is already filtered server-side to items I
 * have not acted on, so its length counts directly.
 */
export function countPending(proposals: Proposal[], approverProposals: Proposal[]): number {
  return proposals.filter(isPendingProposal).length + approverProposals.length;
}
