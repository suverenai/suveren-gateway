/**
 * The reporting window — which evidence the report tools may show at all
 * (work-plan "Added 2026-10-06 — regular reporting", RR2; closes SR1: the
 * reporting AI used to see the whole, never-pruned ticket archive, including
 * real work from long before the test).
 *
 * ONE window, applied once, at the source: `scopeReportSources()` wraps the
 * receipt archive and the connector export runner so that everything built on
 * them — list_tickets, get_ticket, list_cases, get_records, the verification of
 * every sv-* reference, coverage, and the export bundle — sees only evidence
 * from inside [start, end]. Nothing downstream filters again, so no tool can
 * forget to.
 *
 * Where the window comes from (the active `reporting` mandate, as the gateway
 * holds it — the same `bounds` the read gate checks `read_access` on):
 *
 *  - reporting@0.2+: the signed bound whose `boundType` is a `per_transaction`
 *    comparison of `read_age_days` (`read_max_age_days`) — resolved from the
 *    profile schema with the SAME helper the connector read gate uses
 *    (read-gate.ts#resolveAgeBoundField), never by field name. Clamped to the
 *    profile's `maximum` when the schema declares one. Window = [now − N days,
 *    now].
 *  - In simulation mode the window also starts no earlier than the test data's
 *    load time (`simulation_load.loaded_at` from the case source's export —
 *    the email connector's today, systems.ts `caseSystem`).
 *  - A mandate whose profile declares no such bound (reporting@0.1) is refused,
 *    in simulation mode too, with a message that says to create a new one
 *    (decision Andreas, 2026-10-06: old reporting mandates need not work).
 *
 * Several reporting mandates: the most permissive window wins (the earliest
 * start) — the same rule the connector read gate applies to read_max_age_days
 * (read-gate.ts#maxReadAgeDays): a read is permitted if SOME matching mandate
 * permits it.
 *
 * Window edges: start is inclusive (a ticket stamped exactly at start is in).
 * The end is "now" plus a small clock-skew allowance (END_SKEW_SECONDS): a
 * ticket the Authority Server stamped a moment ahead of this machine's clock is
 * not old — the window exists to hide OLD evidence, and dropping the newest
 * ticket because of a one-second skew would only make coverage flaky.
 */
import { getProfile } from '@hap/core';
import { profileMatches } from '../tool-proxy';
import { resolveAgeBoundField, maxReadAgeDays, type BoundsSchemaLike } from '../read-gate';
import { parseTimestampSeconds } from './time';
import { formatDateTime } from './format';
import { isCaseSourceExport } from './types';
import { caseSystem, isSystemExport, reportSystem } from './systems';
import type { ReportTableDeclaration } from '../tool-gating-types';
import type { ArchivedReceipt, ArchivedAuthorization } from '../receipt-archive';
import type { ReceiptArchiveReader, ReportSources, RunConnectorExport, ExportSystem } from './types';

/** The Report built-in's own declarations, defined once here and read from here
 *  everywhere else (builtins/report.ts included):
 *  - REPORT_AGE_FIELD: the execution field its reads produce from an item's
 *    date — what a connector's read adapter declares as `ageField`. The window
 *    bound is whichever profile bound compares it (`boundType.of`), found in the
 *    profile schema, never by the bound's own name.
 *  - REPORTING_PROFILE: the profile that governs it, by its short name. */
export const REPORT_AGE_FIELD = 'read_age_days';
export const REPORTING_PROFILE = 'reporting';
export const END_SKEW_SECONDS = 120;
/** Shown when the only reporting mandate is from a profile version without
 *  a reporting window (reporting@0.1). Deliberately names NO specific
 *  version: hardcoding one here is exactly what went stale across the v0.7
 *  switch (the message used to say "...(reporting@0.2)", which itself
 *  became un-issuable -- PROFILE_INVALID, retired decision_owner gate --
 *  the moment hap-profiles' v0.7 versions went live). The gateway's own
 *  mandate-creation UI always offers the current newest version; this
 *  message only needs to say that a new one is required. */
export const OLD_PROFILE_REFUSAL =
  'this reporting mandate is from an older profile version — create a new reporting mandate.';
const DAY = 86_400;

