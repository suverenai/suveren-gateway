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
 * Wired into the read path today: the STATIC read gate (a required bound value,
 * e.g. `read_access == unlimited`) and per-item AGE enforcement
 * (`read_max_age_days`) — the only two read-denial mechanisms. Correspondent
 * COVERAGE denial (the superseded "authority scope binds reads" model) has been
 * removed: grant scope no longer restricts reads. See the §4 supersession
 * banner in doc/read-bounds-enforcement-plan.md.
 *
 * The participant/scope helpers below (`extractParticipants`, `emailDomain`,
 * `buildScopeQuery`, the `ScopeField` type) are NOT called by the read path.
 * They are the reserved substrate for the next slice — per-correspondent
 * overrides that *raise* the age window (doc §7) and restrictive-mode list
 * narrowing (doc §12) — kept and unit-tested so that slice reuses them intact
 * rather than re-deriving them. They deliberately do NOT implement coverage.
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

// ── F9: read governance must be declared, never inferred from absence ────────
//
// A `category:"read"` tool is GOVERNED iff it declares at least one of:
//   • a static read gate (`boundField`), OR
//   • a per-item read adapter (`read`), OR
//   • an explicit exemption (`readGovernance: "none"`).
// Anything else is DENIED at call time. This is the single definition of
// "governed" shared by the runtime read path and the manifest lint, so the two
// can never disagree about what passes.

/** Minimal view of a read tool's governance declaration (manifest or resolved gating). */
export interface ReadGovernanceView {
  boundField?: string;
  read?: unknown;
  readGovernance?: string;
}

/** True iff a read tool declares governance (gate, adapter, or explicit exemption). */
export function readToolIsGoverned(g: ReadGovernanceView | undefined): boolean {
  if (!g) return false;
  return Boolean(g.boundField) || g.read != null || g.readGovernance === 'none';
}

// ── Resource scope on reads (F7) ─────────────────────────────────────────────
//
// A RESOURCE scope bounds *which container* a read may touch (calendar, mail
// folder/label, drive, project) — as opposed to age (how old) or counterparty
// (who is on it). The container the grant permits is a subset field on the
// authority's context (e.g. `allowed_calendars`); the tool names the requested
// container in an argument (`calendarId`) or returns it on each item
// (`list_calendars` → `id`). All generic — the field/arg/path names are manifest
// data, never literals here.
//
// FAIL-CLOSED: an empty allowed set (no grant lists any container) permits
// NOTHING. This is deliberate and differs from the send-side "unscoped = all":
// on reads, "unset" must not silently expose every container (that is the
// family-calendar hole). Grants/templates must name the containers they permit.

/**
 * The union of permitted container ids across the matching authorities, read
 * from each authority's context field `boundField`. Most-permissive semantics:
 * a read is allowed if SOME grant permits the container, so the effective set is
 * the union. Returns a (possibly empty) set — an empty set means DENY ALL.
 */
export function allowedResources(
  contexts: Array<Record<string, string | number> | undefined>,
  boundField: string,
): Set<string> {
  const out = new Set<string>();
  for (const ctx of contexts) {
    for (const v of tokenSet(ctx?.[boundField])) out.add(v);
  }
  return out;
}

/**
 * Which of the requested containers are NOT permitted. Empty result ⇒ all
 * permitted. `requested` empty ⇒ the caller substituted the tool's default
 * before calling (an omitted arg still resolves to a concrete container, so it
 * is still checked — never a bypass).
 */
export function deniedResources(requested: string[], allowed: Set<string>): string[] {
  return requested.filter(r => !allowed.has(r));
}

/**
 * Filter an array of result items to those whose container id (`idPath`, dotted)
 * is in the allowed set. For enumeration tools (`list_calendars`) so an excluded
 * container's very existence isn't disclosed.
 */
export function filterItemsByResource(items: unknown[], idPath: string, allowed: Set<string>): unknown[] {
  return items.filter(it => {
    const id = getByDottedPath(it, idPath);
    return typeof id === 'string' && allowed.has(id);
  });
}

/**
 * True if a fetched item carries a forbidden value at `valuesPath` (dotted) —
 * used to block a get-by-id whose item is in an excluded container (e.g. a Gmail
 * message labelled SPAM/TRASH). Handles an array field (labelIds) or a scalar.
 * Provider-agnostic: the path and the forbidden set are manifest data.
 */
