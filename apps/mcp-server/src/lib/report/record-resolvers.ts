/**
 * Resolves `sv-record system="…" ref="RECORD_ID"` against that system's own
 * `export` (connector-export.ts), as its manifest declares it (systems.ts):
 * the tables in order, each matched by its declared columns. "for changes the
 * causing ticket" (plan): a row of a table that declares `causingTicket` (a
 * connector's own `changes` table, "the effect each ticket produced") carries
 * the `receipt_id` that produced it.
 */
import { reportSystem, resolveSystemRecord, type RecordLookupResult } from './systems';

export type { RecordLookupResult } from './systems';

export function resolveRecord(system: string, exportData: unknown, ref: string): RecordLookupResult {
  const declared = reportSystem(system);
  if (!declared) return { status: 'unverifiable', reason: `Unknown system "${system}".` };
  return resolveSystemRecord(declared, exportData, ref);
}