export interface ReportWindow {
  /** Unix seconds, inclusive. */
  start: number;
  /** Unix seconds — "now" when the window was resolved. Tickets up to
   *  end + END_SKEW_SECONDS are inside. */
  end: number;
  /** The lookback in days the mandate sets (after the profile's maximum). */
  days: number;
  /** The load time that clamped `start`, when it did. */
  loadedAt: number | null;
  /** Plain sentence for the AI and the UI, e.g. "since 5 Oct, 09:24 (the last 30 days)". */
  label: string;
}

export type WindowResolution =
  | { ok: true; window: ReportWindow }
  | { ok: false; reason: string };

/** What the window needs from a held mandate — EnrichedAuthorization fits. */
export interface WindowAuthorization {
  profileId: string;
  complete: boolean;
  bounds?: Record<string, string | number>;
  frame?: Record<string, string | number>;
}

export interface ResolveWindowInput {
  authorizations: WindowAuthorization[];
  simulation: boolean;
  /** Test-data load time (unix seconds), when known. */
  loadedAt: number | null;
  now: number;
  /** Injected for tests; defaults to hap-core's registry. */
  lookupProfile?: (id: string) => { boundsSchema?: unknown } | undefined;
}

function boundsOf(a: WindowAuthorization): Record<string, string | number> | undefined {
  return (a.bounds ?? a.frame) as Record<string, string | number> | undefined;
}

function windowLabel(start: number, days: number, loadedAt: number | null): string {
  const since = `since ${formatDateTime(start)}`;
  if (loadedAt !== null && loadedAt === start) return `${since} (when the test data was loaded)`;
  return `${since} (the last ${days} ${days === 1 ? 'day' : 'days'})`;
}

type ProfileLookup = (id: string) => { boundsSchema?: unknown } | undefined;
const defaultLookup: ProfileLookup = (id) => getProfile(id) as { boundsSchema?: unknown } | undefined;

/**
 * Why the report tools refuse ONE held reporting mandate, or undefined when it
 * is accepted: its profile declares no reporting-window bound (reporting@0.1),
 * or the mandate does not set it. THE single predicate for "a refused mandate"
 * — `resolveReportWindow` drops these, and the report built-in declares it as
 * its `mandateRefusal`, so the gate never SELECTS one for a report tool's call
 * either (tool-proxy.ts — a refused mandate must not authorize, or be charged
 * for, a write the report tools would refuse; RR7).
 */
export function reportingMandateRefusal(m: WindowAuthorization, lookup: ProfileLookup = defaultLookup): string | undefined {
  const schema = lookup(m.profileId)?.boundsSchema as BoundsSchemaLike | undefined;
  const field = resolveAgeBoundField(schema, REPORT_AGE_FIELD);
  // reporting@0.1 — its profile has no window bound. Not accepted.
  if (!field) return OLD_PROFILE_REFUSAL;
  if (maxReadAgeDays([boundsOf(m)], field) === null) {
    return `the reporting mandate does not set ${field} (the reporting window), so nothing can be shown — create a new reporting mandate.`;
  }
  return undefined;
}

/**
 * Pure: the window the held reporting mandates allow right now, or why there
 * is none. See the module comment for the rules.
 */
export function resolveReportWindow(input: ResolveWindowInput): WindowResolution {
  const lookup = input.lookupProfile ?? defaultLookup;
  const mandates = input.authorizations.filter(a => a.complete && profileMatches(a.profileId, REPORTING_PROFILE));
  if (mandates.length === 0) {
    return { ok: false, reason: 'No active reporting mandate — the reporting window comes from it, so no evidence can be shown.' };
  }

  const candidates: Array<{ start: number; days: number; loadedAt: number | null }> = [];
  const refusals: string[] = [];
  for (const m of mandates) {
    const refusal = reportingMandateRefusal(m, lookup);
    if (refusal) {
      refusals.push(refusal);
      continue;
    }
    const schema = lookup(m.profileId)?.boundsSchema as BoundsSchemaLike | undefined;
    const field = resolveAgeBoundField(schema, REPORT_AGE_FIELD)!;
    const declared = maxReadAgeDays([boundsOf(m)], field)!;
    const def = (schema?.fields?.[field] ?? {}) as { maximum?: unknown };
    const maximum = typeof def.maximum === 'number' && Number.isFinite(def.maximum) ? def.maximum : null;
    const days = Math.max(0, maximum !== null ? Math.min(declared, maximum) : declared);
    let start = input.now - days * DAY;
    let clampedBy: number | null = null;
    if (input.simulation && input.loadedAt !== null && input.loadedAt > start) {
      start = input.loadedAt;
      clampedBy = input.loadedAt;
    }
    candidates.push({ start, days, loadedAt: clampedBy });
  }

  if (candidates.length === 0) {
    const reason = [...new Set(refusals)].join(' ');
    return { ok: false, reason: reason.charAt(0).toUpperCase() + reason.slice(1) };
  }
  const best = candidates.reduce((a, b) => (b.start < a.start ? b : a));
  return {
    ok: true,
    window: {
      start: best.start,
      end: input.now,
      days: best.days,
      loadedAt: best.loadedAt,
      label: windowLabel(best.start, best.days, best.loadedAt),
    },
  };
}

