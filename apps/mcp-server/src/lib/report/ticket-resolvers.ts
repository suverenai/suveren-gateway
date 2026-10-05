/**
 * Resolves `sv-ticket`, `sv-approval` and `sv-mandate` — the three element
 * kinds keyed by a ticket id, all backed by one `ReceiptArchive` entry.
 *
 * Signature checking reuses `verifyReceiptSignature`/`verifyAttestationSignature`
 * from `@hap/core` — the SAME functions `ticket-verify.ts` uses before the
 * gateway executes anything on a ticket's strength (work-plan instruction:
 * "the verification the gateway already uses before execution — find it, no
 * new crypto"). Unlike `ticket-verify.ts`, this module does NOT re-derive the
 * key from the live, pinned Authority Server (`AttestationCache`): a report
 * verifies PAST evidence, often long after the call it describes, so it
 * checks each ticket against the Authority Server key archived ALONGSIDE it
 * at the time (`ArchivedReceipt.asPublicKey` — written by `receipt-archive.ts`
 * at archive time, from the same pinned cache `ticket-verify.ts` used when the
 * ticket was issued). A ticket with no archived key cannot be verified at all
 * and is reported as such, never silently trusted.
 */
import { verifyReceiptSignature, verifyAttestationSignature, decodeAttestationBlob, type ReceiptPayload } from '@hap/core';
import type { ArchivedReceipt, ArchivedAuthorization } from '../receipt-archive';
import type { ReceiptArchiveReader } from './types';

export function findReceiptEntry(archive: ReceiptArchiveReader, ticketId: string): ArchivedReceipt | undefined {
  return archive.getReceipts().find(r => (r.receipt as { id?: unknown }).id === ticketId);
}

export function findAuthorization(archive: ReceiptArchiveReader, authorizationId: string): ArchivedAuthorization | undefined {
  return archive.getAuthorizations().find(a => a.authorizationId === authorizationId);
}

export interface TicketCheckOk {
  ok: true;
  entry: ArchivedReceipt;
}
export interface TicketCheckFail {
  ok: false;
  reason: string;
  /** The archive entry, when one was found but its signature didn't verify —
   *  callers that still want SOME context (e.g. action name) for the failure
   *  message may use it; never used to render verified data. */
  entry?: ArchivedReceipt;
}

/**
 * Looks the ticket up in the archive and checks its Ed25519 signature against
 * the Authority Server key archived with it. Does NOT check freshness/replay
 * (`ticket-verify.ts`'s job for a call about to execute) — a report describes
 * events that are, by definition, already in the past.
 */
export async function checkTicket(archive: ReceiptArchiveReader, ticketId: string): Promise<TicketCheckOk | TicketCheckFail> {
  const entry = findReceiptEntry(archive, ticketId);
  if (!entry) {
    return { ok: false, reason: `No ticket "${ticketId}" in the local archive.` };
  }
  if (!entry.asPublicKey) {
    return { ok: false, reason: `Ticket "${ticketId}" has no archived Authority Server key to verify it against.`, entry };
  }
  try {
    await verifyReceiptSignature(entry.receipt as unknown as ReceiptPayload, entry.asPublicKey);
  } catch (err) {
    return {
      ok: false,
      reason: `Ticket "${ticketId}" signature does not verify: ${err instanceof Error ? err.message : String(err)}`,
      entry,
    };
  }
  return { ok: true, entry };
}

/** Public-check URL per the plan ("every ticket element links to the public
 *  check `suveren.ai/r/<ticket id>`") — built from the AS the ticket was
 *  actually archived against, not a hardcoded host, so a self-hosted
 *  Authority Server gets its own correct link. */
export function checkUrlFor(entry: ArchivedReceipt): string {
  const id = String((entry.receipt as { id?: unknown }).id ?? '');
  return `${entry.asUrl.replace(/\/+$/, '')}/r/${id}`;
}

