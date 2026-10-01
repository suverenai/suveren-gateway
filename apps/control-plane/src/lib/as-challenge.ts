/**
 * Proof that the Authority Server at a URL actually HOLDS the Ed25519
 * signing key it presents — not just that it can answer a plain GET with a
 * public key.
 *
 * Before this existed, pairing/pinning (as-pairing.ts) only compared a
 * REPORTED public key against the pin. `GET /api/as/pubkey` is a cheap,
 * non-secret read: something that merely relays that one call to the real
 * Authority Server — without holding its private key itself — would pass
 * that comparison every time it ran, because reporting a key proves nothing
 * about possessing it. A fresh, server-signed nonce closes that gap: only
 * something holding the matching private key can produce a signature that
 * verifies under it.
 *
 * Called from auth.ts BEFORE the API key is sent anywhere.
 */
import { randomBytes } from 'node:crypto';
import { verifyReceiptSignature, type ReceiptPayload } from '@hap/core';

/** The challenge endpoint is unreachable, answered with an error status, or
 *  replied with something that isn't a well-formed challenge object at all.
 *  Distinct from {@link AsChallengeInvalidError}: this says nothing about
 *  whether the Authority Server holds the right key — only that nothing
 *  could be checked at all. */
export class AsChallengeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsChallengeUnreachableError';
  }
}

/** The challenge endpoint answered, but the response doesn't prove the
 *  Authority Server holds the expected signing key: wrong `typ`, an echoed
 *  `nonce` that doesn't match what was sent, a stale/future `issuedAt`, or a
 *  signature that doesn't verify under the key being checked. */
export class AsChallengeInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsChallengeInvalidError';
  }
}

/** How far `issuedAt` may drift from now, in either direction. Generous for
 *  cross-machine clock drift while still bounding how old a challenge
 *  response may be and still be accepted (the `nonce` must match too, so
 *  this is not the only thing standing between "signed just now" and a
 *  captured response, but it keeps the overall proof close to it). */
export const CHALLENGE_MAX_SKEW_SECONDS = 300;

const CHALLENGE_TYPE = 'hap-as-challenge';

/**
 * Ask the Authority Server at `asUrl` to sign a fresh nonce, then verify the
 * answer proves it holds the private key matching `publicKeyHex`.
 *
 * @throws AsChallengeUnreachableError on network failure, a non-2xx
 *   response, or a malformed response body — nothing could be checked.
 * @throws AsChallengeInvalidError when the response doesn't check out: wrong
 *   `typ`, a `nonce` that doesn't match what was sent, a stale/future
 *   `issuedAt`, or a signature that fails to verify under `publicKeyHex`.
 */
export async function verifyAsHoldsKey(asUrl: string, publicKeyHex: string): Promise<void> {
  const nonce = randomBytes(32).toString('base64url');

  let res: Response;
  try {
    res = await fetch(`${asUrl}/api/as/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new AsChallengeUnreachableError(
      `could not reach the Authority Server at ${asUrl} to verify it holds its signing key — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new AsChallengeUnreachableError(
      `the Authority Server at ${asUrl} answered its signing-key challenge with HTTP ${res.status}`,
    );
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    throw new AsChallengeUnreachableError(
      `the Authority Server at ${asUrl} returned a malformed response to its signing-key challenge`,
    );
  }

  if (body.typ !== CHALLENGE_TYPE) {
    throw new AsChallengeInvalidError(
      `the challenge response carries the wrong type ("${String(body.typ)}", expected "${CHALLENGE_TYPE}")`,
    );
  }
  if (body.nonce !== nonce) {
    throw new AsChallengeInvalidError(
      'the challenge response echoes a different nonce than the one sent',
    );
  }
  if (typeof body.issuedAt !== 'number' || !Number.isFinite(body.issuedAt)) {
    throw new AsChallengeInvalidError('the challenge response carries no valid issuedAt');
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - body.issuedAt);
  if (skew > CHALLENGE_MAX_SKEW_SECONDS) {
    throw new AsChallengeInvalidError(
      `the challenge response is timestamped ${skew}s away from now, beyond the ` +
        `${CHALLENGE_MAX_SKEW_SECONDS}s tolerance`,
    );
  }
  if (typeof body.signature !== 'string' || !body.signature) {
    throw new AsChallengeInvalidError('the challenge response carries no signature');
  }

  // Same hap-core primitive used to verify ticket (receipt) signatures:
  // strip `signature`, JCS-canonicalize the rest, verify Ed25519 — see
  // ticket-verify.ts in the MCP server. Passed through UNMODIFIED (not
  // reshaped into {typ, nonce, issuedAt} by hand) so this checks the EXACT
  // bytes the Authority Server signed. The function's type parameter names
  // it for receipts, but it operates on whatever object shape it is given.
  try {
    await verifyReceiptSignature(body as unknown as ReceiptPayload, publicKeyHex);
  } catch (err) {
    throw new AsChallengeInvalidError(
      'the challenge signature does not verify under the key being checked — ' +
        `${err instanceof Error ? err.message : String(err)}. This is exactly what the challenge exists ` +
        'to catch: something answered the request but does not hold the matching private key.',
    );
  }
}
