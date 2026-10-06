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
 *    load time (`simulation_load.loaded_at` from the email connector's export).
 *  - A mandate whose profile declares no such bound (reporting@0.1): accepted
 *    only in simulation mode, with the window starting at the load time; refused
 *    outside simulation mode, or when the load time is unknown, with a reason
 *    that says what to do (decision RR1, 2026-10-06).
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
import { isEmailExport } from './types';
import type { ArchivedReceipt, ArchivedAuthorization } from '../receipt-archive';
import type { ReceiptArchiveReader, ReportSources, RunConnectorExport, ExportSystem } from './types';

/** The execution field a read adapter produces from an item's date — the
 *  reporting window bound is the profile bound that compares it. */
export const REPORT_AGE_FIELD = 'read_age_days';
export const REPORTING_PROFILE = 'reporting';
export const END_SKEW_SECONDS = 120;
const DAY = 86_400;

export interface ReportWindow {
  /** Unix seconds, inclusive. */
  start: number;
  /** Unix seconds — "now" when the window was resolved. Tickets up to
   *  end + END_SKEW_SECONDS are inside. */
  end: number;
  /** The lookback in days that set `start`, or null when it was set by the
   *  test-data load time alone (a reporting@0.1 mandate in simulation mode). */
  days: number | null;
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

function windowLabel(start: number, days: number | null, loadedAt: number | null): string {
  const since = `since ${formatDateTime(start)}`;
  if (loadedAt !== null && loadedAt === start) return `${since} (when the test data was loaded)`;
  if (days !== null) return `${since} (the last ${days} ${days === 1 ? 'day' : 'days'})`;
  return since;
}

/**
 * Pure: the window the held reporting mandates allow right now, or why there
 * is none. See the module comment for the rules.
 */
export function resolveReportWindow(input: ResolveWindowInput): WindowResolution {
  const lookup = input.lookupProfile ?? ((id: string) => getProfile(id) as { boundsSchema?: unknown } | undefined);
  const mandates = input.authorizations.filter(a => a.complete && profileMatches(a.profileId, REPORTING_PROFILE));
  if (mandates.length === 0) {
    return { ok: false, reason: 'No active reporting mandate — the reporting window comes from it, so no evidence can be shown.' };
  }

  const candidates: Array<{ start: number; days: number | null; loadedAt: number | null }> = [];
  const refusals: string[] = [];
  for (const m of mandates) {
    const schema = lookup(m.profileId)?.boundsSchema as BoundsSchemaLike | undefined;
    const field = resolveAgeBoundField(schema, REPORT_AGE_FIELD);
    if (!field) {
      // reporting@0.1 — no window in the mandate (decision RR1).
      if (!input.simulation) {
        refusals.push(
          `the reporting mandate (${m.profileId}) sets no reporting window. Outside a test it would show the ` +
          `whole ticket history, so it is not accepted — ask for a new reporting mandate, which sets how many days back the report may read.`,
        );
      } else if (input.loadedAt === null) {
        refusals.push(
          `the reporting mandate (${m.profileId}) sets no reporting window, and the time the test data was loaded is unknown, ` +
          `so there is no safe start — load the test data, or ask for a new reporting mandate with a reporting window.`,
        );
      } else {
        candidates.push({ start: input.loadedAt, days: null, loadedAt: input.loadedAt });
      }
      continue;
    }
    const declared = maxReadAgeDays([boundsOf(m)], field);
    if (declared === null) {
      refusals.push(`the reporting mandate (${m.profileId}) does not set ${field} — no window, so nothing can be shown.`);
      continue;
    }
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
    return { ok: false, reason: `No reporting window: ${refusals.join(' ')}` };
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
 * When a connector record came into being, for the window:
 *  1. a row a ticket produced (`receipt_id`) is as old as that ticket — the
 *     signed timestamp, the same time the ticket itself is windowed by;
 *  2. else its own date column. Tables differ (email `received_at`, ERP/CRM
 *     `created_at`, change/refusal logs `at`, CRM activities only `date`), so
 *     the first parseable one wins.
 * A row with neither is outside every window (fail closed).
 */
const RECORD_TIME_COLUMNS = ['received_at', 'created_at', 'at', 'date'] as const;

function recordTime(row: unknown, loadedAt: number | null, ticketTimes: Map<string, number>): number | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  if (typeof r.receipt_id === 'string' && ticketTimes.has(r.receipt_id)) return ticketTimes.get(r.receipt_id);
  for (const col of RECORD_TIME_COLUMNS) {
    const t = parseTimestampSeconds(r[col]);
    if (t !== undefined) {
      // A test package backdates its rows (an email "received" at 08:33 for
      // data loaded at 09:24): such a row exists only since the load — the
      // same effective-time rule a case start uses (case-resolvers.ts, SR4).
      return loadedAt !== null ? Math.max(t, loadedAt) : t;
    }
  }
  return undefined;
}

/** Every array-of-rows table in an export, filtered to the window; scalar
 *  fields (mode, exported_at, simulation_load) are kept as they are.
 *  `ticketTimes`: ticket id → signed timestamp, from the UNSCOPED archive, so
 *  a row produced by a ticket outside the window is recognised as old. */
export function windowExport(
  exported: unknown,
  window: ReportWindow,
  loadedAt: number | null,
  ticketTimes: Map<string, number> = new Map(),
): unknown {
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) return exported;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exported as Record<string, unknown>)) {
    out[key] = Array.isArray(value)
      ? value.filter(row => isInWindow(recordTime(row, loadedAt, ticketTimes), window))
      : value;
  }
  return out;
}

/** Test-data load time from the email connector's export, or null when there
 *  is none or it cannot be read. */
export async function readLoadedAt(runExport: RunConnectorExport): Promise<number | null> {
  try {
    const exp = await runExport('email');
    if (!isEmailExport(exp)) return null;
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
    return windowExport(await base.runExport(system), window, loadedAt, ticketTimes);
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
  stored: { start: number; days: number | null; label: string },
  opts: { simulation: boolean; now?: number },
): Promise<ScopeResolution> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const loadedAt = opts.simulation ? await readLoadedAt(base.runExport) : null;
  const window: ReportWindow = { start: stored.start, end: now, days: stored.days, loadedAt: null, label: stored.label };
  return { ok: true, window, sources: scopedSources(base, window, loadedAt) };
}
