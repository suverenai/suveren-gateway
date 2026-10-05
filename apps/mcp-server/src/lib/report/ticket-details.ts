/**
 * Builds the full detail record for every ticket a report references — what
 * the UI's detail panel shows when `?element=<id>&ticket=<ticketId>` is
 * opened on an `sv-case` step (work-plan "evidence-backed reports", R5 frame
 * half, decision: "Detail panel ... from the stored verified result; never
 * from the AI's html").
 *
 * An `sv-case`'s own `data.steps` only carries `{ ticketId, time, action }` —
 * enough to draw the timeline, not enough for a full ticket detail (profile,
 * limits, mandate, public-check link). Rather than re-shaping `sv-case`'s
 * resolved data (verify-report.ts's contract — out of scope here), this
 * module re-resolves every ticket id the report proves it referenced
 * (`ProofSummary.ticketsReferenced` already enumerates exactly that set,
 * built the same way across sv-ticket/approval/mandate AND sv-case
 * steps/goal — see verify-report.ts's `buildProof`) via the SAME resolvers
 * `verify-report.ts` itself uses, so a direct `sv-ticket` and a case's step
 * produce byte-identical detail for the same ticket id.
 */
import { resolveTicketElement, resolveApprovalElement, resolveMandateElement } from './ticket-resolvers';
import type { ReceiptArchiveReader } from './types';

export interface TicketDetail {
  ticket: Awaited<ReturnType<typeof resolveTicketElement>>;
  approval: Awaited<ReturnType<typeof resolveApprovalElement>>;
  mandate: Awaited<ReturnType<typeof resolveMandateElement>>;
}

export async function buildTicketDetails(
  archive: ReceiptArchiveReader,
  ticketIds: string[],
): Promise<Record<string, TicketDetail>> {
  const out: Record<string, TicketDetail> = {};
  for (const id of ticketIds) {
    const [ticket, approval, mandate] = await Promise.all([
      resolveTicketElement(archive, id),
      resolveApprovalElement(archive, id),
      resolveMandateElement(archive, id),
    ]);
    out[id] = { ticket, approval, mandate };
  }
  return out;
}
