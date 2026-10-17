/**
 * What a ticket shows about its content (UI spec §13.4 + §14, signed off
 * 2026-10-17; mockup temp/ticket-content-mockup/index.html): the headline
 * sentence, "What was sent" at one of two levels, and "Result". Pure and
 * unit-tested — components/TicketWhatWasDone.tsx and TicketHeadline.tsx only
 * render what these functions return and run the one async hash check
 * (lib/content-hash.ts).
 *
 * Two levels, told apart by form, never by colour (§14.1):
 *  - `sealed`   — the signed ticket carries a fingerprint (`contentHash`) of
 *                 the content and the archived preimage is here to check it.
 *                 Only this level may say "sealed in the ticket".
 *  - `recorded` — this gateway's own copy of what it executed (`sentArgs`,
 *                 or an approved ticket's archived proposal args), checked
 *                 by the control plane against the execution journal's hash
 *                 (`sentArgsCheck`). Never claims more than "recorded".
 * plus `not-kept` (an entry from before this release, or args too large to
 * keep) and `off-device` (no local archive entry at all).
 *
 * No AI text is presented as anything else, no lookups in other systems:
 * every value is the ticket's own, or this device's evidence of it, labelled
 * from the connector manifest (approval view), never from the AI.
 */
import { argRows, humanizeKey, type ArgRow, type ExecutionMappingValue, type ToolDisplay } from './approval-view';
import { sealedSummary } from './approval-summary';
import type { IntegrationManifest, SentArgsCheck, TicketResult } from './sp-client';

// ─── Headline (§13.4) ────────────────────────────────────────────────────────

/**
 * The ticket's headline: the manifest's summary sentence, filled from what
 * the approver saw (approved — the proposal's sealed args) or from what this
 * gateway sent (automatic — `sentArgs`, or object bound content). An
 * approved ticket never borrows the automatic source, and vice versa: the
 * sentence must come from what that kind of ticket actually rests on. No
 * template, a missing value, or nothing readable here → the manifest's
 * past-tense `label` ("Contact created").
 */
export function ticketHeadline(opts: {
  tool: string;
  manifests: IntegrationManifest[] | undefined;
  label: string;
  approved: boolean;
  proposalArgs?: Record<string, unknown> | null;
  sentArgs?: Record<string, unknown> | null;
}): string {
  const args = opts.approved ? opts.proposalArgs : opts.sentArgs;
  return sealedSummary(opts.tool, args ?? null, opts.manifests) ?? opts.label;
}

// ─── Level (§14.1, §14.3) ────────────────────────────────────────────────────

export type SentView =
  | { level: 'off-device' }
  | { level: 'not-kept'; reason: 'older' | 'too_large' }
  | {
      level: 'sealed';
      /** The fingerprint check against the signed ticket's `contentHash`. */
      check: 'ok' | 'failed';
      bound: Record<string, unknown> | string;
      /** Visible sent values the binding does not cover (e.g. an email's bcc) — recorded, not sealed. */
      extras: Record<string, unknown> | null;
      argsCheck: SentArgsCheck;
    }
  | { level: 'recorded'; content: Record<string, unknown> | string; check: SentArgsCheck };

/**
 * Which level to show. `hashVerified` is the async fingerprint check's
 * result, read only when `hasHashToCheck` (the ticket carries a signed
 * `contentHash` + `contentBinding`); callers wait for it before calling this.
 */
export function sentView(opts: {
  offDevice: boolean;
  boundContent?: Record<string, unknown> | string;
  sentArgs?: Record<string, unknown>;
  sentArgsOmitted?: 'too_large';
  /** An approved ticket's archived proposal args — the review path's sent args (not stored twice). */
  proposalArgs?: Record<string, unknown>;
  hasHashToCheck: boolean;
  hashVerified: boolean | null;
  sentArgsCheck?: SentArgsCheck;
}): SentView {
  if (opts.offDevice) return { level: 'off-device' };
  const args = opts.sentArgs ?? opts.proposalArgs;
  const argsCheck: SentArgsCheck = args ? (opts.sentArgsCheck ?? 'unchecked') : 'unchecked';
  if (opts.hasHashToCheck && opts.boundContent !== undefined) {
    return {
      level: 'sealed',
      check: opts.hashVerified === true ? 'ok' : 'failed',
      bound: opts.boundContent,
      extras: args ? unsealedExtras(opts.boundContent, args) : null,
      argsCheck,
    };
  }
  if (args) return { level: 'recorded', content: args, check: argsCheck };
  // Bound content kept but no signed fingerprint to check it against: still
  // only a record — never "sealed" on a check that could not run.
  if (opts.boundContent !== undefined) return { level: 'recorded', content: opts.boundContent, check: 'unchecked' };
  return { level: 'not-kept', reason: opts.sentArgsOmitted === 'too_large' ? 'too_large' : 'older' };
}