export function isInWindow(time: number | undefined, window: ReportWindow): boolean {
  return time !== undefined && Number.isFinite(time) && time >= window.start && time <= window.end + END_SKEW_SECONDS;
}

/** The signed timestamp of an archived ticket — the only time the window
 *  trusts. No timestamp, no place in any window (fail closed). */
export function ticketTime(entry: ArchivedReceipt): number | undefined {
  const t = (entry.receipt as { timestamp?: unknown }).timestamp;
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined;
}

export const OUTSIDE_WINDOW_PREFIX = 'not verifiable — outside the reporting window';

/**
 * The archive as the report tools may see it: only tickets inside the window,
 * and only the mandates those tickets ran under. A ticket outside the window
 * reads, everywhere, as absent — except that `outsideWindowReason` lets a
 * resolver say WHY it is absent (a reference to it renders "not verifiable —
 * outside the reporting window", not a misleading "no such ticket").
 */
export function windowArchive(base: ReceiptArchiveReader, window: ReportWindow): ReceiptArchiveReader {
  const inWindow = (r: ArchivedReceipt) => isInWindow(ticketTime(r), window);
  return {
    getReceipts(): ArchivedReceipt[] {
      return base.getReceipts().filter(inWindow);
    },
    getAuthorizations(): ArchivedAuthorization[] {
      const used = new Set(base.getReceipts().filter(inWindow).map(r => r.authorizationId));
      return base.getAuthorizations().filter(a => used.has(a.authorizationId));
    },
    outsideWindowReason(ticketId: string): string | undefined {
      const entry = base.getReceipts().find(r => (r.receipt as { id?: unknown }).id === ticketId);
      if (!entry || inWindow(entry)) return undefined;
      return `${OUTSIDE_WINDOW_PREFIX} (${window.label}).`;
    },
  };
}

// ─── Connector records ──────────────────────────────────────────────────────

/**
 * When a connector record came into being, for the window — as its table's
 * manifest declaration says (`report.tables[].time`), never by a column name here:
 *  1. a row whose `time.ticket` column names a ticket the gateway holds is as
 *     old as that ticket — the signed timestamp, the same time the ticket
 *     itself is windowed by;
 *  2. else its own date column, `time.column`.
 * A row with neither, or a table without a declaration, is outside every
 * window (fail closed).
 */
function recordTime(
  row: unknown,
  time: ReportTableDeclaration['time'] | undefined,
  loadedAt: number | null,
  ticketTimes: Map<string, number>,
): number | undefined {
  if (!row || typeof row !== 'object' || !time) return undefined;
  const r = row as Record<string, unknown>;
  const ticket = time.ticket ? r[time.ticket] : undefined;
  if (typeof ticket === 'string' && ticketTimes.has(ticket)) return ticketTimes.get(ticket);
  const t = parseTimestampSeconds(r[time.column]);
  if (t === undefined) return undefined;
  // A test package backdates its rows (an email "received" at 08:33 for
  // data loaded at 09:24): such a row exists only since the load — the
  // same effective-time rule a case start uses (case-resolvers.ts, SR4).
  return loadedAt !== null ? Math.max(t, loadedAt) : t;
}

/** Every array-of-rows table in an export, filtered to the window by its
 *  declared `time` (`tables`: the system's report declaration — a table it
 *  does not declare keeps no rows); scalar fields (mode, exported_at,
 *  simulation_load) are kept as they are.
 *  `ticketTimes`: ticket id → signed timestamp, from the UNSCOPED archive, so
 *  a row produced by a ticket outside the window is recognised as old. */
