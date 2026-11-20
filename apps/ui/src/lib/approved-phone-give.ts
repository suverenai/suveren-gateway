/**
 * An AI proposal to create or change a mandate, approved on a computer without Touch ID (DEC-90): the gateway cannot grant it itself and
 * sends it to the person's phone. The approval card then shows the same "Give on your phone" waiting state as the give page, until the
 * phone gives it (the gateway's "Signed" result), it is stopped, or refused.
 *
 * Pure: the card drives it (components/QueueCard.tsx). No React, no network.
 */

/** Only these two Setup tools carry out a mandate that a phone may have to grant. */
export function mayGoToPhone(tool: string): boolean {
  return tool === 'setup__create_mandate' || tool === 'setup__change_mandate';
}

/** After an approval, how long the card looks for a give sent to the phone: the gateway runs the approved tool right away. */
export const LOOKUP_EVERY_MS = 1000;
export const LOOKUP_TRIES = 8;

export type ApprovedPhoneGive =
  | { s: 'idle' }
  | { s: 'looking'; tries: number }
  | { s: 'none' }
  | { s: 'waiting'; mandateId: string }
  | { s: 'given' }
  | { s: 'stopped' }
  | { s: 'refused'; message: string };

/** One look-up answer. After the last try without a give, it is `none`: the mandate was given on this computer (or refused there). */
export function afterLookup(st: ApprovedPhoneGive, found: { mandateId: string } | null): ApprovedPhoneGive {
  if (st.s !== 'looking') return st;
  if (found) return { s: 'waiting', mandateId: found.mandateId };
  return st.tries + 1 >= LOOKUP_TRIES ? { s: 'none' } : { s: 'looking', tries: st.tries + 1 };
}

/** One poll of the waiting give. `unknown`: nothing waits under the id any more (stopped elsewhere, or past its time). */
export function afterGivePoll(st: ApprovedPhoneGive, answer: { state: 'waiting' | 'unknown' | 'done' }): ApprovedPhoneGive {
  if (st.s !== 'waiting') return st;
  if (answer.state === 'done') return { s: 'given' };
  if (answer.state === 'unknown') return { s: 'stopped' };
  return st;
}

/** While it looks, the card's "done" is held back: the panel must not move on before it is known whether the phone has to give it. */
export function holdsOutcome(st: ApprovedPhoneGive): boolean {
  return st.s === 'looking' || st.s === 'waiting' || st.s === 'given' || st.s === 'stopped' || st.s === 'refused';
}
