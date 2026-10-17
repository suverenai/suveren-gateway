/**
 * What a ticket's local evidence says was sent and what the tool answered
 * (UI spec §14) — the server half of the ticket view's "What was sent" and
 * "Result" boxes. Local only: everything here is read from this gateway's
 * own stores and returned to its own control plane, never to the Authority
 * Server.
 *
 * The args check runs HERE rather than in the browser because the reference
 * it compares against — the execution journal's `argsHash` — is computed by
 * `hashToolArgs`, which lives in this process. A second implementation of
 * that hash in the UI could drift silently and turn into false alarms.
 */

import { hashToolArgs, type JournalEntry } from './execution-journal';
import type { ArchivedReceipt } from './receipt-archive';
import type { ExecutionResultEntry } from './execution-result-store';

/**
 *  - `match`     — the archived args hash to the journal row this gateway
 *                  wrote before it executed the ticket.
 *  - `mismatch`  — a check ran and failed: the local copy was changed.
 *  - `unchecked` — no check could run (no args kept, no journal row — it
 *                  is pruned after 90 days, or the process stopped between
 *                  archive and journal — or the archived copy is knowingly
 *                  not the hashed object). Never reported as a mismatch.
 */
export type SentArgsCheck = 'match' | 'mismatch' | 'unchecked';

/**
 * The args this ticket executed, from its archive entry: `sentArgs` on the
 * automatic path, the archived proposal's `toolArgs` on the review path
 * (the same object commitments.ts hashes into the journal — not stored twice).
 */
export function archivedArgs(
  entry: Pick<ArchivedReceipt, 'sentArgs' | 'proposal'>,
): { args: Record<string, unknown>; source: 'sent' | 'proposal' } | undefined {
  if (entry.sentArgs && typeof entry.sentArgs === 'object') return { args: entry.sentArgs, source: 'sent' };
  const toolArgs = entry.proposal?.toolArgs;
  if (toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)) {
    return { args: toolArgs as Record<string, unknown>, source: 'proposal' };
  }
  return undefined;
}

export function checkSentArgs(
  entry: Pick<ArchivedReceipt, 'sentArgs' | 'proposal'>,
  journalRow: Pick<JournalEntry, 'argsHash'> | undefined,
): SentArgsCheck {
  const found = archivedArgs(entry);
  if (!found || !journalRow?.argsHash) return 'unchecked';
  if (hashToolArgs(found.args) === journalRow.argsHash) return 'match';
  // The archive drops a review proposal's `_imagePreview` (receipt-archive.ts
  // stripPreviews) while the journal hashed it, so a proposal that carried
  // an image cannot be recomputed — honest `unchecked`, not a tamper alarm.
  if (found.source === 'proposal' && typeof found.args.imagePath === 'string') return 'unchecked';
  return 'mismatch';
}

/** The result as the ticket view reads it — no proposal/ticket ids, no timestamps it does not show. */
export interface TicketResultView {
  ok: boolean;
  text: string;
  structuredContent?: Record<string, unknown>;
  truncated?: boolean;
}

export function resultView(entry: ExecutionResultEntry | undefined): TicketResultView | null {
  if (!entry) return null;
  return {
    ok: entry.ok,
    text: entry.text,
    ...(entry.structuredContent ? { structuredContent: entry.structuredContent } : {}),
    ...(entry.truncated ? { truncated: true } : {}),
  };
}

/**
 * Trim every string inside `value` to `max` characters — for the Tickets
 * list's headlines, which need a template's few values and never a whole
 * email body. A summary sentence is capped at 140 characters anyway
 * (UI approval-summary.ts), so nothing a headline can show is lost.
 */
export function trimForHeadline(value: unknown, max = 200): unknown {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value)) return value.map(v => trimForHeadline(v, max));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = trimForHeadline(v, max);
    return out;
  }
  return value;
}

/**
 * The values an AUTOMATIC ticket's headline is built from (UI spec §13.4):
 * what this gateway sent, else the bound content when it is an object. An
 * approved ticket is left out — its headline comes from the proposal the
 * approver saw, decrypted in the browser. Keyed by ticket id.
 */
export function headlineArgs(entries: ArchivedReceipt[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const e of entries) {
    const id = (e.receipt as { id?: unknown })?.id;
    if (typeof id !== 'string' || e.proposal) continue;
    const src = e.sentArgs
      ?? (e.boundContent && typeof e.boundContent === 'object' ? e.boundContent : undefined);
    if (src) out[id] = trimForHeadline(src) as Record<string, unknown>;
  }
  return out;
}
