/**
 * AU10 §8.4 — "What you saw", the ticket view's companion to AU6's "What was
 * done" (lib/ticket-what-was-done.ts; same shape of states, same reasoning:
 * never claim "verified" without a check that actually ran).
 *
 * Two independent facts combine into one status:
 *  - Is there a LOCAL snapshot on this device at all (`shown-snapshot`
 *    control-plane route) — absent on a different device, or a gateway that
 *    approved before this feature shipped.
 *  - Does the ticket/proposal's OWN `shownHash` (signed by, or at least
 *    recorded on, the Authority Server at decision time) match the local
 *    snapshot's hash — absent on an older AS that doesn't send the field at
 *    all (nullable on the wire by design, doc §8.4).
 */

export type ShownStatus = 'off-device' | 'unchecked' | 'verified' | 'mismatch';

export function shownStatus(opts: {
  /** `false` when `GET .../shown-snapshot` returned a local entry. */
  offDevice: boolean;
  /** The ticket/proposal's own `shownHash`, as the Authority Server has it. */
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

export function formatReadAt(readAt: number): string {
  return new Date(readAt).toLocaleString([], { hour: '2-digit', minute: '2-digit' });
}