/**
 * The sent values the binding does NOT cover: keys absent from object bound
 * content, or — for a text binding, which binds one field's string — every
 * value other than that string. Hidden keys (`_source`, `ticket_id` …) are
 * dropped later by `sentRows`. Null when nothing is left.
 */
export function unsealedExtras(
  bound: Record<string, unknown> | string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof bound === 'string' ? v === bound : k in bound) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ─── Rows (§14.1) ────────────────────────────────────────────────────────────

export interface SentRow extends ArgRow {
  /** The signed ticket's executionContext carries this value too (via the manifest's executionMapping). */
  inTicket: boolean;
}

/**
 * Labels and order from the connector manifest's approval view — the same
 * `argRows` the approval card uses, so hidden keys (`_source`, `ticket_id`,
 * secrets) are hidden here too — plus the "in the ticket" tag.
 */
export function sentRows(
  args: Record<string, unknown>,
  display: ToolDisplay | undefined,
  executionContext: Record<string, unknown> | undefined,
): SentRow[] {
  return argRows(args, display).map((row) => ({
    ...row,
    inTicket: inTicket(row.value, display?.executionMapping?.[row.key], executionContext),
  }));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (String(a) === String(b)) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean' || a === '' || b === '' || a === null || b === null) return false;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/**
 * True only when the signed ticket verifiably carries THIS value: a direct
 * mapping with an equal value ("0.10" ≡ 0.1), a divisor mapping that divides
 * to it, or a `join` of it. A field derived from the value without being it
 * (`length` → a count, `join_domains` → domains only) is not tagged — the
 * ticket does not carry the value itself.
 */
export function inTicket(
  value: unknown,
  mapping: ExecutionMappingValue | undefined,
  executionContext: Record<string, unknown> | undefined,
): boolean {
  if (!mapping || !executionContext || value === undefined || value === null) return false;
  const entries = typeof mapping === 'string' ? [{ field: mapping }] : Array.isArray(mapping) ? mapping : [mapping];
  return entries.some((m: { field: string; divisor?: number; transform?: string }) => {
    if (!(m.field in executionContext)) return false;
    const signed = executionContext[m.field];
    if (m.divisor) return Number.isFinite(Number(value)) && Number(value) / m.divisor === Number(signed);
    if (m.transform === 'join') {
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((x) => (x && typeof x === 'object' && 'email' in x ? String((x as { email: unknown }).email) : String(x))).join(',') === String(signed);
    }
    if (m.transform) return false;
    return sameValue(value, signed);
  });
}

// ─── Result (§14.2) ──────────────────────────────────────────────────────────

export interface ResultRow { key: string; label: string; value: string }

export type ResultBody =
  | { kind: 'rows'; rows: ResultRow[] }
  | { kind: 'text'; text: string };

function display(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Nothing to say: null, "", [] or {}. */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/**
 * The answer's fields as rows — only what the answer ADDS: empty values are
 * left out, and so is a field that only repeats what was sent under the same
 * name (a CRM echoing back the name and email it was given).
 */
function asRows(obj: Record<string, unknown>, sent?: Record<string, unknown> | null): ResultRow[] {
  return Object.entries(obj)
    .filter(([key, v]) => !isEmpty(v) && !(sent && key in sent && display(sent[key]) === display(v)))
    .map(([key, v]) => ({ key, label: humanizeKey(key), value: display(v) }));
}

/**
 * What the tool answered, as the Result box shows it: `structuredContent`
 * fields as rows; else a text that is itself one JSON object (most
 * connectors answer `{"id":"c-1042"}` as text) as rows of the same values;
 * else the text as it came. Values are never reworded, only laid out —
 * and only what the answer adds (see `asRows`).
 */
export function resultBody(result: TicketResult, sent?: Record<string, unknown> | null): ResultBody {
  const sc = result.structuredContent;
  if (sc && typeof sc === 'object' && !Array.isArray(sc) && Object.keys(sc).length > 0) return { kind: 'rows', rows: asRows(sc, sent) };
  const t = result.text.trim();
  if (t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return { kind: 'rows', rows: asRows(parsed as Record<string, unknown>, sent) };
      }
    } catch { /* not JSON — shown as text */ }
  }
  return { kind: 'text', text: result.text };
}
