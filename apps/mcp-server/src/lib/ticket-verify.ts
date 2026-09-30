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
 * Checks, all fail-closed:
 *
 *  1. The receipt's Ed25519 signature must verify against the PINNED
 *     Authority Server key (attestation-cache.ts) — not whatever key a live
 *     `/api/as/pubkey` happens to answer with right now. A signature that
 *     doesn't verify means this is not the server the gateway paired with,
 *     or the receipt was tampered with in transit.
 *  2. The receipt's own `action`, `executionContext`, `authorizationId` and
 *     `profileId` — fields the AS itself signed — must match what this call
 *     is about to execute. `proposalId` is required to match too when the
 *     caller is executing a specific proposal (the review path) — a receipt
 *     minted for some OTHER request (or for no proposal at all) must not be
 *     accepted just because its action/executionContext happen to line up;
 *     see the impostor-relay e2e suite, "cannot make the gateway run a
 *     proposal the AS never saw, by pairing it with a genuine ticket".
 *  3. The receipt's signed `timestamp` must be recent — see
 *     TICKET_MAX_AGE_SECONDS / TICKET_MAX_CLOCK_SKEW_SECONDS below. This is
 *     hardening, not full replay protection: a genuinely fresh, genuinely
 *     signed ticket handed back for a DIFFERENT call of the same shape is a
 *     known open gap (the idempotency key is not part of what the AS signs)
 *     — tracked separately, needs an Authority Server change.
 *
 * What this does NOT do: cross-check a review-mode proposal's tool/args
 * against what THIS gateway itself submitted, when it was the submitter —
 * that is proposal-submission-store.ts, used by commitments.ts alongside
 * this module (and required, not merely cross-checked: see its own docs).
 */
import { verifyReceiptSignature, type ReceiptPayload } from '@hap/core';
import { AttestationCache, AsKeyMismatchError } from './attestation-cache';
import { hashToolArgs } from './execution-journal';

/** Thrown when the ticket's signature verifies but its own bound fields
 *  (action / executionContext / authorizationId / profileId / proposalId /
 *  timestamp) disagree with what the caller asked for. */
export class TicketBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketBindingMismatchError';
  }
}

/**
 * How long a signed ticket is trusted after it was minted. Deliberately
 * short: the whole flow between requesting a receipt and acting on it is
 * synchronous and normally completes in well under a second, even with the
 * receipt-request retry backoff (sp-client.ts's ReceiptRetryConfig tops out
 * at a few hundred ms). Five minutes is generous headroom for real-world
 * clock drift and network latency between a gateway and a self-hosted AS on
 * a different machine, while still bounding how long a stolen or replayed
 * ticket stays usable. This is a hardening measure, NOT full replay
 * protection on its own — see the module doc comment.
 */
export const TICKET_MAX_AGE_SECONDS = 5 * 60;

/**
 * How far in the FUTURE a ticket's timestamp may be before it's refused.
 * Real clock skew between two machines is normally low single-digit seconds;
 * this leaves headroom for that without accepting a timestamp that's
 * obviously fabricated or from a clock set wrong.
 */
export const TICKET_MAX_CLOCK_SKEW_SECONDS = 30;

export interface ExpectedTicket {
  /** The namespaced tool name this call requested a ticket for. */
  action: string;
  /** The executionContext sent in the receipt request, if any. */
  executionContext?: Record<string, unknown>;
  /** The per-ceremony grant id this call requested a ticket against. */
  authorizationId?: string;
  /** The profile id this call requested a ticket against. */
  profileId?: string;
  /**
   * The proposal id this call is executing — review path only. When set,
   * the receipt MUST carry the same `proposalId`: a receipt minted for a
   * different (or no) proposal must never be accepted just because its
   * action/executionContext happen to match, or a proposal the Authority
   * Server never saw could be paired with an unrelated genuine ticket and
   * executed.
   */
  proposalId?: string;
}

/**
 * @throws AsKeyMismatchError when the pinned key rejects the signature (or
 *   is itself unavailable/mismatched — see attestation-cache.ts).
 * @throws TicketBindingMismatchError when the signature is fine but the
 *   ticket's own bound fields disagree with what was requested, or its
 *   timestamp is stale or implausibly in the future.
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

  if (expected.authorizationId !== undefined && receipt.authorizationId !== expected.authorizationId) {
    throw new TicketBindingMismatchError(
      `Ticket authorizationId "${String(receipt.authorizationId)}" does not match the requested ` +
        `grant "${expected.authorizationId}" — refusing to execute.`,
    );
  }

  if (expected.profileId !== undefined && receipt.profileId !== expected.profileId) {
    throw new TicketBindingMismatchError(
      `Ticket profileId "${String(receipt.profileId)}" does not match the requested profile ` +
        `"${expected.profileId}" — refusing to execute.`,
    );
  }

  // Required to match whenever the caller IS executing a specific proposal
  // (the review path always passes this). A receipt with no proposalId at
  // all (e.g. a plain automatic-mode ticket) — or one for a DIFFERENT
  // proposal — must never authorize this one, however well its other fields
  // line up: that is exactly the "pair a genuine ticket with an injected
  // proposal" attack the impostor-relay e2e suite exercises.
  if (expected.proposalId !== undefined && receipt.proposalId !== expected.proposalId) {
    throw new TicketBindingMismatchError(
      `Ticket proposalId "${String(receipt.proposalId)}" does not match the proposal being executed ` +
        `"${expected.proposalId}" — refusing to execute.`,
    );
  }

  const timestamp = receipt.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new TicketBindingMismatchError('Ticket carries no valid timestamp — refusing to execute.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - timestamp;
  if (ageSec > TICKET_MAX_AGE_SECONDS) {
    throw new TicketBindingMismatchError(
      `Ticket is ${ageSec}s old, older than the ${TICKET_MAX_AGE_SECONDS}s freshness window — refusing to execute.`,
    );
  }
  if (ageSec < -TICKET_MAX_CLOCK_SKEW_SECONDS) {
    throw new TicketBindingMismatchError(
      `Ticket is timestamped ${-ageSec}s in the future, beyond the ${TICKET_MAX_CLOCK_SKEW_SECONDS}s clock-skew ` +
        `tolerance — refusing to execute.`,
    );
  }
}
