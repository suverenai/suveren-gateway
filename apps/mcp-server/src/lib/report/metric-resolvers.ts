/**
 * Computes `sv-metric kind="KIND" cases="all|CASE_ID CASE_ID"` — a number the
 * gateway computes itself, over the report's OWN verified cases (never the
 * AI's own arithmetic — report-brief.ts rule 2: "Numbers you compute
 * yourself are shown as 'AI analysis — not verified'").
 *
 * Takes already-resolved case data (`case-resolvers.ts`), never the raw
 * exports or archive — keeps this module a pure function over plain data,
 * cheap to test against hand-computed numbers.
 */
export const METRIC_KINDS = [
  'completed',
  'median-time',
  'average-time',
  'without-approval',
  'approvals',
  'median-approval-wait',
  'tickets',
  'refusals',
] as const;
export type MetricKind = typeof METRIC_KINDS[number];

export class UnknownMetricKindError extends Error {
  constructor(kind: string) {
    super(`Unknown sv-metric kind "${kind}" — expected one of: ${METRIC_KINDS.join(', ')}.`);
    this.name = 'UnknownMetricKindError';
  }
}

export interface CaseMetricInput {
  caseId: string;
  startTime: number;
  goalTime: number;
  totalDurationSeconds: number;
  /** Every ticket id the case names — goal + steps, for the `tickets` kind. */
  ticketIds: string[];
  approvals: Array<{ waitSeconds?: number }>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * `refusalTimes`: every simulator refusal record's `at`, already parsed to
 * unix seconds, from EVERY connector export (refusals are not scoped to one
 * system — the plan says "simulator refusal records", not one named system).
 * A refusal counts toward a case if it falls inside that case's own
 * [start, goal] window; a refusal inside two overlapping cases' windows is
 * counted for both (cases are not expected to overlap in practice).
 */
export function computeMetric(kind: string, cases: CaseMetricInput[], refusalTimes: number[] = []): number {
  switch (kind as MetricKind) {
    case 'completed':
      return cases.length;
    case 'median-time':
      return median(cases.map(c => c.totalDurationSeconds));
    case 'average-time':
      return average(cases.map(c => c.totalDurationSeconds));
    case 'without-approval': {
      if (cases.length === 0) return 0;
      const withoutApproval = cases.filter(c => c.approvals.length === 0).length;
      return withoutApproval / cases.length;
    }
    case 'approvals':
      return cases.reduce((sum, c) => sum + c.approvals.length, 0);
    case 'median-approval-wait':
      return median(cases.flatMap(c => c.approvals.map(a => a.waitSeconds).filter((w): w is number => typeof w === 'number')));
    case 'tickets': {
      const ids = new Set(cases.flatMap(c => c.ticketIds));
      return ids.size;
    }
    case 'refusals':
      return cases.reduce(
        (sum, c) => sum + refusalTimes.filter(t => t >= c.startTime && t <= c.goalTime).length,
        0,
      );
    default:
      throw new UnknownMetricKindError(kind);
  }
}
