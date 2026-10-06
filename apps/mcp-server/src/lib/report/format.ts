/**
 * Report display formatters — work-plan "evidence-backed reports" polish
 * (2026-10-05): "No raw technical values anywhere a manager reads." This
 * module is the SINGLE place that turns verifier output (unix seconds, raw
 * tool names, profile bounds keys, did:key owner ids) into text a non-
 * technical reader can judge — used by both `render-report.ts` (the
 * gateway-drawn `sv-*` cards in the iframe) and `verify-report.ts` (the
 * "Checked values" side-panel summaries), so the two surfaces never drift.
 *
 * The raw values these functions replace are NOT deleted anywhere in the
 * verifier's own data — `VerifiedElement.data` keeps them (ticket id, raw
 * action, unix time, …) exactly as before, for the UI's own collapsed
 * "Technical details" section and for every internal computation (proof
 * counting, case ordering, metrics) that must keep working on real numbers.
 */
import { getProfile, type FieldUnit } from '@hap/core';

// ─── Time & duration ────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Unix seconds -> "5 Oct, 14:26" in the gateway process's own local time zone
 * (this module runs on the customer's machine — "local" IS correct here,
 * unlike a hosted service that would need to pick a zone to show a visitor).
 * Deliberately NOT `toLocaleString()`: that depends on ICU data / the
 * runtime's default locale, which is not guaranteed to produce this shape
 * (or anything deterministic for tests) across environments.
 */
export function formatDateTime(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 'unknown time';
  const d = new Date(n * 1000);
  const day = d.getDate();
  const month = MONTHS[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month}, ${hh}:${mm}`;
}

/** Seconds -> "30 min" under an hour, "1 h 05 min" at or above. Never a raw
 *  second count (the thing this exists to prevent: "1800s"). */
export function formatDuration(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 'unknown duration';
  const mins = Math.round(n / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs} h ${String(rem).padStart(2, '0')} min`;
}

// ─── Numbers & currency ─────────────────────────────────────────────────────

/** "5000" -> "5 000" — a plain space thousands separator, deliberately not
 *  `toLocaleString()` (locale-dependent separator, not deterministic in tests). */
function groupThousands(n: number): string {
  const sign = n < 0 ? '-' : '';
  const [intPart, frac] = Math.abs(n).toString().split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return sign + grouped + (frac ? `.${frac}` : '');
}

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

/** "4380", "EUR" -> "€ 4 380". Unknown currency codes show as-is ("CHF 4 380"). */
export function formatCurrency(amount: unknown, currencyCode: string | undefined): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? '');
  if (!currencyCode) return groupThousands(n);
  const code = currencyCode.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol} ${groupThousands(n)}` : `${code} ${groupThousands(n)}`;
}

/** Renders a profile bound's VALUE per its declared `unit` — the counterpart
 *  to the UI's `BoundsEditor.tsx#formatUnit` (same unit vocabulary), but
 *  producing a full human string rather than a bare suffix. `fallbackCurrency`
 *  is used only when the bound has no currency-typed unit of its own (e.g. an
 *  older profile) but the mandate's own context names one. */
export function formatBoundValue(unit: FieldUnit | string | undefined, value: unknown, fallbackCurrency?: string): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (!unit || unit === 'count') {
    return fallbackCurrency ? formatCurrency(n, fallbackCurrency) : groupThousands(n);
  }
  if (unit === 'minutes') return `${groupThousands(n)} min`;
  if (unit === 'hours') return `${groupThousands(n)} h`;
  if (unit === 'days') return `${groupThousands(n)} d`;
  if (unit === 'percent') return `${groupThousands(n)}%`;
  if (unit.startsWith('currency:')) return formatCurrency(n, unit.slice('currency:'.length));
  return `${groupThousands(n)} ${unit}`;
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * "value_max", 5000, "sales@0.3" -> "Max value per quote or order: € 5 000" —
 * reads `displayName`/`unit` from the profile's `boundsSchema` via the
 * gateway's own profile loader/registry (`@hap/core#getProfile`, the same
 * registry `profile-loader.ts` populates at startup). Falls back to a
 * humanized key when the profile is unknown or declares no displayName for
 * this field — NEVER the raw key alone with no formatting.
 */
export function formatBoundLabel(profileId: string | undefined, key: string, value: unknown, fallbackCurrency?: string): string {
  const profile = profileId ? getProfile(profileId) : undefined;
  const field = profile?.boundsSchema?.fields?.[key];
  const displayName = field?.displayName ?? humanizeKey(key);
  return `${displayName}: ${formatBoundValue(field?.unit, value, fallbackCurrency)}`;
}

// ─── Mandate owners ─────────────────────────────────────────────────────────

/** The owner label when no name was disclosed. Neutral on purpose (RR3,
 *  2026-10-06): no part of the key either — in team mode an owner's did:key
 *  carries the account id, and a report shows a name only when that person
 *  disclosed it. */
export const UNDISCLOSED_OWNER_LABEL = 'Owner (name not disclosed)';

/** A did:key is never shown, not even truncated — see UNDISCLOSED_OWNER_LABEL. */
export function formatOwnerLabel(did: string): string {
  if (!did) return 'Unknown owner';
  return UNDISCLOSED_OWNER_LABEL;
}

// ─── Profile / action labels ────────────────────────────────────────────────

/** "sales@0.3" -> "Sales" — the short, capitalized profile name a manager
 *  recognizes, same derivation the Reports page already uses for "written by
 *  the AI under mandate X" (ReportsPage.tsx#findMandateLabel). */