export function windowExport(
  exported: unknown,
  tables: ReadonlyArray<Pick<ReportTableDeclaration, 'name' | 'time'>>,
  window: ReportWindow,
  loadedAt: number | null,
  ticketTimes: Map<string, number> = new Map(),
): unknown {
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) return exported;
  const timeOf = new Map(tables.map(t => [t.name, t.time]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exported as Record<string, unknown>)) {
    out[key] = Array.isArray(value)
      ? value.filter(row => isInWindow(recordTime(row, timeOf.get(key), loadedAt, ticketTimes), window))
      : value;
  }
  return out;
}

/** Test-data load time from the case source's export, or null when there
 *  is none, no connector declares a case source, or it cannot be read. */
export async function readLoadedAt(runExport: RunConnectorExport): Promise<number | null> {
  const cases = caseSystem();
  if (!cases) return null;
  try {
    const exp = await runExport(cases.system);
    if (!isSystemExport(cases, exp) || !isCaseSourceExport(exp)) return null;
    return parseTimestampSeconds(exp.simulation_load?.loaded_at) ?? null;
  } catch {
    return null;
  }
}

export type ScopeResolution =
  | { ok: true; sources: ReportSources; window: ReportWindow }
  | { ok: false; reason: string };

export interface ScopeOptions {
  authorizations: WindowAuthorization[];
  simulation: boolean;
  now?: number;
  lookupProfile?: ResolveWindowInput['lookupProfile'];
}

/**
 * The one entry point: resolves the window from the held mandates and returns
 * `ReportSources` that can only ever see inside it. Every report path — the
 * report__* tools, write_report's verification, the UI's save / check again /
 * export — goes through here.
 */
export async function scopeReportSources(base: ReportSources, opts: ScopeOptions): Promise<ScopeResolution> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const hasReporting = opts.authorizations.some(a => a.complete && profileMatches(a.profileId, REPORTING_PROFILE));
  // The load time is read only when it can matter (simulation mode) — outside
  // it no connector export is run just to resolve the window.
  const loadedAt = hasReporting && opts.simulation ? await readLoadedAt(base.runExport) : null;
  const resolved = resolveReportWindow({
    authorizations: opts.authorizations, simulation: opts.simulation, loadedAt, now,
    lookupProfile: opts.lookupProfile,
  });
  if (!resolved.ok) return resolved;
  return { ok: true, window: resolved.window, sources: scopedSources(base, resolved.window, loadedAt) };
}

function scopedSources(base: ReportSources, window: ReportWindow, loadedAt: number | null): ReportSources {
  const runExport: RunConnectorExport = async (system: ExportSystem) => {
    const ticketTimes = new Map<string, number>();
    for (const r of base.archive.getReceipts()) {
      const id = (r.receipt as { id?: unknown }).id;
      const t = ticketTime(r);
      if (typeof id === 'string' && t !== undefined) ticketTimes.set(id, t);
    }
    // A system no manifest declares has no tables to date its rows by: nothing of it is shown.
    return windowExport(await base.runExport(system), reportSystem(system)?.tables ?? [], window, loadedAt, ticketTimes);
  };
  return { archive: windowArchive(base.archive, window), runExport, window };
}

/**
 * Re-scope to the window a STORED report was written under (its
 * `coverage.window`) — for the owner's own "Check again" and "Export with
 * proof" in the gateway UI. The start stays where the reporting mandate put it
 * when the AI wrote the report, so the report neither loses its evidence as
 * days pass nor gains older evidence; only the end moves to now (newer tickets
 * can show up in coverage, older ones never). Needs no active mandate: the
 * window was signed off when the report was written.
 */
export async function scopeReportSourcesToStoredWindow(
  base: ReportSources,
  stored: { start: number; days: number; label: string },
  opts: { simulation: boolean; now?: number },
): Promise<ScopeResolution> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const loadedAt = opts.simulation ? await readLoadedAt(base.runExport) : null;
  const window: ReportWindow = { start: stored.start, end: now, days: stored.days, loadedAt: null, label: stored.label };
  return { ok: true, window, sources: scopedSources(base, window, loadedAt) };
}
