/**
 * Where a ticket's headline values come from (UI spec §13.4), decided from
 * this gateway's archive maps (`GET /api/evidence/headlines`):
 *  - approved ticket this gateway executed → its archived approved toolArgs;
 *  - approved ticket it did not execute (another device did) → fetch the
 *    proposal from the AS and decrypt it, as before — after DEC-22 retention
 *    that copy may be empty, and the headline is then the plain label;
 *  - automatic ticket → what this gateway sent (or nothing → plain label).
 */
export interface HeadlineMaps {
  automatic: Record<string, Record<string, unknown>>;
  approved: Record<string, Record<string, unknown>>;
}

export type HeadlineSource =
  | { t: 'archive-approved'; args: Record<string, unknown> }
  | { t: 'fetch-proposal'; proposalId: string }
  | { t: 'archive-automatic'; args: Record<string, unknown> | null };

export function headlineSourceFor(maps: HeadlineMaps, ticketId: string, proposalId?: string): HeadlineSource {
  if (!proposalId) return { t: 'archive-automatic', args: maps.automatic[ticketId] ?? null };
  const archived = maps.approved[ticketId];
  if (archived) return { t: 'archive-approved', args: archived };
  return { t: 'fetch-proposal', proposalId };
}