export function profileShortLabel(profileId: string | undefined): string {
  if (!profileId) return 'Unknown profile';
  const name = profileId.split('@')[0].split('/').pop();
  if (!name) return profileId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Known tool-name -> label overrides for the actions the simulator
 *  connectors actually produce (hap-erp-mcp/hap-crm-mcp/hap-email-mcp),
 *  covering the compound cases ("convert X to Y") a verb+object split cannot
 *  derive on its own. Keyed WITHOUT the `<system>__` prefix. */
const ACTION_LABELS: Record<string, string> = {
  create_quote: 'Quote created',
  update_quote: 'Quote updated',
  send_quote: 'Quote sent',
  convert_quote_to_order: 'Order placed',
  create_order: 'Order created',
  update_order: 'Order updated',
  send_message: 'Reply sent',
  send_email: 'Reply sent',
  create_contact: 'Contact created',
  update_contact: 'Contact updated',
  create_deal: 'Deal created',
  update_deal: 'Deal updated',
  create_task: 'Task created',
  update_task: 'Task updated',
  log_activity: 'Activity logged',
  create_record: 'Record created',
  update_record: 'Record updated',
  delete_record: 'Record deleted',
  create_event: 'Event created',
  update_event: 'Event updated',
  delete_event: 'Event deleted',
  publish_post: 'Post published',
};

/** Irregular past participles for verbs a tool name may start with — the
 *  plain "+ed" rule produced "Report writed" for `report__write_report`
 *  (review of a real export, 2026-10-06). Read-style verbs (get/list/find)
 *  are included only so a future write tool named that way still reads as
 *  English; read tools carry no ticket and so rarely reach a label. */
const IRREGULAR_PAST: Record<string, string> = {
  write: 'written', rewrite: 'rewritten', send: 'sent', resend: 'resent',
  run: 'run', rerun: 'rerun', set: 'set', reset: 'reset', put: 'put',
  make: 'made', build: 'built', rebuild: 'rebuilt', begin: 'begun',
  take: 'taken', give: 'given', do: 'done', redo: 'redone', read: 'read',
  find: 'found', get: 'retrieved', buy: 'bought', pay: 'paid', sell: 'sold',
  hold: 'held', keep: 'kept', leave: 'left', draw: 'drawn', withdraw: 'withdrawn',
  forbid: 'forbidden', choose: 'chosen', speak: 'spoken', meet: 'met',
  lead: 'led', split: 'split', cut: 'cut', upload: 'uploaded', forward: 'forwarded',
  bring: 'brought', tell: 'told', show: 'shown', drive: 'driven', break: 'broken',
};

/** Short verbs whose final consonant doubles before "-ed" (stop -> stopped). */
const DOUBLE_FINAL = new Set(['stop', 'plan', 'ship', 'tag', 'log', 'submit', 'drop', 'flag', 'pin', 'unpin', 'map', 'wrap', 'chat', 'admit', 'commit', 'permit', 'refer', 'transfer']);

function pastTense(verb: string): string {
  if (!verb) return verb;
  const lower = verb.toLowerCase();
  if (IRREGULAR_PAST[lower]) return IRREGULAR_PAST[lower];
  if (DOUBLE_FINAL.has(lower)) return `${verb}${verb.slice(-1)}ed`;
  if (/e$/.test(verb)) return `${verb}d`;
  if (/[^aeiou]y$/i.test(verb)) return `${verb.slice(0, -1)}ied`; // apply -> applied, reply -> replied
  return `${verb}ed`;
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * "erp__create_quote" -> "Quote created". Looks up the known-action table
 * first (covers the compound "convert ... to ..." tool names a mechanical
 * split cannot read correctly); falls back to a generic verb+object split
 * ("book_meeting" -> "Meeting booked") for anything not listed, so an
 * integration this table does not yet know about still reads as English
 * rather than a raw tool name. The raw tool name itself belongs only in the
 * detail panel's "Technical details" section, never here.
 */
export function formatActionLabel(action: unknown): string {
  const raw = String(action ?? '').trim();
  if (!raw) return 'Action';
  const withoutSystem = raw.includes('__') ? raw.slice(raw.indexOf('__') + 2) : raw;
  const known = ACTION_LABELS[withoutSystem];
  if (known) return known;

  const parts = withoutSystem.split('_').filter(Boolean);
  if (parts.length === 0) return capitalize(raw);
  const [verb, ...rest] = parts;
  if (rest.length === 0) return capitalize(pastTense(verb));
  return `${capitalize(rest.join(' '))} ${pastTense(verb)}`;
}

// ─── Metrics (shared between the drawn sv-metric card and "Checked values") ─

export const METRIC_LABELS: Record<string, string> = {
  completed: 'cases completed',
  'median-time': 'median time, start → goal',
  'average-time': 'average time, start → goal',
  'without-approval': 'share without approval',
  approvals: 'approvals',
  'median-approval-wait': 'median approval wait',
  tickets: 'tickets',
  refusals: 'system refusals',
};

/** The sv-metric card's big number, formatted per its own kind — a percentage
 *  for "without-approval", a duration for the two time-based kinds, a plain
 *  count otherwise. Shared so "Checked values" shows the SAME figure, never a
 *  recomputed or differently-rounded one. */
export function formatMetricValue(kind: string, value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (kind === 'without-approval' && Number.isFinite(n)) return `${Math.round(n * 100)}%`;
  if ((kind === 'median-time' || kind === 'average-time' || kind === 'median-approval-wait') && Number.isFinite(n)) {
    return formatDuration(n);
  }
  return String(value);
}
