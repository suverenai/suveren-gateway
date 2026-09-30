/**
 * Verify a ticket (signed receipt) BEFORE the gateway executes anything on
 * its strength. "No ticket, no execution" is worthless if the ticket itself
 * is never checked — before this module existed, NEITHER path did:
 *
 *  - The automatic path took the AS's answer to `/api/as/receipt` on faith.
 *  - The review path was worse: `executeCommitted` (tools/commitments.ts)
 *    takes the TOOL NAME, ARGUMENTS, and STATUS ("committed") from the AS's
 *    proposal object too — a server holding any signing key at all, valid or
 *    not, could hand the gateway a proposal for a tool call it never
 *    approved and have it run, as long as it also minted a receipt.
 *
 * Two checks, both fail-closed:
 *
 *  1. The receipt's Ed25519 signature must verify against the PINNED
 *     Authority Server key (attestation-cache.ts) — not whatever key a live
 *     `/api/as/pubkey` happens to answer with right now. A signature that
 *     doesn't verify means this is not the server the gateway paired with,
 *     or the receipt was tampered with in transit.
 *  2. The receipt's own `action` and `executionContext` — the fields the AS
 *     itself signed — must match what this call is about to execute. This
 *     catches a same-key AS (or a bug) handing back a receipt for one action
 *     while asking the gateway to run another.
 *
 * What this does NOT do (yet): cross-check a review-mode proposal's
 * tool/args against what THIS gateway itself submitted, when it was the
 * submitter — see proposal-submission-store.ts, used by commitments.ts
 * alongside this module.
 */
import { verifyReceiptSignature, type ReceiptPayload } from '@hap/core';
import { AttestationCache, AsKeyMismatchError } from './attestation-cache';
import { hashToolArgs } from './execution-journal';

/** Thrown when the ticket's signature verifies but its own bound fields
 *  (action / executionContext) disagree with what the caller asked for. */
export class TicketBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketBindingMismatchError';
  }
}

export interface ExpectedTicket {
  /** The namespaced tool name this call requested a ticket for. */
  action: string;
  /** The executionContext sent in the receipt request, if any. */
  executionContext?: Record<string, unknown>;
}

/**
 * @throws AsKeyMismatchError when the pinned key rejects the signature (or
 *   is itself unavailable/mismatched — see attestation-cache.ts).
 * @throws TicketBindingMismatchError when the signature is fine but the
 *   ticket's own action/executionContext disagree with what was requested.
 */
export async function verifyTicket(
  cache: AttestationCache,
  receipt: Record<string, unknown>,
  expected: ExpectedTicket,
): Promise<void> {
  // Throws AsKeyMismatchError on its own if the pin disagrees with the live
  // key — propagate as-is, this IS the check we need.
  const publicKeyHex = await cache.getPublicKey();

  if (typeof receipt.signature !== 'string' || !receipt.signature) {
    throw new AsKeyMismatchError('Ticket carries no signature — refusing to trust it.');
  }

  try {
    // hap-core canonicalizes and verifies over every field EXCEPT
    // `signature` — pass the receipt through unmodified (including any
    // fields not in hap-core's own ReceiptPayload type) so this checks the
    // EXACT bytes the Authority Server signed, not a re-shaped subset of them.
    await verifyReceiptSignature(receipt as unknown as ReceiptPayload, publicKeyHex);
  } catch (err) {
    throw new AsKeyMismatchError(
      `Ticket signature does not verify against the pinned Authority Server key — ` +
        `${err instanceof Error ? err.message : String(err)}. Refusing to execute.`,
    );
  }

  if (receipt.action !== expected.action) {
    throw new TicketBindingMismatchError(
      `Ticket action "${String(receipt.action)}" does not match the requested action ` +
        `"${expected.action}" — refusing to execute.`,
    );
  }

  if (
    expected.executionContext !== undefined &&
    hashToolArgs(receipt.executionContext ?? {}) !== hashToolArgs(expected.executionContext)
  ) {
    throw new TicketBindingMismatchError(
      'Ticket executionContext does not match what this call requested — refusing to execute.',
    );
  }
}
