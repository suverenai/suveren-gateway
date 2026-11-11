/**
 * The words about a shared limit — ONE place, used by the mandate form, the
 * mandate card, the approval card (label "Team limit per day (3 of 5 used)")
 * and by the result of a refusal after approval ("Not sent. The daily limit is
 * used up: 5 of 5 emails today.").
 *
 * Nothing here names a connector, a profile or a field. Every word comes from
 * the profile's bounds schema (`boundType.kind` / `window`, `unit`,
 * `displayName`, `appliesTo`) and from the numbers the Authority Server sent.
 * Two optional words come from the CONNECTOR MANIFEST (`limitWords`, keyed by
 * the bound's key), never from the profile: a published profile is hashed
 * into signed mandates, so changing it would force re-signing.
 *   - `noun`           the plural thing that is counted ("emails")
 *   - `pastParticiple` what did not happen ("sent")
 * Without them the sentence is still true, just plainer ("Not done." / no noun).
 *
 * The server's English message is never parsed. If the structured values
 * (`field`, `expected`, `actual`) are absent, the sentence falls back to the
 * code alone, then to the Authority Server's own message shown whole.
 */
import type { AgentProfile } from '@hap/core';
import { formatUnit } from './bound-format';

type Window = 'daily' | 'weekly' | 'monthly';

const WINDOW_WORDS: Record<Window, { adj: string; per: string; tail: string }> = {
  daily: { adj: 'daily', per: 'day', tail: 'today' },
  weekly: { adj: 'weekly', per: 'week', tail: 'this week' },
  monthly: { adj: 'monthly', per: 'month', tail: 'this month' },
};

interface BoundDef {
  displayName?: string;
  unit?: string;
  appliesTo?: readonly string[];
  boundType?: { kind?: string; window?: string };
}

/** What a manifest declares per bound key (manifest `limitWords`). */
export type LimitWords = Record<string, { noun: string; pastParticiple: string } | undefined>;

/** The `limitWords` of the manifest that owns this tool (`<integration>__<tool>`), if any. */
export function limitWordsForTool(
  manifests: ReadonlyArray<{ id: string; limitWords?: LimitWords | null }> | undefined,
  tool: string,
): LimitWords | undefined {
  const id = tool.split('__')[0];
  return manifests?.find((m) => m.id === id)?.limitWords ?? undefined;
}

/** The `limitWords` of the manifest(s) serving this profile (by short id), merged. */
export function limitWordsForProfile(
  manifests: ReadonlyArray<{ profile?: string; limitWords?: LimitWords | null }> | undefined,
  profileId: string,
): LimitWords | undefined {
  const short = profileId.replace(/@.*$/, '').split('/').pop();
  const found = (manifests ?? []).filter((m) => m.profile === short && m.limitWords);
  return found.length ? Object.assign({}, ...found.map((m) => m.limitWords)) : undefined;
}

export interface CumulativeBound {
  key: string;
  kind: 'cumulative_count' | 'cumulative_sum';
  window: Window;
  displayName: string;
  unit?: string;
  appliesTo?: readonly string[];
}

function fieldsOf(profile: AgentProfile | null | undefined): Record<string, BoundDef> {
  return ((profile?.boundsSchema?.fields ?? {}) as unknown) as Record<string, BoundDef>;
}

function asCumulative(key: string, def: BoundDef | undefined): CumulativeBound | null {
  const bt = def?.boundType;
  if (!def || !bt || (bt.kind !== 'cumulative_count' && bt.kind !== 'cumulative_sum')) return null;
  if (bt.window !== 'daily' && bt.window !== 'weekly' && bt.window !== 'monthly') return null;
  return {
    key,
    kind: bt.kind,
    window: bt.window,
    displayName: def.displayName ?? key,
    unit: def.unit,
    appliesTo: def.appliesTo,
  };
}

/** The profile's cumulative bound under this key, or null (not one, or unknown). */
export function cumulativeBound(profile: AgentProfile | null | undefined, key: string): CumulativeBound | null {
  return asCumulative(key, fieldsOf(profile)[key]);
}

/** Every cumulative bound the profile declares. */
export function cumulativeBounds(profile: AgentProfile | null | undefined): CumulativeBound[] {
  return Object.entries(fieldsOf(profile)).flatMap(([k, d]) => { const b = asCumulative(k, d); return b ? [b] : []; });
}

function fmtAmount(n: number, unit?: string): string {
  const u = formatUnit(unit);
  const s = n.toLocaleString('en-US');
  return u ? `${s} ${u}` : s;
}

// ─── Wording B: the shared limit ────────────────────────────────────────────

/** What a cumulative limit of 0 says instead of "0 of 0 used". */
export const NOT_ALLOWED = 'not allowed';

export interface SharedLimitLabel {
  /** "Team limit per day" — plus " · <field name>" when two limits share a window. */
  name: string;
  /** "3 of 5 used" — what the system read; undefined while it cannot be proven. */
  figures?: string;
  /** name + " (" + figures + ")" */
  text: string;
}

/**
 * "Team limit per day (3 of 5 used)". `team` false (a personal workspace) reads
 * "Limit per day": there is no team to share it with. `used` is what the
 * system proved (never a guess) — without it the brackets are left out.
 */
