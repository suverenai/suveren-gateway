/**
 * Consumption State — resolves cumulative usage from execution log and
 * profile schema.
 *
 * v0.4: driven by `profile.boundsSchema.fields` and each field's declared
 * `boundType`. The display iterates the profile's bounds directly; for
 * cumulative_sum and cumulative_count bounds it queries the execution
 * log using the boundType's declared `of` (sum) or '_count' (count).
 * No name-pattern heuristics — `${ctxFieldName}_max` style lookups are
 * gone, which means profiles with naming quirks (write_count_daily →
 * write_daily_max, etc.) now display correctly without any per-profile
 * fallback code.
 *
 * Used by mandate-brief (compact) and list-authorizations (full detail).
 */

import type { AgentProfile, ProfileBoundsField, CumulativeWindow } from '@hap/core';
import type { ExecutionLog } from './execution-log';
import type { EnrichedAuthorization } from './shared-state';

export interface ConsumptionEntry {
  /** Human-readable label, e.g. "Daily create limit" */
  label: string;
  /** Current cumulative value */
  current: number;
  /** Max limit from the bound, or null if no numeric bound is set */
  limit: number | null;
  /** Time window ("daily", "weekly", or "monthly") */
  window: CumulativeWindow;
  /** The bounds field name (e.g., "write_daily_max") */
  field: string;
  /** "sum" = summed numeric value (currency-like), "count" = number of calls */
  kind: 'sum' | 'count';
  /** For sum kind: the execution context field being summed (e.g., "amount", "spend"). Undefined for count. */
  of?: string;
}

/**
 * Compute consumption state for an authorization by walking the profile's
 * bounds schema and dispatching on each bound's declared boundType.
 *
 * Only `cumulative_sum` and `cumulative_count` bounds produce consumption
 * entries — per-transaction and enum bounds don't have running totals.
 */
export function getConsumptionState(
  auth: EnrichedAuthorization,
  executionLog: ExecutionLog,
  profile: AgentProfile | undefined,
): ConsumptionEntry[] {
  if (!profile?.boundsSchema?.fields) return [];

  const entries: ConsumptionEntry[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const [fieldName, rawFieldDef] of Object.entries(profile.boundsSchema.fields)) {
    if (fieldName === 'profile' || fieldName === 'path') continue;

    const fieldDef = rawFieldDef as ProfileBoundsField;
    const bt = fieldDef.boundType;
    if (!bt) continue; // non-v0.4 bound or missing declaration

    // A bound the profile declares unenforced has no consumption to report —
    // nothing counts it. Reporting "0 / 7" for it tells the agent it has
    // headroom under a limit that does not exist. The authorization editor
    // already hides these; this is the other surface that must agree.
    if ((fieldDef as { enforced?: boolean }).enforced === false) continue;

    // Only cumulative bounds have a "consumption" value to report.
    if (bt.kind !== 'cumulative_sum' && bt.kind !== 'cumulative_count') continue;

    const boundValue = auth.frame[fieldName];
    const limit = typeof boundValue === 'number' ? boundValue : null;

    const cumulativeField = bt.kind === 'cumulative_count' ? '_count' : bt.of;
    const current = executionLog.sumByWindow(
      auth.profileId,
      auth.path,
      cumulativeField,
      bt.window,
      now,
    );

    entries.push({
      // displayName FIRST: description is prose meant for a human reading the
      // profile, and rendering it here produced a paragraph where a label
      // belongs ("Not currently enforced: reads carry no receipt… : 0 / 7").
      label: fieldDef.displayName ?? fieldDef.description ?? fieldName,
      current,
      limit,
      window: bt.window,
      field: fieldName,
      kind: bt.kind === 'cumulative_sum' ? 'sum' : 'count',
      of: bt.kind === 'cumulative_sum' ? bt.of : undefined,
    });
  }

  return entries;
}

// Which "of" field names indicate a currency amount (so we prefix with "$").
// This is a display hint, not a semantic check — the underlying enforcement
// doesn't care. Profiles that use different names for money-denominated
// cumulative sums can be added here without affecting correctness.
const CURRENCY_SUM_FIELDS = new Set(['amount', 'spend']);

/**
 * Format consumption as a compact single line for the mandate brief.
 * e.g. "$234/$500 daily, 8/20 tx daily"
 *
 * Dispatches on entry.kind (sum vs count) and entry.of (currency hint)
 * rather than parsing bound field names.
 */
export function formatConsumptionCompact(entries: ConsumptionEntry[]): string {
  if (entries.length === 0) return '';

  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.limit === null) continue;

    if (entry.kind === 'sum') {
      const prefix = entry.of && CURRENCY_SUM_FIELDS.has(entry.of) ? '$' : '';
      parts.push(`${prefix}${entry.current}/${prefix}${entry.limit} ${entry.window}`);
    } else {
      // count kind — e.g. "3/5 daily"
      parts.push(`${entry.current}/${entry.limit} ${entry.window}`);
    }
  }

  return parts.join(', ');
}

/**
 * Format consumption as multi-line detail for list-authorizations.
 */
export function formatConsumptionFull(entries: ConsumptionEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = [];
  for (const entry of entries) {
    const limitStr = entry.limit !== null ? String(entry.limit) : 'unlimited';
    // Pad label to align values
    const label = `${entry.label}:`;
    lines.push(`    ${label.padEnd(30)} ${entry.current} / ${limitStr}`);
  }

  return lines.join('\n');
}
