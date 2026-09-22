import type { ProfileBoundsField, ProfileContextField } from '@hap/core';

/**
 * Floor and seed for numeric bound fields — derived from the profile schema,
 * never from a field name.
 *
 * A `per_transaction` bound in `count` units (e.g. email `recipient_max`)
 * caps how many items one action may carry. Zero there is not "strict", it
 * is a dead grant: every transaction has at least one item, so the
 * gatekeeper rejects every send. The wizard used to seed such fields with
 * '' and submit that as 0, which made a fresh email mandate refuse every
 * message. Cumulative bounds (`send_daily_max`) and non-count bounds
 * (`amount_max`, `read_max_age_days`) keep 0 as a legitimate value.
 */

type NumericField = ProfileBoundsField | ProfileContextField;

/** Smallest value the field may hold: 1 for per-transaction counts, else 0. */
export function minForBound(field: NumericField): 0 | 1 {
  if (field.type !== 'number') return 0;
  const bt = (field as { boundType?: { kind?: string } }).boundType;
  const unit = (field as { unit?: string }).unit;
  return bt?.kind === 'per_transaction' && unit === 'count' ? 1 : 0;
}

/**
 * Initial input string for the field. A provided seed (template / edit
 * prefill) is shown as-is — it is the stored truth, even when it is a 0 the
 * floor no longer allows; the input's `min` and the submit clamp handle it.
 * Without a seed, floor-1 fields start at '1'; everything else stays empty.
 */
export function seedForBound(field: NumericField, seed: string | number | undefined): string {
  if (seed !== undefined) return String(seed);
  return minForBound(field) === 1 ? '1' : '';
}

/** Submitted numeric value: '' becomes the floor (0 as before, 1 for floor-1 fields). */
export function numericBoundValue(field: NumericField, raw: string): number {
  const min = minForBound(field);
  if (raw === '') return min;
  return Math.max(min, Number(raw));
}
