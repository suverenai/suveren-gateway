/**
 * `<who>` for a rejection/change-needed/replaced outcome (RJ3/RJ4) — the
 * person's disclosed name if this gateway can verify one locally, else their
 * user id, exactly as check-pending-commitments showed before this feature
 * existed.
 *
 * Reuses report/identity.ts's directory (built from the SAME locally
 * archived, signature-verified mandates the evidence report trusts) rather
 * than inventing a second, unverified userId -> name cache: a name is only
 * ever shown here when SOME archived attestation this gateway can verify
 * actually discloses it for that person's DID.
 *
 * Deliberately falls back to the raw user id (never identity.ts's
 * "(name not disclosed)" label) — that label is for a report a human reads,
 * this one is for a sentence an agent reads, and the user id is the "as
 * today" fallback both the brief and the existing check-pending-commitments
 * tests expect. Never throws: an unverifiable or missing archive degrades to
 * the user id rather than breaking the tool reply that carries it.
 */
import { getIdentityDirectory } from './report/identity';
import type { ReceiptArchiveReader } from './report/types';

/**
 * @param domainKey The `domain` a domain-owner rejection recorded (or, for an
 *   above-cap approver rejection with no domain, the same value as `userId` —
 *   in team mode the domain IS the approver's account id, see identity.ts).
 */
export async function resolveWhoLabel(
  archive: ReceiptArchiveReader | undefined,
  domainKey: string,
  userId: string,
): Promise<string> {
  if (!archive) return userId;
  try {
    const dir = await getIdentityDirectory(archive);
    const did = dir.domainDids.get(domainKey) ?? dir.domainDids.get(userId);
    const name = did ? dir.names.get(did) : undefined;
    return name ?? userId;
  } catch {
    return userId;
  }
}
