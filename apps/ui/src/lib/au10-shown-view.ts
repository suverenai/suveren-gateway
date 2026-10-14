/**
 * AU10 §8.4 — "What you saw", the ticket view's companion to AU6's "What was
 * done" (lib/ticket-what-was-done.ts; same shape of states, same reasoning:
 * never claim "verified" without a check that actually ran).
 *
 * Two independent facts combine into one status:
 *  - Is there a LOCAL snapshot on this device at all (`shown-snapshot`
 *    control-plane route) — absent on a different device, or a gateway that
 *    approved before this feature shipped.
 *  - Does the proposal's own `shownHashes` map (the Authority Server's
 *    record — one entry per decider, see sp-client.ts `Proposal.shownHashes`)
 *    carry an entry for THIS gateway's signed-in user that matches the
 *    local snapshot's hash — absent entirely on an older AS, or on a row
 *    decided before this feature shipped.
 */
import type { ShownHashEntry, ShownHashes } from './sp-client';

export type ShownStatus = 'off-device' | 'unchecked' | 'verified' | 'mismatch';

/**
 * Picks the entry that belongs to THIS gateway's signed-in user, out of a
 * proposal's `shownHashes` map (keyed `domain:<domain>` for the resolve
 * flow, `approver:<userId>` for the above-cap approve/reject flow — suveren-
 * as proposal-store.ts). Preferred match: an entry whose OWN `by` is this
 * user (true regardless of which key shape recorded it — `by` is always
 * the real deciding user id). Fallback: the entry keyed to this user's
 * active team domain — "the entry for the domain they decided" when a
 * TEAMMATE (not this exact user) made the call under a shared domain key.
 * `otherCount` is every other entry besides the matched one, for "N other
 * approvers recorded their own" (several required approvers, each with
 * their own `approver:` key).
 */
export function matchShownHashEntry(
  shownHashes: ShownHashes | undefined,
  currentUserId: string,
  currentDomain: string | null | undefined,
): { entry: ShownHashEntry | undefined; otherCount: number } {
  const entries = Object.entries(shownHashes ?? {});
  if (entries.length === 0) return { entry: undefined, otherCount: 0 };

  const byUser = entries.find(([, e]) => e.by === currentUserId);
  const matched = byUser ?? (currentDomain ? entries.find(([key]) => key === `domain:${currentDomain}`) : undefined);

  const otherCount = matched ? entries.length - 1 : entries.length;
  return { entry: matched?.[1], otherCount };
}

export function shownStatus(opts: {
  /** `false` when `GET .../shown-snapshot` returned a local entry. */
  offDevice: boolean;
  /** This user's own entry from the proposal's `shownHashes` map, if any
   *  (see {@link matchShownHashEntry}). */
  recordedHash: string | undefined;
  /** The local snapshot entry's own hash (recomputed server-side already —
   *  see `verifiedLocally` on the response; this is the value to compare
   *  against `recordedHash`). */
  localHash: string | undefined;
}): ShownStatus {
  if (opts.offDevice) return 'off-device';
  if (!opts.recordedHash) return 'unchecked';
  return opts.localHash === opts.recordedHash ? 'verified' : 'mismatch';
}

/** "N other approvers recorded their own" — undefined when there is nothing
 *  else to mention (0 other entries). */
export function otherApproversNote(otherCount: number): string | undefined {
  if (otherCount <= 0) return undefined;
  return `${otherCount} other approver${otherCount === 1 ? '' : 's'} recorded their own.`;
}

export function formatReadAt(readAt: number): string {
  return new Date(readAt).toLocaleString([], { hour: '2-digit', minute: '2-digit' });
}