export function sharedLimitLabel(opts: {
  profile: AgentProfile | null | undefined;
  key: string;
  team: boolean;
  used?: number;
  /**
   * True only for a count the Authority Server made across the whole team.
   * In a team, a count read from this account's own tickets is NOT the team's:
   * a wrong number is worse than none, so without this flag a team shows no
   * figure at all. (The server does not supply a team-wide count yet.)
   */
  usedIsTeamWide?: boolean;
  limit?: number | string;
  /**
   * The other bound keys shown in the same list (a mandate card or the form
   * lists every limit at once). Any of them that is cumulative in the same
   * window makes this row need its own name — otherwise three rows all read
   * "Team limit per day". Without it, only limits that can govern the same
   * action count (the approval card shows just the governing ones).
   */
  shownWith?: readonly string[];
  /** The manifest's `limitWords`: its noun names the row before the profile's displayName does. */
  words?: LimitWords;
}): SharedLimitLabel | null {
  const b = cumulativeBound(opts.profile, opts.key);
  if (!b) return null;
  const w = WINDOW_WORDS[b.window];
  // Two limits in one window only need telling apart when they can govern the same action.
  const overlap = (o: CumulativeBound) => !o.appliesTo || !b.appliesTo || o.appliesTo.some((a) => b.appliesTo!.includes(a));
  const shown = opts.shownWith ? new Set(opts.shownWith) : null;
  const ambiguous = cumulativeBounds(opts.profile).some((o) => o.window === b.window && o.key !== b.key
    && (shown ? shown.has(o.key) : overlap(o)));
  const base = `${opts.team ? 'Team limit' : 'Limit'} per ${w.per}`;
  const noun = opts.words?.[b.key]?.noun;
  const what = noun ? noun.charAt(0).toUpperCase() + noun.slice(1) : b.displayName;
  const name = ambiguous ? `${base} · ${what}` : base;
  const limit = Number(opts.limit);
  // A limit of 0 is not a budget to count against: it means the action is not allowed.
  if (opts.limit !== undefined && opts.limit !== '' && limit === 0) {
    return { name, figures: NOT_ALLOWED, text: `${name} (${NOT_ALLOWED})` };
  }
  const used = opts.team && !opts.usedIsTeamWide ? undefined : opts.used;
  let figures: string | undefined;
  if (used !== undefined && Number.isFinite(used) && opts.limit !== undefined && opts.limit !== '' && Number.isFinite(limit)) {
    figures = b.kind === 'cumulative_sum'
      ? `${fmtAmount(used!, b.unit)} of ${fmtAmount(limit, b.unit)} used`
      : `${used} of ${limit} used`;
  }
  return { name, figures, text: figures ? `${name} (${figures})` : name };
}

/** The helper line under the field — only where several people share the number. */
export function sharedLimitHelper(bound: CumulativeBound, team: boolean, words?: LimitWords): string | null {
  if (!team) return null;
  const noun = words?.[bound.key]?.noun;
  return noun
    ? `Every colleague's ${noun} count toward this one number.`
    : 'Everyone on the team counts toward this one number.';
}

// ─── Wording A: the refusal after approval ──────────────────────────────────

/** What the Authority Server recorded on a refused proposal. */
export interface RefusalData {
  code: string;
  message: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface RefusalSentence {
  text: string;
  /** Where the words came from: structured values, the code alone, or the server's message shown whole. */
  basis: 'data' | 'code' | 'message';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * "Not sent. The daily limit is used up: 5 of 5 emails today."
 *
 * For a counted limit the Authority Server's `expected` is the limit and
 * `actual` the count the call would have reached (limit + 1); the sentence
 * says "limit of limit" because that is what is true. For a summed limit
 * `actual` is the total the call would have reached.
 */
export function refusalSentence(refusal: RefusalData, profile: AgentProfile | null | undefined, words?: LimitWords): RefusalSentence {
  const bound = refusal.field ? cumulativeBound(profile, refusal.field) : null;
  const w0 = refusal.field ? words?.[refusal.field] : undefined;
  const lead = w0?.pastParticiple ? `Not ${w0.pastParticiple}.` : 'Not done.';
  const limit = num(refusal.expected);

  if (refusal.code === 'CUMULATIVE_LIMIT_EXCEEDED') {
    if (bound && limit !== undefined) {
      const w = WINDOW_WORDS[bound.window];
      if (bound.kind === 'cumulative_count') {
        const noun = w0?.noun ? ` ${w0.noun}` : '';
        return { text: `${lead} The ${w.adj} limit is used up: ${limit} of ${limit}${noun} ${w.tail}.`, basis: 'data' };
      }
      const total = num(refusal.actual);
      return {
        text: total !== undefined
          ? `${lead} The ${w.adj} limit would be exceeded: ${fmtAmount(total, bound.unit)} of ${fmtAmount(limit, bound.unit)} ${w.tail}.`
          : `${lead} The ${w.adj} limit is used up: ${fmtAmount(limit, bound.unit)} ${w.tail}.`,
        basis: 'data',
      };
    }
    return { text: `${lead} A shared limit is used up.`, basis: 'code' };
  }

  if (refusal.code === 'BOUND_EXCEEDED') {
    const def = refusal.field ? fieldsOf(profile)[refusal.field] : undefined;
    const actual = num(refusal.actual);
    if (def && limit !== undefined && actual !== undefined) {
      const name = def.displayName ?? refusal.field!;
      return { text: `${lead} ${name}: ${fmtAmount(actual, def.unit)} is above the limit of ${fmtAmount(limit, def.unit)}.`, basis: 'data' };
    }
  }

  if (refusal.code === 'MANDATE_REVOKED') return { text: `${lead} This mandate was revoked.`, basis: 'code' };
  if (refusal.code === 'MANDATE_EXPIRED') return { text: `${lead} This mandate has expired.`, basis: 'code' };

  const msg = refusal.message?.trim();
  return { text: msg ? `${lead} ${msg}` : `${lead} The Authority Server refused it.`, basis: 'message' };
}
