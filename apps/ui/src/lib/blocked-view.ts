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
 *
 * Mandate title: `DenialRecord.mandateTitle` exists on the wire type but
 * nothing on the write side (recordBlocked in tool-proxy.ts) ever sets it —
 * the MCP server has no local copy of mandate titles to stamp at record
 * time. Resolved here instead, at DISPLAY time, from the SAME mandates list
 * the Mandates page already loads for this gateway (`getMyAttestations`) —
 * not a new external lookup, the gateway's own already-fetched data, keyed
 * by `authorization_id`. This is deliberately not "decision 1 broken": it
 * also means a renamed mandate shows its CURRENT title, and a denial
 * recorded before this fix shipped gets a title too. Unknown/revoked
 * mandate (not in that list) → the id alone, same as before.
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

/** One fragment of the "source" line. `dim` marks the mandate id, shown
 * small/muted next to its title — never the id alone when a title is known
 * locally (see `mandateParts` below). */
export interface SourcePart {
  text: string;
  dim?: boolean;
}

export interface BlockedView {
  title: string;
  sentence: string;
  sourceLine: SourcePart[];
  whatYouCanDo: string;
}

const TITLE: Record<DenialKind, string> = {
  bound: 'Blocked — above your limit',
  scope: "Blocked — outside your mandate's scope",
  cumulative: 'Blocked — limit reached',
  simulation: 'Blocked — simulation mode',
  not_authorized: 'Blocked — not authorized',
  // Wording pending Andreas's sign-off (temp/erp-checks-mockup) — kept minimal
  // so the Blocked page never shows an empty title for the new record kind.
  check: 'Blocked — a check failed',
  read: 'Read blocked',
};

/** One generic sentence per KIND — never tailored to the action (decision 3). */
const WHAT_YOU_CAN_DO: Record<DenialKind, string> = {
  bound: 'Nothing ran. To allow this, raise the limit on the mandate (needs your signature) — or ask the AI to stay within it.',
  scope: "Nothing ran. To allow this, widen the mandate's scope (needs your signature) — or ask the AI to stay within it.",
  cumulative: 'Nothing ran. Possible again once the window resets — or raise the limit in the mandate.',
  simulation: 'Nothing ran. Turn off simulation mode in Settings to use real systems.',
  not_authorized: 'Nothing ran. Grant a mandate for this, or ask the decision owner.',
  check: 'Nothing ran and no approval was asked for. The check reads the system\'s own data — correct the request or that data.',
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

/**
 * The title to show for this record's mandate: a live lookup by
 * `mandateId` (`mandateTitlesById`, keyed by `authorization_id` — see the
 * module doc above) wins whenever it has an entry, so a rename or a title
 * that only exists today (never stamped on the old record) still shows.
 * Falls back to whatever the record itself carries (legacy/hand-set data,
 * or a future record-time stamp), then to nothing — never the lookup table
 * absent an entry AND the record's own field both ignored.
 */
export function resolveMandateTitle(r: DenialRecord, mandateTitlesById?: Readonly<Record<string, string>>): string | undefined {
  if (r.mandateId) {
    const fromLookup = mandateTitlesById?.[r.mandateId];
    if (fromLookup) return fromLookup;
  }
  return r.mandateTitle;
}

/** Title first, id second in small/dimmed text — never the raw id alone
 * once a title is known (looked up or on-record). Falls back to the id
 * alone only when no title is known at all (an unknown/revoked mandate not
 * in the owner's mandate list, or — pre this fix — any denial at all). */
function mandateParts(r: DenialRecord, mandateTitlesById?: Readonly<Record<string, string>>): SourcePart[] {
  const title = resolveMandateTitle(r, mandateTitlesById);
  if (title) {
    const parts: SourcePart[] = [{ text: ` · mandate "${title}"` }];
    if (r.mandateId) parts.push({ text: ` (${r.mandateId.slice(0, 14)}…)`, dim: true });
    return parts;
  }
  if (r.mandateId) return [{ text: ` · mandate ${r.mandateId.slice(0, 14)}…` }];
  return [];
}

function sourceLine(r: DenialRecord, mandateTitlesById?: Readonly<Record<string, string>>): SourcePart[] {
  const kind = kindOf(r);
  const src = sourceName(r.integrationId);
  const who = r.who === 'authority-server'
    ? 'refused by the Authority Server'
    : kind === 'read'
      ? 'refused by this gateway'
      : 'refused by this gateway, before anything ran';
  const code = r.code ? ` (${r.code})` : '';
  return [
    { text: `${src} · ${r.tool}` },
    ...mandateParts(r, mandateTitlesById),
    { text: ` · ${who}${code}` },
  ];
}

/** Flattens `sourceLine` back to plain text — for places that can't render
 * the dim-id span (tests, anywhere non-JSX). */
export function sourceLineText(parts: SourcePart[]): string {
  return parts.map(p => p.text).join('');
}

/**
 * Build the full view for one record.
 * @param profile `profile`, when supplied, is the record's own profile
 *   (fetched once, generically, via `getProfile`) — used only to resolve a
 *   field's display name; its absence never blocks display.
 * @param mandateTitlesById Live title-by-id lookup — the owner's current
 *   mandate list (`authorization_id` -> title), already loaded for the
 *   Mandates page. See the module doc above for why this exists and the
 *   resolution order.
 */
export function blockedView(
  r: DenialRecord,
  profile?: AgentProfile,
  mandateTitlesById?: Readonly<Record<string, string>>,
): BlockedView {
  const kind = kindOf(r);
  const label = fieldLabel(profile, r.field);
  return {
    title: TITLE[kind],
    sentence: sentenceFor(r, label),
    sourceLine: sourceLine(r, mandateTitlesById),
    whatYouCanDo: WHAT_YOU_CAN_DO[kind],
  };
}

/** Records with a timestamp at or after the start of today (local time). */
export function todaysCount(records: Pick<DenialRecord, 'ts'>[], now: number): number {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return records.filter(r => r.ts >= startOfToday.getTime()).length;
}

/**
 * The sidebar badge count: blocks that arrived strictly after the owner last
 * opened the Blocked page, never "today's total" (that's `todaysCount`,
 * still shown in the page's own header line). `lastSeenAt` of 0 (never
 * opened) counts every retained record as new.
 */
export function unseenCount(records: Pick<DenialRecord, 'ts'>[], lastSeenAt: number): number {
  return records.filter(r => r.ts > lastSeenAt).length;
}

/** Whether a single record counts as unseen against a given cutoff. */
export function isUnseen(ts: number, lastSeenAt: number): boolean {
  return ts > lastSeenAt;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Today · 06:39 PM" / "Yesterday · 11:02 AM" for the last two days
 * (matching RecentBlocks.tsx's relative convention), falling through to
 * "Oct 12 · 09:15 AM" beyond that (matching the short month/day format
 * already used for mandate expiry in AuthorizationsPage.tsx) — always with
 * the time appended, which neither existing page does today. Locale-driven
 * (`undefined`/`[]` locale), same as the rest of the UI.
 */
export function formatBlockedWhen(ts: number, now: number): string {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (ts >= todayStart) return `Today · ${time}`;
  if (ts >= todayStart - DAY_MS) return `Yesterday · ${time}`;
  const date = new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${date} · ${time}`;
}
