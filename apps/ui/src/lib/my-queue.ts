/**
 * The approval queue a user owns spans two workspaces: the active one AND their
 * personal one ('owner'). A mandate created in the personal workspace keeps
 * sending its review proposals there even while a team is active — the
 * "Active context" display is not a switch — so a queue that reads only the
 * active domain hides them (found 2026-10-05: ten requests invisible until
 * they would have expired).
 */
import type { Proposal } from './sp-client';

export const PERSONAL_DOMAIN = 'owner';

/** Domains to read, active first, without duplicates. */
export function queueDomains(activeDomain: string | null | undefined): string[] {
  const active = activeDomain || PERSONAL_DOMAIN;
  return active === PERSONAL_DOMAIN ? [PERSONAL_DOMAIN] : [active, PERSONAL_DOMAIN];
}

/** One list, newest first, each proposal once. */
export function mergeProposals(lists: Proposal[][]): Proposal[] {
  const byId = new Map<string, Proposal>();
  for (const list of lists) for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The domain to resolve a proposal under: its own queue, not the active one.
 * Prefers the active domain when the proposal is pending there; otherwise the
 * personal one when pending there; otherwise the active one (the AS decides).
 */
export function resolveDomainFor(proposal: Pick<Proposal, 'pendingDomains'> | undefined, activeDomain: string | null | undefined): string {
  const active = activeDomain || PERSONAL_DOMAIN;
  const pending = proposal?.pendingDomains ?? [];
  if (pending.includes(active)) return active;
  if (pending.includes(PERSONAL_DOMAIN)) return PERSONAL_DOMAIN;
  return active;
}
