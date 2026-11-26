/**
 * Screen 1 (DEC-80): what today's review step shows for a chain account, as pure functions: limit and scope rows with the
 * profile's labels and units, the end date, the approver list and the answers to a refused or finished give. Shared with
 * the phone app. No React, no network.
 */
import { S13 } from './texts';
import { formatLimitValue } from '../lib/bound-format';
import { listItems, listText } from '../lib/mandate-facts';

export interface FieldLike { displayName?: string; unit?: string }
export interface SchemaLike { fields?: Record<string, FieldLike> }

/** One limit's value with the profile's unit: "€2,000", "20%", "30 days", a count plain (lib/bound-format.ts, the one definition). */
export function limitValueText(def: FieldLike | undefined, v: string | number): string {
  return formatLimitValue(v, def?.unit);
}

/** One row per limit: the profile's label (the key only when the profile has none) and the value with its unit. */
export function limitRows(bounds: Record<string, string | number>, schema: SchemaLike | undefined, hidden: ReadonlySet<string> = new Set()): Array<{ key: string; label: string; value: string }> {
  return Object.entries(bounds)
    .filter(([k]) => k !== 'profile' && k !== 'path' && !hidden.has(k))
    .map(([k, v]) => ({ key: k, label: schema?.fields?.[k]?.displayName ?? k, value: limitValueText(schema?.fields?.[k], v) }));
}

export function scopeLabel(key: string, schema: SchemaLike | undefined): string {
  return schema?.fields?.[key]?.displayName ?? key;
}

export function durationText(seconds: number): string {
  if (seconds % 86400 === 0) { const d = seconds / 86400; return `${d} ${d === 1 ? 'day' : 'days'}`; }
  if (seconds % 3600 === 0) { const h = seconds / 3600; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  // What is left of a mandate (a change or an extension shows it) is rarely whole hours: "8 hours 15 minutes", never "495 minutes".
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} ${h === 1 ? 'hour' : 'hours'}`;
  return m === 0 ? hours : `${hours} ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

export function endDateText(nowMs: number, seconds: number): string {
  return new Date(nowMs + seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * "30 days (until 26 Dec 2026, 14:20)": how long the mandate is granted for, and the date that gives if it is signed now. The duration is
 * the granted one (what the mandate carries), never the time left until an end date, so 30 days stays "30 days" however long the card waited.
 */
export function validText(seconds: number | null | undefined, nowMs: number): string {
  if (!seconds || seconds <= 0) return '';
  return S13.giveUntil(durationText(seconds), endDateText(nowMs, seconds));
}

/** `approverNames`: the names of the approvers without a device chain (approver_has_no_chain), when the page knows them. */
export type GiveError = { code: string | undefined; reason?: string; approverNames?: string[] };

/** The sentence for a refused give. Before-the-touch refusals say nothing changed; the AS and the touch have their own. */
export function giveErrorText(e: GiveError): string {
  switch (e.code) {
    case 'cap_exceeded': return S13.giveErrCap;
    case 'approvers_unavailable': case 'approver_unresolved': return S13.giveErrApprovers;
    case 'as_unreachable': case 'as_tls_mismatch': return S13.endOffline;
    case 'approver_has_no_chain': return e.approverNames && e.approverNames.length > 0 ? S13.giveErrNoChainNamed(e.approverNames) : S13.giveErrNoChain;
    case 'check_failed': return e.reason === 'user_cancelled' ? S13.giveErrCancelled : S13.giveErrTouch;
    case 'changed_since_prepare': case 'prepare_required': return S13.giveErrChanged;
    case 'delivery_failed': return S13.giveErrNotDelivered;
    default: return S13.giveErrNotAccepted;
  }
}

export interface ApproverLine { userId: string; name: string; state: 'unknown' | 'confirmed' | 'unconfirmed' }

/**
 * Approver states from the gateway's own refusal `approver_identity_unconfirmed` (the only confirmation source today;
 * INTERIM until DEC-73's member list): before the first give nothing is known ('unknown'); after a refusal the named
 * approvers are 'unconfirmed' and the rest 'confirmed'.
 */
export function approverLines(approvers: Array<{ userId: string; name: string }>, unconfirmedIds: ReadonlySet<string> | null): ApproverLine[] {
  return approvers.map(a => ({ ...a, state: unconfirmedIds === null ? 'unknown' : unconfirmedIds.has(a.userId) ? 'unconfirmed' : 'confirmed' }));
}

/**
 * The one-line summary under a mandate's title (UI review, DEC-88): the numbers the person signs, before the detail blocks —
 * every shown limit and scope value with the profile's label for it, then how long. "Offer value: 2000 EUR · Per day: 10 · Region: Austria, Germany · 14 days".
 * Driven by the profile's schema, never by a field name. Empty parts are left out; an empty result means no line.
 */
export function giveSummaryLine(input: {
  limits?: Record<string, string | number> | null;
  scope?: Record<string, unknown> | null;
  durationSeconds?: number | null;
  boundsSchema?: SchemaLike;
  scopeSchema?: SchemaLike;
  hidden?: ReadonlySet<string>;
}): string {
  // Each value with the profile's own label for its field (UI review: a bare "none · none · 50" cannot be read). Generic: the label
  // comes from the schema, never from a field name in code; a field the schema does not label shows its key.
  const parts: string[] = limitRows(input.limits ?? {}, input.boundsSchema, input.hidden).map(r => `${r.label}: ${r.value}`);
  for (const [k, v] of Object.entries(input.scope ?? {})) {
    if (k === 'profile' || k === 'path') continue;
    // A list reads with a space after each comma ("customer, lead"), so it wraps at the commas (lib/mandate-facts.ts).
    const text = Array.isArray(v) || typeof v === 'string' || typeof v === 'number' ? listText(listItems(v)) : '';
    if (text) parts.push(`${scopeLabel(k, input.scopeSchema)}: ${text}`);
  }
  if (input.durationSeconds && input.durationSeconds > 0) parts.push(durationText(input.durationSeconds));
  return parts.join(' · ');
}
