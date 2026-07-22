/**
 * Read-path enforcement — the checks a read (category:"read") tool must pass
 * before the gateway proxies it. See doc/read-bounds-enforcement-plan.md §1–§3.
 *
 * Historically the read path only checked "does a matching authorization
 * exist?" and then proxied verbatim — so declared read gates (e.g. records'
 * `read_access: unlimited`) were never enforced, and email's read bounds/scope
 * were ignored entirely (the pentest hole). This module holds the read-side
 * predicates; they are PURE and PROFILE-AGNOSTIC — driven by manifest
 * descriptors + the authorization's own bounds, never by hardcoded field names.
 *
 * This slice implements the STATIC read gate (a required bound value, e.g.
 * `read_access == unlimited`) plus per-item age and correspondent-scope
 * enforcement (`read_max_age_days`, `allowed_recipients`/`allowed_domains`).
 */

import { tokenSet } from './scope-specificity';

/** Static read gate declared by a manifest override (records-style). */
export interface StaticReadGate {
  /** The authorization bound that must hold for the read to be permitted. */
  boundField?: string;
  /** The exact value that bound must have (enum equality). */
  requiredValue?: string;
}

/**
 * True if an authorization's bounds satisfy a tool's static read gate.
 *
 * No `boundField` declared ⇒ no static gate ⇒ permitted (other read checks,
 * added later, still apply). A declared gate is satisfied only when the bound
 * is present AND exactly equals `requiredValue` — fail-closed on a missing or
 * mismatched bound.
 */
export function boundsSatisfyReadGate(
  bounds: Record<string, string | number> | undefined,
  gate: StaticReadGate,
): boolean {
  if (!gate.boundField) return true;
  const actual = bounds?.[gate.boundField];
  return actual !== undefined && String(actual) === gate.requiredValue;
}

// ── Age enforcement (read_max_age_days) ──────────────────────────────────────
//
// Pure predicates behind the email read-age bound. They produce/compare
// `read_age_days`; enforcement itself reuses the Gatekeeper's existing
// per_transaction bound check (see doc §1a/§3.0) — no bound logic lives here.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse an item timestamp into epoch milliseconds — provider-agnostic. Handles
 * both epoch-millis (number or numeric string, e.g. Gmail `internalDate`) and
 * ISO/RFC3339 date strings (e.g. calendar events, CRM/records/Drive
 * `created`/`modified`). Returns null when absent or unparseable — callers MUST
 * fail closed on null (an item whose age can't be established cannot be shown
 * to be within bounds).
 *
 * The *location* of the timestamp in a provider's response is manifest data
 * (`resultDatePath`), not code — this function only normalizes the value.
 */
export function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n; // epoch millis
    const iso = Date.parse(value);
    if (Number.isFinite(iso)) return iso; // ISO / RFC3339
  }
  return null;
}

/** Whole-day age of a message (0 for anything in the current 24h). now injected for testability. */
export function ageInDays(timestampMs: number, nowMs: number): number {
  return Math.floor((nowMs - timestampMs) / MS_PER_DAY);
}

/**
 * The most-permissive read-age bound across the authorizations that matched
 * this read. A read is age-permitted if it falls within SOME matching
 * authority's window, so the effective cap is the maximum declared value of the
 * age-bound `field`. The `field` name is NOT hardcoded here — the caller
 * resolves it from the profile's boundsSchema (the bound whose `boundType`
 * compares the read adapter's produced age field). Returns null when no
 * matching authority declares it (⇒ no age bound applies).
 */
export function maxReadAgeDays(
  boundsList: Array<Record<string, string | number> | undefined>,
  field: string,
): number | null {
  let max: number | null = null;
  for (const b of boundsList) {
    const raw = b?.[field];
    const n = typeof raw === 'number' ? raw : raw !== undefined ? Number(raw) : NaN;
    if (Number.isFinite(n)) max = max === null ? n : Math.max(max, n);
  }
  return max;
}

/**
 * True if a message is OLDER than the allowed window (⇒ must be blocked/omitted).
 * A null timestamp is treated as too-old (fail closed).
 */
export function isOlderThanMaxAge(timestampMs: number | null, maxAgeDays: number, nowMs: number): boolean {
  if (timestampMs === null) return true;
  return ageInDays(timestampMs, nowMs) > maxAgeDays;
}

