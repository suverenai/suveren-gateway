/**
 * "Give on your phone" on the gateway page (device-keys plan 4.4 "Transport", DEC-90; mockup phone-d3-live.html v7, Gateway view):
 * a computer without a check key cannot grant a mandate itself. When another active device of the person's chain can (`prepared.onPhone`),
 * the give page's footer hands the give to the phone and waits for its grant. Five states: offered, waiting, given, stopped, refused.
 *
 * Pure: the page drives it with the control plane's answers (POST/GET/DELETE /api/mandate/give-on-phone). No React, no network.
 */

export type GivePhoneState =
  | { s: 'offered' }
  | { s: 'sending' }
  | { s: 'waiting'; mandateId: string; expiresAt: number }
  | { s: 'given'; authorizationId: string; revokeError?: string }
  | { s: 'stopped' }
  | { s: 'refused'; code?: string; message: string };

/** The phone path applies: a chain gateway whose own give is refused only for want of a check key, and a phone of the chain can grant. */
export function phoneGiveOffered(prepared: { onPhone?: boolean; blocked?: { code: string } | null } | null | undefined): boolean {
  return !!prepared && prepared.onPhone === true && !!prepared.blocked && prepared.blocked.code === 'no_check_key';
}

/** What one poll answer means for the page. `unknown`: the gateway no longer waits under this id (restart past 30 min, or stopped elsewhere). */
export function afterPoll(
  st: GivePhoneState,
  answer: { state: 'waiting' } | { state: 'unknown' } | { state: 'done'; authorizationId: string; revokeError?: string },
): GivePhoneState {
  if (st.s !== 'waiting') return st;   // a late answer after Stop or a refusal changes nothing
  if (answer.state === 'waiting') return st;
  if (answer.state === 'done') return { s: 'given', authorizationId: answer.authorizationId, ...(answer.revokeError ? { revokeError: answer.revokeError } : {}) };
  return { s: 'stopped' };
}

/** A refusal from the control plane while sending or waiting (the phone's grant did not match, the AS refused, ...). Ends the wait. */
export function afterRefusal(st: GivePhoneState, code: string | undefined, message: string): GivePhoneState {
  if (st.s !== 'sending' && st.s !== 'waiting') return st;
  return { s: 'refused', ...(code ? { code } : {}), message };
}

/** While a give is sent or waits, the page must not start another one and must not offer the page's own give button. */
export function phoneGiveBusy(st: GivePhoneState): boolean {
  return st.s === 'sending' || st.s === 'waiting';
}

/** How often the page asks: every 2 s while waiting; the wait ends on its own at the request's expiry. */
export const GIVE_PHONE_POLL_MS = 2000;

export function waitExpired(st: GivePhoneState, nowMs: number): boolean {
  return st.s === 'waiting' && nowMs >= st.expiresAt * 1000;
}
