/**
 * What happened after a person approved something — the pure parts. No React,
 * no fetching. Approving is not the end: the gateway then asks the Authority
 * Server for a ticket, and the server can still refuse (a shared limit filled
 * up, the mandate ended). The card stays on screen until this is known.
 */
import type { Proposal } from './sp-client';
import type { DecisionKind, DecisionResult } from './approval-flow';

/** How often the card re-reads the proposal while the outcome is not known. */
export const OUTCOME_POLL_MS = 2_000;
/** After this long the card says it does not know, rather than claiming success. */
export const OUTCOME_WAIT_MS = 30_000;

/** 'waiting' = no answer yet; 'unknown' = no answer in reasonable time, and the card says so. */
export type ApprovalOutcome = 'none' | 'waiting' | 'done' | 'refused' | 'unknown';

/** Only an approval that has no further approver waiting can still be refused at the ticket. */
export function decisionAwaitsOutcome(kind: DecisionKind, result: DecisionResult): boolean {
  return kind === 'approve' && !result.detail;
}

/** Reading the proposal back: 'waiting' while the status does not settle it. */
export function outcomeOfProposal(p: Pick<Proposal, 'status' | 'refusal'>): Exclude<ApprovalOutcome, 'none' | 'unknown'> {
  if (p.status === 'refused' && p.refusal) return 'refused';
  if (p.status === 'executed' || p.status === 'rejected' || p.status === 'expired') return 'done';
  // Still pending after an approval: it waits for someone else, so no ticket is being asked for yet.
  if (p.status === 'pending') return 'done';
  return 'waiting';
}

/** "Not known": the stamp must not read as a success when nobody has confirmed it. */
export const OUTCOME_WAITING_LINE = 'Waiting for the ticket…';
export const OUTCOME_UNKNOWN_LINE = 'The Authority Server has not answered yet, so it is not known whether this ran. Open Tickets to see the result.';

/** The action under a result that stays on screen. */
export function resultDismissLabel(moreWaiting: boolean): string {
  return moreWaiting ? 'Next' : 'Close';
}

// ─── A mandate that ended while its proposal waited ─────────────────────────

export type MandateEnded = NonNullable<Proposal['mandateEnded']>;

const ENDED_WORDS: Record<MandateEnded, { head: string; decisionError: string }> = {
  revoked: {
    head: 'This mandate was revoked.',
    decisionError: 'This mandate was revoked. It can no longer be approved.',
  },
  expired: {
    head: 'This mandate has expired.',
    decisionError: 'This mandate has expired. It can no longer be approved.',
  },
};

export const MANDATE_ENDED_DETAIL = 'It can no longer be approved. Reject this request to clear it; the AI needs a new mandate before it can ask again.';

export function mandateEndedHead(ended: MandateEnded): string {
  return ENDED_WORDS[ended].head;
}

/** A dead-mandate error from the gateway in plain words, never the code. Any other message is shown as it came. */
export function decisionErrorWords(message: string): string {
  if (message.includes('MANDATE_REVOKED')) return ENDED_WORDS.revoked.decisionError;
  if (message.includes('MANDATE_EXPIRED')) return ENDED_WORDS.expired.decisionError;
  return message;
}