// ── Query composition (F8) ───────────────────────────────────────────────────
//
// Read limits on list/search are enforced BY CONSTRUCTION: the gateway ANDs its
// own clauses (age ceiling, correspondent scope) onto the query the AGENT
// supplied. That only holds if the agent's fragment cannot bind across the
// boundary. A bare space-join does not hold:
//
//     agent q = "older_than:365d OR"  ⇒  "older_than:365d OR newer_than:30d"
//
// ...which is a UNION, so the age ceiling stops constraining anything. Same for
// a trailing field operator ("from:" swallows the next term as its value) and
// for unbalanced parentheses. So: validate the fragment, then bracket it.
// Both — validation gives a clear denial, bracketing is the belt-and-braces.
//
// This is a property of the SHARED read path, not of any one provider: every
// manifest whose `queryArg` is a boolean expression language inherits it.

/** Outcome of composing an agent query with gateway-injected clauses. */
export interface ComposedQuery {
  /** False ⇒ the agent's fragment is unsafe to compose; the caller MUST deny. */
  ok: boolean;
  /** The query to send downstream. Present iff `ok`. */
  query?: string;
  /** Human-readable denial reason. Present iff not `ok`. */
  reason?: string;
}

/** A trailing binary/field operator would take the injected clause as its operand. */
const TRAILING_OPERATOR = /(?:^|\s)(?:OR|AND|NOT)$|[-+|&:]$/i;

/** True when parentheses outside quoted strings are balanced. */
function parensBalanced(s: string): boolean {
  let depth = 0;
  let inQuote = false;
  for (const c of s) {
    if (c === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return !inQuote && depth === 0;
}

/**
 * Compose the agent's query with gateway-injected clauses so the injected ones
 * are always ANDed at top level and can never be captured by the agent's
 * expression. `clauses` are rendered by the caller from MANIFEST templates —
 * no provider syntax is built here.
 *
 * Fails closed (`ok: false`) on a fragment that could escape; callers deny the
 * read rather than silently rewriting what the agent asked for.
 */
export function composeReadQuery(agentQuery: string | undefined, clauses: string[]): ComposedQuery {
  const injected = clauses.filter(c => typeof c === 'string' && c.trim() !== '').map(c => c.trim());
  const base = (agentQuery ?? '').trim();

  if (base === '') return { ok: true, query: injected.join(' ') };
  if (!parensBalanced(base)) {
    return { ok: false, reason: 'the requested search query has unbalanced parentheses' };
  }
  if (TRAILING_OPERATOR.test(base)) {
    return { ok: false, reason: 'the requested search query ends in a dangling operator' };
  }
  if (injected.length === 0) return { ok: true, query: base };
  return { ok: true, query: `(${base}) ${injected.join(' ')}` };
}

/** Minimal view of a profile's boundsSchema needed to resolve the age bound. */
export interface BoundsSchemaLike {
  fields?: Record<string, { boundType?: { kind?: string; of?: string } }>;
}

/**
 * Resolve WHICH bound governs a read adapter's age field — generically, from
 * the profile schema, with no field-name literal. The manifest adapter declares
 * the execution field it produces from an item's date (`ageField`, e.g.
 * "read_age_days"); the governing bound is the one whose `boundType` is a
 * `per_transaction` comparison `of` that field (email: `read_max_age_days`).
 * Returns null when the profile declares no such bound (⇒ no age limit applies).
 */
export function resolveAgeBoundField(boundsSchema: BoundsSchemaLike | undefined, ageExecField: string): string | null {
  const fields = boundsSchema?.fields;
  if (!fields) return null;
  for (const [name, def] of Object.entries(fields)) {
    if (def?.boundType?.kind === 'per_transaction' && def.boundType.of === ageExecField) return name;
  }
  return null;
}

/**
 * Read a value out of a provider response by a dotted path (e.g. "internalDate"
 * or "payload.internalDate"). Where the date lives is manifest data
 * (`resultDatePath`); this navigator is provider-agnostic. Returns undefined for
 * a missing path — callers fail closed.
 */
export function getByDottedPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    obj,
  );
}

