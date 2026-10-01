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
 *  3. The receipt's `contentHash`/`contentBinding` — when the profile binds
 *     content — must match what THIS gateway computed for this call. The AS
 *     never sees the content, only the hash; a mismatch means a different
 *     artifact was approved, or the hash was swapped in transit.
 *  4. The receipt's signed `timestamp` must be recent — see
 *     TICKET_MAX_AGE_SECONDS / TICKET_MAX_CLOCK_SKEW_SECONDS below. This is
 *     hardening, not full replay protection on its own — see check 5.
 *  5. The receipt's `idempotencyKey` — whenever THIS call generated one (the
 *     automatic path always does; tool-proxy.ts's M3 key, reused across
 *     postReceipt's internal retries) — must match it exactly. The Authority
 *     Server signs `idempotencyKey` into the receipt verbatim whenever the
 *     request carried one, so a ticket genuinely signed for a DIFFERENT call
 *     of the same shape (same action/executionContext/grant, different
 *     invocation) can no longer be substituted for this one — closing the gap
 *     that used to exist here, where a fresh and validly-signed ticket for
 *     "the same kind of call" couldn't be told apart from a ticket for THIS
 *     specific call. Missing on the ticket when this call sent one is a
 *     mismatch, not a pass: the rollout order is Authority Server first, so
 *     by the time a gateway checks this, the AS it talks to always echoes
 *     the key back when given one.
 *
 * What this does NOT do: cross-check a review-mode proposal's tool/args
 * against what THIS gateway itself submitted, when it was the submitter —
 * that is proposal-submission-store.ts, used by commitments.ts alongside
 * this module. When this gateway was NOT the submitter (no local record),
 * commitments.ts skips the proposal quietly rather than executing OR
 * refusing-as-an-attack — see its own docs for why (a genuine AS legitimately
 * lists proposals submitted by the same operator's other gateways too).
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
  /**
   * The idempotency key THIS call generated and sent with its receipt
   * request, when it sent one — see check 5 in the module doc comment. The
   * automatic path always sends one; the review path deliberately does not
   * (a proposal's `proposalId` is its own retry-safe key), so this is left
   * undefined there and the check below does not apply.
   */
  idempotencyKey?: string;
  /**
   * The content hash THIS gateway computed for this call (computeContentBinding
   * in content-binding.ts), present iff the profile declares a content_binding.
   * The AS copies it into the signed receipt verbatim without ever seeing the
   * content — so a receipt whose `contentHash` disagrees means either a
   * different artifact was approved, or the AS/relay swapped it in transit.
   */
  contentHash?: string;
  /** How `contentHash` above was computed — echoed into the signed receipt
   *  alongside it; must match exactly (same version/kind/fields) so a
   *  verifier downstream knows what the hash actually covers. */
  contentBinding?: { version: string; kind: string; fields?: string[] };
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

  // G4: when THIS call sent an idempotency key with its receipt request, the
  // ticket must carry the identical one. An absent key on the ticket counts
  // as a mismatch (fail closed — see check 5 in the module doc comment), not
  // as "the AS doesn't support this yet": the Authority Server is upgraded
  // first by convention, so by the time a gateway enforces this, the AS it
  // talks to always echoes the key back when given one. Idempotent replay of
  // the SAME call (same key) still passes, by construction — nothing here
  // changes between calls that reuse the same key for the same invocation.
  if (expected.idempotencyKey !== undefined && receipt.idempotencyKey !== expected.idempotencyKey) {
    throw new TicketBindingMismatchError(
      `Ticket idempotencyKey "${String(receipt.idempotencyKey)}" does not match the one this call sent ` +
        `"${expected.idempotencyKey}" — refusing to execute.`,
    );
  }

  // Content binding: present only for profiles that declare one (records,
  // customers, and — later — the communicative profiles). Checked whenever
  // THIS call computed a contentHash, regardless of whether the receipt
  // carries one at all: an absent or mismatched contentHash on a call that
  // was supposed to bind content is exactly as dangerous as a wrong one —
  // it means the receipt does not actually commit to what is about to run.
  if (expected.contentHash !== undefined) {
    if (receipt.contentHash !== expected.contentHash) {
      throw new TicketBindingMismatchError(
        'Ticket contentHash does not match the content this call is bound to — refusing to execute.',
      );
    }
    if (
      expected.contentBinding !== undefined &&
      hashToolArgs(receipt.contentBinding ?? {}) !== hashToolArgs(expected.contentBinding)
    ) {
      throw new TicketBindingMismatchError(
        'Ticket contentBinding does not match what this call requested — refusing to execute.',
      );
    }
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
