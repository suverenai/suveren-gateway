/**
 * The "Blocked" view (AU2, work-plan.md "Added 2026-10-09") — every refusal
 * of a gated tool call, not only reads. Purely presentational logic, kept
 * separate from the component so it is unit-testable without React.
 *
 * Decisions this follows (Andreas, 2026-10-09):
 *  1. Show only what the record carries, plus local data (the mandate's
 *     title/field labels) — never a lookup into another system.
 *  3. No per-action tailored advice: ONE generic "what you can do" sentence
 *     per refusal KIND (limit per action / scope / cumulative limit /
 *     simulation mode / not authorized). No notification — the nav counter
 *     is enough.
 *
 * Field labels: the profile's own `displayName` where available, otherwise
 * the raw field name (never per-connector/per-profile code — generic lookup
 * over the profile's own bounds/scope schemas).
 */
import type { AgentProfile } from '@hap/core';
import type { DenialRecord, DenialKind } from './sp-client';
import { sourceName } from '../components/RecentBlocks';

/** A denial with `kind` resolved — absent on disk ⇒ 'read' (every record
 * written before AU2 was a read block). */
export function kindOf(r: DenialRecord): DenialKind {
  return r.kind ?? 'read';
}

/** The profile's own label for a bound/scope field, falling back to the raw
 * name. Scope fields are keyed by their own name in a refusal record; local
 * per_transaction bound refusals carry the EXECUTION field (`boundType.of`,
 * e.g. "recipient_count"), not the bound's own key (e.g. "recipient_max") —
 * so bounds are matched either way, enum/action-type fields directly. */
export function fieldLabel(profile: AgentProfile | undefined, field: string | undefined): string {
  if (!field) return '';
  if (!profile) return field;
  const scopeField = profile.scopeSchema?.fields?.[field];
  if (scopeField?.displayName) return scopeField.displayName;
  const boundsFields = profile.boundsSchema?.fields ?? {};
  if (boundsFields[field]?.displayName) return boundsFields[field].displayName as string;
  const viaBoundType = Object.values(boundsFields).find(f => f.boundType && 'of' in f.boundType && f.boundType.of === field);
  if (viaBoundType?.displayName) return viaBoundType.displayName;
  return field;
}

export interface BlockedView {
  title: string;
  sentence: string;
  sourceLine: string;
  whatYouCanDo: string;
}

const TITLE: Record<DenialKind, string> = {
  bound: 'Blocked — above your limit',
  scope: "Blocked — outside your mandate's scope",
  cumulative: 'Blocked — limit reached',
  simulation: 'Blocked — simulation mode',
  not_authorized: 'Blocked — not authorized',
  read: 'Read blocked',
};

/** One generic sentence per KIND — never tailored to the action (decision 3). */
const WHAT_YOU_CAN_DO: Record<DenialKind, string> = {
  bound: 'Nothing ran. To allow this, raise the limit on the mandate (needs your signature) — or ask the AI to stay within it.',
  scope: "Nothing ran. To allow this, widen the mandate's scope (needs your signature) — or ask the AI to stay within it.",
  cumulative: 'Nothing ran. Possible again once the window resets — or raise the limit in the mandate.',
  simulation: 'Nothing ran. Turn off simulation mode in Settings to use real systems.',
  not_authorized: 'Nothing ran. Grant a mandate for this, or ask the decision owner.',
  read: 'Nothing was read.',
};

function formatNum(v: number | string | undefined): string {
  if (v === undefined) return '';
  return typeof v === 'number' ? v.toLocaleString() : v;
}

/** The "value vs. limit" sentence — generic across every kind, built only
 * from the record's own fields (no lookups). */
function sentenceFor(r: DenialRecord, label: string): string {
  const kind = kindOf(r);
  const value = formatNum(r.value);
  const limit = formatNum(r.limit);
  switch (kind) {
    case 'bound':
      return value && limit
        ? `${label || 'Value'} ${value} is above the limit ${limit}.`
        : r.detail;
    case 'scope':
      return value
        ? `${label || 'Value'} "${value}" is not within your mandate's allowed ${label || 'scope'}.`
        : r.detail;
    case 'cumulative':
      return value && limit ? `${value} of ${limit} used — the limit is reached.` : r.detail;
    case 'simulation':
      return 'Real systems are switched off while the gateway runs in simulation mode.';
    case 'not_authorized':
      return 'No mandate currently covers this action.';
    case 'read':
    default:
      return r.detail;
  }
}

function sourceLine(r: DenialRecord): string {
  const kind = kindOf(r);
  const src = sourceName(r.integrationId);
  const mandate = r.mandateTitle
    ? ` · mandate "${r.mandateTitle}"`
    : r.mandateId
      ? ` · mandate ${r.mandateId.slice(0, 14)}…`
      : '';
  const who = r.who === 'authority-server'
    ? 'refused by the Authority Server'
    : kind === 'read'
      ? 'refused by this gateway'
      : 'refused by this gateway, before anything ran';
  const code = r.code ? ` (${r.code})` : '';
  return `${src} · ${r.tool}${mandate} · ${who}${code}`;
}

/** Build the full view for one record. `profile`, when supplied, is the
 * record's own profile (fetched once, generically, via `getProfile`) — used
 * only to resolve a field's display name; its absence never blocks display. */
export function blockedView(r: DenialRecord, profile?: AgentProfile): BlockedView {
  const kind = kindOf(r);
  const label = fieldLabel(profile, r.field);
  return {
    title: TITLE[kind],
    sentence: sentenceFor(r, label),
    sourceLine: sourceLine(r),
    whatYouCanDo: WHAT_YOU_CAN_DO[kind],
  };
}

/** Records with a timestamp at or after the start of today (local time). */
export function todaysCount(records: Pick<DenialRecord, 'ts'>[], now: number): number {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return records.filter(r => r.ts >= startOfToday.getTime()).length;
}