// ── Scope / coverage enforcement (Option A — reads bind to correspondent scope) ──
//
// A read of a correspondent is permitted only if SOME matching authority's scope
// covers that correspondent — a specific grant naming them/their domain, or a
// generic (unscoped) grant that covers everyone. Absent any covering authority,
// the read is an AUTHORIZATION denial (not a bound denial): there is simply no
// grant that reaches this correspondent. All predicates below are pure and
// profile-agnostic — scope-field *kinds* come from the profile's contextSchema
// (`format: email` / `format: domain`), values from the authority's context.

/** Extract email addresses from a raw header value (handles "Name <a@x>, b@y"). */
export function extractEmails(headerValue: unknown): string[] {
  if (typeof headerValue !== 'string') return [];
  const m = headerValue.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return m ? m.map(e => e.toLowerCase()) : [];
}

/** The domain part of an email address, lowercased. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return (at >= 0 ? email.slice(at + 1) : email).toLowerCase();
}

/** Minimal view of a profile's contextSchema needed to classify scope fields. */
export interface ContextSchemaLike {
  fields?: Record<string, { format?: string }>;
}

/** A correspondent-scope dimension of one authority: emails or domains. */
export interface ScopeField {
  kind: 'email' | 'domain';
  values: Set<string>;
}

/**
 * Build the correspondent-scope fields of one authority, generically: iterate
 * the profile's contextSchema, take fields declared `format: email` or
 * `format: domain`, and read the authority's values for them. No field-name
 * literal — a new profile with differently-named scope fields works unchanged.
 */
export function resolveScopeFields(
  contextSchema: ContextSchemaLike | undefined,
  authContext: Record<string, string | number> | undefined,
): ScopeField[] {
  const fields = contextSchema?.fields;
  if (!fields) return [];
  const out: ScopeField[] = [];
  for (const [name, def] of Object.entries(fields)) {
    const kind = def?.format === 'email' ? 'email' : def?.format === 'domain' ? 'domain' : null;
    if (kind) out.push({ kind, values: tokenSet(authContext?.[name]) });
  }
  return out;
}

/**
 * True if an authority (described by `scopeFields`) covers AT LEAST ONE of the
 * message participants. An authority with no constrained scope field (every
 * dimension empty) is UNSCOPED ⇒ covers everyone.
 */
export function authorityCoversParticipants(participants: string[], scopeFields: ScopeField[]): boolean {
  const constrained = scopeFields.filter(f => f.values.size > 0);
  if (constrained.length === 0) return true; // unscoped ⇒ covers all correspondents
  return participants.some(p => {
    const email = p.toLowerCase();
    const dom = emailDomain(email);
    return constrained.some(f => (f.kind === 'email' ? f.values.has(email) : f.values.has(dom)));
  });
}

/**
 * Extract participant emails from a provider response via manifest descriptors:
 * `participantsPath` points at an array of `{name, value}` headers,
 * `headerNames` selects which headers carry correspondents (e.g. From, To).
 */
export function extractParticipants(response: unknown, participantsPath: string, headerNames: string[]): string[] {
  const arr = getByDottedPath(response, participantsPath);
  if (!Array.isArray(arr)) return [];
  const wanted = new Set(headerNames.map(h => h.toLowerCase()));
  const emails: string[] = [];
  for (const h of arr) {
    const name = (h as { name?: unknown })?.name;
    if (typeof name === 'string' && wanted.has(name.toLowerCase())) {
      emails.push(...extractEmails((h as { value?: unknown })?.value));
    }
  }
  return [...new Set(emails)];
}

/**
 * Build a provider search clause restricting a list/search to covered
 * correspondents, from the UNION of the matching authorities' scopes. Returns ''
 * (no correspondent filter) when ANY authority is unscoped — an unscoped grant
 * permits all correspondents. `termTemplate` (manifest) is the provider syntax,
 * e.g. "(from:{v} OR to:{v})".
 */
export function buildScopeQuery(perAuthScopeFields: ScopeField[][], termTemplate: string): string {
  const values = new Set<string>();
  for (const fields of perAuthScopeFields) {
    const constrained = fields.filter(f => f.values.size > 0);
    if (constrained.length === 0) return ''; // an unscoped authority ⇒ no filter
    for (const f of constrained) for (const v of f.values) values.add(v);
  }
  if (values.size === 0) return '';
  const terms = [...values].sort().map(v => termTemplate.replaceAll('{v}', v));
  return `(${terms.join(' OR ')})`;
}
