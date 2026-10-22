/**
 * Approval card v3 — the pure parts of the flow (UI spec §17). No React, no
 * fetching: the words of a decision, the ticket line, which card comes next.
 */
import { shortTicketId } from './core-objects';

/** What the person chose on the card. */
export type DecisionKind = 'approve' | 'reject' | 'change';

/** What the gateway answered once a decision went through. Nothing here is a guess. */
export interface DecisionResult {
  /** The ticket's id, when the answer carried one. */
  ticketId?: string;
  /** A plain extra line instead of the ticket (e.g. "1 more approval needed"). */
  detail?: string;
}

/** "Approving…" while the call is out (§17.5.1). */
export function workingWord(kind: DecisionKind, isMandate: boolean): string {
  if (kind === 'approve') return isMandate ? 'Signing' : 'Approving';
  return kind === 'reject' ? 'Rejecting' : 'Sending';
}

/** The stamp's word — shown only after the gateway answered (§17.5.2). */
export function stampWord(kind: DecisionKind, isMandate: boolean): string {
  if (kind === 'approve') return isMandate ? 'Signed' : 'Approved';
  return kind === 'reject' ? 'Rejected' : 'Sent back to the AI';
}

/** The line under the stamp: "Ticket 3fa9c1d2", an extra detail, or "Recorded". */
export function stampLine(kind: DecisionKind, result: DecisionResult | undefined): string {
  if (result?.detail) return result.detail;
  if (kind === 'approve' && result?.ticketId) return `Ticket ${shortTicketId(result.ticketId)}`;
  return 'Recorded';
}

/** The id a response's `receipt` object carries, when it has one. */
export function ticketIdOf(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const r = receipt as Record<string, unknown>;
  const id = r.id ?? r.receiptId ?? r.ticketId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The card to show after `decidedId` is done: the one that takes its place
 * (the next in line), the last one when the decided card was last, or null
 * when nothing is left (the empty list).
 */
export function nextAfter(ids: readonly string[], decidedId: string): string | null {
  const at = ids.indexOf(decidedId);
  const rest = ids.filter((id) => id !== decidedId);
  if (rest.length === 0) return null;
  if (at < 0) return rest[0];
  return rest[Math.min(at, rest.length - 1)];
}

/** "2 of 5" (1-based), or null when the id is not in the queue. */
export function positionLabel(ids: readonly string[], id: string | null): string | null {
  if (!id) return null;
  const at = ids.indexOf(id);
  return at < 0 ? null : `${at + 1} of ${ids.length}`;
}

/** The small label on the card that slides in after a decision. */
export function nextLabel(ids: readonly string[], id: string): string | null {
  const pos = positionLabel(ids, id);
  return pos ? `Next · ${pos}` : null;
}

/** The list's one menu (§17.1), in place of the three tabs. */
export type QueueView = 'me' | 'others' | 'all';
export const QUEUE_VIEWS: readonly { id: QueueView; label: string }[] = [
  { id: 'me', label: 'For me' },
  { id: 'others', label: 'Others' },
  { id: 'all', label: 'All' },
];

/** Which key press does what on a card (§17.1). Decisions never have a key. */
export type NavKey = 'prev' | 'next' | 'list';
export function navKeyFor(key: string): NavKey | null {
  if (key === 'ArrowLeft') return 'prev';
  if (key === 'ArrowRight') return 'next';
  if (key === 'Escape') return 'list';
  return null;
}