export async function resolveTicketElement(archive: ReceiptArchiveReader, ref: string) {
  const check = await checkTicket(archive, ref);
  if (!check.ok) return { status: 'unverifiable' as const, reason: check.reason };
  const r = check.entry.receipt as Record<string, unknown>;
  return {
    status: 'verified' as const,
    data: {
      ticketId: ref,
      action: r.action,
      time: r.timestamp,
      profile: r.profileId,
      authorizationId: r.authorizationId,
      limitsUsed: r.limits ?? r.executionContext ?? {},
      checkUrl: checkUrlFor(check.entry),
    },
  };
}

export async function resolveApprovalElement(archive: ReceiptArchiveReader, ticketRef: string) {
  const check = await checkTicket(archive, ticketRef);
  if (!check.ok) return { status: 'unverifiable' as const, reason: check.reason };
  const proposal = check.entry.proposal;
  if (!proposal) {
    return {
      status: 'unverifiable' as const,
      reason: `Ticket "${ticketRef}" has no archived approval (it ran without review).`,
    };
  }
  const committedBy = (proposal.committedBy ?? {}) as Record<string, { userId: string; at: number }>;
  const approvers = Object.values(committedBy);
  const createdAt = typeof proposal.createdAt === 'number' ? proposal.createdAt : undefined;
  const decidedAt = approvers.length > 0 ? Math.max(...approvers.map(a => a.at)) : undefined;
  return {
    status: 'verified' as const,
    data: {
      ticketId: ticketRef,
      who: approvers.map(a => a.userId),
      createdAt,
      decidedAt,
      waitSeconds: createdAt !== undefined && decidedAt !== undefined ? decidedAt - createdAt : undefined,
      status: proposal.status,
    },
  };
}

export async function resolveMandateElement(archive: ReceiptArchiveReader, ticketRef: string) {
  const check = await checkTicket(archive, ticketRef);
  if (!check.ok) return { status: 'unverifiable' as const, reason: check.reason };
  const r = check.entry.receipt as Record<string, unknown>;
  const authorizationId = typeof r.authorizationId === 'string' ? r.authorizationId : undefined;
  if (!authorizationId) {
    return { status: 'unverifiable' as const, reason: `Ticket "${ticketRef}" carries no authorizationId.` };
  }
  const auth = findAuthorization(archive, authorizationId);
  if (!auth) {
    return { status: 'unverifiable' as const, reason: `No archived mandate "${authorizationId}" for ticket "${ticketRef}".` };
  }
  // Bounds-hash consistency, where both sides carry one (plan: "bounds-hash
  // consistency where available") — a mismatch means the ticket and the
  // mandate it claims to run under disagree about what was authorized.
  if (auth.boundsHash && typeof r.boundsHash === 'string' && auth.boundsHash !== r.boundsHash) {
    return {
      status: 'unverifiable' as const,
      reason: `Mandate "${authorizationId}" boundsHash does not match ticket "${ticketRef}".`,
    };
  }

  let mode: string | undefined;
  let owners: string[] = [];
  const firstBlob = auth.attestations[0]?.blob;
  if (firstBlob && check.entry.asPublicKey) {
    try {
      const attestation = decodeAttestationBlob(firstBlob);
      await verifyAttestationSignature(attestation, check.entry.asPublicKey);
      mode = attestation.payload.commitment_mode;
      const dids = attestation.payload.resolved_owners ?? [];
      const subjects = attestation.payload.subjects ?? [];
      owners = dids.map(did => {
        const subject = subjects.find(s => s.did === did);
        return subject?.assurance === 'high' && subject.disclose?.name ? subject.disclose.name : did;
      });
    } catch {
      // Undecodable/unverifiable attestation blob — mode/owner stay unknown,
      // but the mandate itself (bounds/intent, already checked above against
      // the ticket) still renders. Fail narrow, not whole-element closed: the
      // ticket's own signature is what actually vouches for the action.
    }
  }

  return {
    status: 'verified' as const,
    data: {
      authorizationId,
      profile: auth.profileId,
      limits: auth.bounds ?? {},
      intent: auth.intent,
      mode,
      owners,
    },
  };
}
