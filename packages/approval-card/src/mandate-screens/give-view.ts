/**
 * Screen 1 (DEC-80): what today's review step shows for a chain account, as pure functions: limit and scope rows with the
 * profile's labels and units, the end date, the approver list and the answers to a refused or finished give. Shared with
 * the phone app. No React, no network.
 */
import { S13 } from './texts';
import { formatUnit } from '../lib/bound-format';

export interface FieldLike { displayName?: string; unit?: string }
export interface SchemaLike { fields?: Record<string, FieldLike> }

/** "up to 500 EUR" style value for one limit, with the profile's unit. */
export function limitValueText(def: FieldLike | undefined, v: string | number): string {
  const u = formatUnit(def?.unit);
  if (!u) return String(v);
  if (def?.unit === 'percent') return `${v}${u}`;
  if (def?.unit?.startsWith('currency:')) return `${v} ${u.replace(/^\s+/, '')}`;
  return `${v} ${u}`;
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
  return `${Math.round(seconds / 60)} minutes`;
}

export function endDateText(nowMs: number, seconds: number): string {
  return new Date(nowMs + seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export type GiveError = { code: string | undefined; reason?: string };

/** The sentence for a refused give. Before-the-touch refusals say nothing changed; the AS and the touch have their own. */
export function giveErrorText(e: GiveError): string {
  switch (e.code) {
    case 'cap_exceeded': return S13.giveErrCap;
    case 'approvers_unavailable': case 'approver_unresolved': return S13.giveErrApprovers;
    case 'as_unreachable': case 'as_tls_mismatch': return S13.endOffline;
    case 'approver_has_no_chain': return S13.giveErrNoChain;
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
 * every shown limit with its unit, every scope value, then how long. "2,000 EUR · 10 · Austria, Germany · 14 days".
 * Driven by the profile's schema, never by a field name. Empty parts are left out; an empty result means no line.
 */
export function giveSummaryLine(input: {
  limits?: Record<string, string | number> | null;
  scope?: Record<string, unknown> | null;
  durationSeconds?: number | null;
  boundsSchema?: SchemaLike;
  hidden?: ReadonlySet<string>;
}): string {
  const parts: string[] = limitRows(input.limits ?? {}, input.boundsSchema, input.hidden).map(r => r.value);
  for (const [k, v] of Object.entries(input.scope ?? {})) {
    if (k === 'profile' || k === 'path') continue;
    const text = Array.isArray(v) ? v.filter(x => typeof x === 'string' || typeof x === 'number').join(', ') : (typeof v === 'string' || typeof v === 'number') ? String(v) : '';
    if (text) parts.push(text);
  }
  if (input.durationSeconds && input.durationSeconds > 0) parts.push(durationText(input.durationSeconds));
  return parts.join(' · ');
}