export function hasBlockedValue(item: unknown, valuesPath: string, blocked: Set<string>): boolean {
  const v = getByDottedPath(item, valuesPath);
  const arr = Array.isArray(v) ? v : v != null ? [v] : [];
  return arr.some(x => typeof x === 'string' && blocked.has(x));
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


/**
 * Does the agent's own query ask for data OLDER than the window allows?
 *
 * The age ceiling is ANDed onto the agent's search, which is safe but silent:
 * asking for mail 90-120 days old against a 90-day window produces
 * `(older_than:90d newer_than:120d) newer_than:90d` — a contradiction that
 * returns ZERO results with no indication the request was narrowed. The agent
 * then reports "there are no such emails", which is false: they exist and are
 * simply out of bounds. A confident wrong answer, which is worse than a
 * refusal.
 *
 * Declarative rather than hardcoded: the manifest's read adapter supplies
 * `ageConflictPattern`, a regex whose first capture group is a number of days.
 * The engine never learns any provider's query syntax.
 *
 * Returns the requested age in days when it exceeds the ceiling, else null.
 */
export function detectAgeConflict(
  agentQuery: string | undefined,
  conflictPattern: string | undefined,
  maxAgeDays: number | null,
): number | null {
  if (!agentQuery || !conflictPattern || maxAgeDays === null) return null;

  let re: RegExp;
  try {
    re = new RegExp(conflictPattern, 'gi');
  } catch {
    return null; // a malformed pattern must not break reads
  }

  let worst: number | null = null;
  for (const match of agentQuery.matchAll(re)) {
    const days = Number(match[1]);
    if (!Number.isFinite(days)) continue;
    // `older_than:90d` against a 90-day ceiling can only ever match the empty
    // set, so >= rather than >.
    if (days >= maxAgeDays && (worst === null || days > worst)) worst = days;
  }
  return worst;
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

/**
 * First parseable timestamp among candidate paths, or null.
 *
 * A provider may return the same logical date in more than one shape — a
 * calendar's timed events carry `start.dateTime`, all-day events `start.date`.
 * Declaring both keeps the engine provider-agnostic; trying them in order
 * keeps the answer deterministic. Null when none parses, so callers fail
 * closed exactly as they do for a missing path.
 */
export function firstParsableDate(obj: unknown, paths: string | string[]): number | null {
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const parsed = parseMessageTimestamp(getByDottedPath(obj, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Render a provider's age clause. `{days}` gives the window as a day count
 * (Gmail: "newer_than:30d"); `{date}` gives the absolute UTC floor as
 * YYYY-MM-DD (Slack: "after:2026-06-30"). Both are substituted, so a template
 * may use either without the engine knowing which provider it serves.
 */
export function renderAgeConstraint(template: string, maxAgeDays: number, nowMs: number): string {
  const floorIso = new Date(nowMs - maxAgeDays * MS_PER_DAY).toISOString();
  return template
    .replace(/\{days\}/g, String(maxAgeDays))
    .replace(/\{date\}/g, floorIso.slice(0, 10));
}

/**
 * The earliest instant a read may reach, rendered for the provider's argument.
 *
 * `epoch_s` is emitted as a string because the providers that use it (Slack's
 * `oldest`) specify a string-encoded epoch; sending a bare number is rejected.
 */
export function ageFloorValue(
  maxAgeDays: number,
  nowMs: number,
  format: 'iso' | 'epoch_ms' | 'epoch_s' = 'iso',
): string | number {
  const floorMs = nowMs - maxAgeDays * MS_PER_DAY;
  if (format === 'epoch_ms') return floorMs;
  if (format === 'epoch_s') return String(Math.floor(floorMs / 1000));
  return new Date(floorMs).toISOString();
}

/**
 * Clamp a caller-supplied lower time bound so it never reaches past the
 * window. Returns the value to send.
 *
 * Only ever NARROWS: an agent asking for a tighter range keeps it. An omitted
 * bound is replaced, because at most providers "no lower bound" means all
 * history — the case the window exists to stop. An unparseable bound is also
 * replaced rather than forwarded, so junk cannot wash out the ceiling.
 */
export function clampAgeFloor(
  requested: unknown,
  maxAgeDays: number,
  nowMs: number,
  format: 'iso' | 'epoch_ms' | 'epoch_s' = 'iso',
): string | number {
  const floorMs = nowMs - maxAgeDays * MS_PER_DAY;
  const asked = parseMessageTimestamp(requested);
  if (asked !== null && asked >= floorMs) return requested as string | number;
  return ageFloorValue(maxAgeDays, nowMs, format);
}

// ── Participant / scope helpers (RESERVED for the overrides slice) ───────────
//
// NOT wired into the read path — see the module header. These are pure,
// profile-agnostic building blocks the per-correspondent-override slice will
// consume: extract a message's participants, normalize addresses/domains, and
// (for restrictive-mode list narrowing) union a set of identifiers into a
// provider search clause. They do NOT decide read permission; age is the only
// denial reason today.

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

/** A scope dimension: a set of emails or domains. */
export interface ScopeField {
  kind: 'email' | 'domain';
  values: Set<string>;
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
 * Union a set of scope-field groups into one provider search clause, e.g.
 * `((from:a@x OR to:a@x) OR (from:b@y OR to:b@y))`. Returns '' (no filter) when
 * any group is unconstrained. `termTemplate` (manifest) is the provider syntax,
 * e.g. "(from:{v} OR to:{v})".
 *
 * RESERVED: the overrides slice will call this with the read-policy's override
 * identifiers to narrow a restrictive-mode (`default = 0`) list query. It is not
 * a coverage check — it only builds a query clause.
 */
export function buildScopeQuery(scopeFieldGroups: ScopeField[][], termTemplate: string): string {
  const values = new Set<string>();
  for (const fields of scopeFieldGroups) {
    const constrained = fields.filter(f => f.values.size > 0);
    if (constrained.length === 0) return ''; // an unscoped authority ⇒ no filter
    for (const f of constrained) for (const v of f.values) values.add(v);
  }
  if (values.size === 0) return '';
  const terms = [...values].sort().map(v => termTemplate.replaceAll('{v}', v));
  return `(${terms.join(' OR ')})`;
}
