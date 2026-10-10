/**
 * "What was done" — the ticket's bound content, shown FIRST on the ticket
 * card (AU6, work-plan.md "Added 2026-10-09"; approved mockup
 * temp/mockups/gateway-ux-v7.html §3). Pure and unit-tested — the component
 * (components/TicketWhatWasDone.tsx) only renders what these functions
 * return and runs the one async hash check (lib/content-hash.ts).
 *
 * Five states (2026-10-10 correction: a real receipt can carry bound
 * content with no signed hash to check it against — that is NOT the same
 * claim as a check that ran and failed, and showing it as "mismatch" would
 * be a false alarm: it says a check failed when none ran):
 *  - `verified`   — the archived `boundContent` recomputes to the ticket's
 *                   own signed `contentHash`. Only state that may say "this
 *                   exact content is bound by hash".
 *  - `mismatch`   — a hash check DID run (a signed `contentHash` and
 *                   `contentBinding` both exist) and the recomputed hash
 *                   does NOT match — shown in red, the only state that may
 *                   say the content looks altered.
 *  - `unchecked`  — bound content exists but the ticket carries no signed
 *                   hash/binding to check it against at all — content is
 *                   shown, neutrally, with neither a bound claim nor an
 *                   alarm.
 *  - `none`       — the ticket carries no bound content at all (the profile
 *                   declares no content_binding, or this action type is
 *                   outside it) — show the checked values instead.
 *  - `off-device` — no local archive entry for this ticket at all (ran on
 *                   another device, or predates local archiving).
 */
import type { AgentProfile } from '@hap/core';
import { contextFieldLabel } from './approval-view';
import { renderPreviewBody, type RenderedPreview } from './preview-render';

export type TicketBoundStatus = 'verified' | 'mismatch' | 'unchecked' | 'none' | 'off-device';

/**
 * The status to show, given what is already known.
 *
 * `hasHashToCheck` is whether the ticket even carries a signed `contentHash`
 * + `contentBinding` to check against — false means no check was possible,
 * which is `unchecked`, never `mismatch` (that would claim a check failed
 * when none ran). `hashVerified` is the async check's result, read only
 * when `hasHashToCheck` is true; callers are expected to wait for it to
 * resolve before calling this (components/TicketWhatWasDone.tsx does).
 */
export function ticketBoundStatus(opts: {
  offDevice: boolean;
  boundContent: Record<string, unknown> | string | undefined;
  hasHashToCheck: boolean;
  hashVerified: boolean | null;
}): TicketBoundStatus {
  if (opts.offDevice) return 'off-device';
  if (opts.boundContent === undefined) return 'none';
  if (!opts.hasHashToCheck) return 'unchecked';
  return opts.hashVerified === true ? 'verified' : 'mismatch';
}

/**
 * Renders the archived bound content generically — nested rows, no raw
 * JSON, numbers rounded with the exact value on hover — by reusing
 * lib/preview-render.ts's rules rather than a second rendering engine.
 * `fields` is the profile's `content_binding.fields` (v2 declarations;
 * v1/whole-payload bindings have none), respected as the display order
 * when present; every field otherwise shows, labelled by its humanized key
 * (content_binding carries no per-field display names to draw from).
 */
export function boundContentView(
  boundContent: Record<string, unknown> | string | undefined,
  fields?: string[],
): RenderedPreview {
  if (boundContent === undefined) return { kind: 'empty', fields: [], moreFields: [], totalFields: 0 };
  if (typeof boundContent === 'string') return renderPreviewBody({ text: boundContent });
  return renderPreviewBody({ structured: boundContent }, { fields });
}

export interface CheckedValueRow {
  key: string;
  label: string;
  value: string;
}

/**
 * The fallback for a ticket with NO bound content: the executionContext
 * values the ticket actually signs, labelled from the profile's scope
 * schema the same way AU1's scopeSummary/allowedSummary do (never a
 * field-name guess) — e.g. "Value 480", "Discount pct 0".
 */
export function checkedValueRows(
  executionContext: Record<string, unknown> | undefined,
  profile: AgentProfile | null | undefined,
): CheckedValueRow[] {
  if (!executionContext) return [];
  return Object.entries(executionContext)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, v]) => ({ key, label: contextFieldLabel(key, profile).label, value: String(v) }));
}
