/**
 * TR5 (real-gateway e2e, 2026-10-15) — "the proposer must never be in the
 * above-cap approver set, and must never be able to approve their own
 * action." Pulled out as pure functions (no React) so they are directly
 * unit-testable against the REAL AS/gateway identity shape — a plain
 * userId string, which in practice is often itself an email-shaped value
 * (test fixtures provision accounts as `name-<uuid>@test.local`; nothing
 * here assumes a short name or a particular format) — rather than only a
 * hand-built "tom"/"lisa" ideal record.
 */
import type { Proposal } from './sp-client';

/** Is `currentUserId` the proposal's own proposer (never able to approve
 *  their own above-cap action)? `proposal.createdBy` absent (an older
 *  proposal, or one created before this field existed) ⇒ never — an
 *  unknown proposer must not be guessed as "you", which would wrongly
 *  block a legitimate approver. */
export function isProposer(
  proposal: Pick<Proposal, 'createdBy'>,
  currentUserId: string | undefined,
): boolean {
  return !!proposal.createdBy && !!currentUserId && proposal.createdBy === currentUserId;
}

/**
 * The approver roster as the card should RENDER it — `pendingApprovers`
 * with the proposer defensively filtered out, regardless of whether the
 * value came from a gateway that already excludes them (tool-proxy.ts,
 * confirmed team workspace) or an older/stale one that does not.
 */
export function visibleApprovers(
  proposal: Pick<Proposal, 'pendingApprovers' | 'createdBy'>,
): string[] {
  return (proposal.pendingApprovers ?? []).filter((uid) => uid !== proposal.createdBy);
}
