/**
 * "Reject or ask for a change" (RJ2, temp/briefs/rj-reject-brief.md; approved
 * mockup temp/mockups/reject-reason-v2.html) — the pure parts of the three
 * card buttons (Approve stays elsewhere): note validation, the quick-choice
 * chips that fill/extend the note, mapping a button click to the resolve/
 * reject call's `{ outcome, note }`, and reading a resolved proposal's
 * after-state back off the server's own fields. No React, no network — kept
 * separate so these are unit-testable on their own (same convention as
 * lib/blocked-view.ts).
 */
import type { Proposal, ProposalOutcome } from './sp-client';

/** Decision 2: 1–500 chars after trim. */
export const CHANGE_NOTE_MAX = 500;

/** Decision 1: the quick choices offered on the Change-needed panel. */
export const QUICK_CHIPS = ['Lower the discount', 'Other recipient', 'Shorter', 'Different wording'] as const;
export type QuickChip = (typeof QUICK_CHIPS)[number];

export type ChangeNoteValidation =
  | { valid: true; trimmed: string }
  | { valid: false; error: string };

/** The note the human writes for the AI — required, 1–500 chars after trim
 *  (decision 2). Returns the trimmed value on success so the caller never
 *  sends untrimmed whitespace to the server. */
export function validateChangeNote(note: string): ChangeNoteValidation {
  const trimmed = note.trim();
  if (trimmed.length === 0) return { valid: false, error: 'Describe what should change.' };
  if (trimmed.length > CHANGE_NOTE_MAX) {
    return { valid: false, error: `At most ${CHANGE_NOTE_MAX} characters (currently ${trimmed.length}).` };
  }
  return { valid: true, trimmed };
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `chip`'s phrase is already present in `note` (case-insensitive) —
 *  drives the chip's selected/`.on` look without separate component state. */
export function chipSelected(note: string, chip: string): boolean {
  return note.toLowerCase().includes(chip.toLowerCase());
}

/**
 * Clicking a quick choice toggles it into (or out of) the note: starts the
 * note if empty, appends with ". " otherwise; clicking an already-present
 * chip removes just that phrase, leaving the rest of the note (including
 * anything the person typed themselves) untouched.
 */
export function applyQuickChip(note: string, chip: string): string {
  const trimmed = note.trim();
  if (trimmed.length === 0) return chip;
  if (!chipSelected(trimmed, chip)) return `${trimmed}. ${chip}`;
  const re = new RegExp(`\\.?\\s*${escapeForRegExp(chip)}\\.?`, 'i');
  return trimmed
    .replace(re, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\.\s*/, '')
    .trim();
}

// ─── Mapping a button click to the resolve/reject call ─────────────────────

/** What the one-click Reject button sends — no note (decision 1). */
export function rejectOutcomeArgs(): { outcome: ProposalOutcome; note?: string } {
  return { outcome: 'rejected' };
}

/** What "Send back for change" sends. Throws only if called past an invalid
 *  note — callers are expected to check `validateChangeNote` first and keep
 *  the panel open on failure; this is the single place that enforces it
 *  can never reach the wire without a note. */
export function changeNeededOutcomeArgs(note: string): { outcome: ProposalOutcome; note: string } {
  const result = validateChangeNote(note);
  if (!result.valid) throw new Error(result.error);
  return { outcome: 'change_needed', note: result.trimmed };
}

/** What "Edit before signing" sends when withdrawing the proposal it opened
 *  from (AgentReviewPage) — the person signed their own version; no note. */
export function replacedOutcomeArgs(): { outcome: ProposalOutcome; note?: string } {
  return { outcome: 'replaced' };
}

// ─── After-state view (mockup §3 — "Afterwards, on the card") ──────────────

export type OutcomeKindLabel = 'REJECTED' | 'CHANGE NEEDED' | 'REPLACED';

const KIND_LABEL: Record<ProposalOutcome, OutcomeKindLabel> = {
  rejected: 'REJECTED',
  change_needed: 'CHANGE NEEDED',
  replaced: 'REPLACED',
};

export interface OutcomeAfterView {
  kind: OutcomeKindLabel;
  /** 'You', when the current viewer is who decided it; the raw user id
   *  otherwise (this card has no display-name lookup — see sp-client's
   *  `listUsers` for where one exists, used elsewhere). */
  who: string;
  /** Unix seconds. */
  at: number;
  /** The human's note to the AI (change_needed), or an above-cap approver's
   *  legacy free-text reason — whichever the record carries. Absent for a
   *  plain reject or a replace. */
  note?: string;
}

/**
 * Reads a resolved proposal's own outcome fields — `rejectedBy` (domain
 * review path) or `approverRejectedBy` (above-cap path), whichever is set.
 * A row with no `outcome` at all predates this feature and reads as
 * `rejected` (the brief's stated default for old rows). Returns `null` for
 * a proposal that was never rejected (still pending, committed, executed,
 * or expired without a decision) — there is nothing to show.
 */
export function outcomeAfterView(
  proposal: Pick<Proposal, 'rejectedBy' | 'approverRejectedBy'>,
  currentUserId: string,
): OutcomeAfterView | null {
  const source = proposal.rejectedBy ?? proposal.approverRejectedBy;
  if (!source) return null;
  const outcome = source.outcome ?? 'rejected';
  const note = source.note ?? ('reason' in source ? source.reason : undefined);
  return {
    kind: KIND_LABEL[outcome],
    who: source.userId === currentUserId ? 'You' : source.userId,
    at: source.at,
    note,
  };
}
