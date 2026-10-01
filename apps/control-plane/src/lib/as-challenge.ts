/**
 * Checks that the Authority Server at a URL can produce a signature under
 * the Ed25519 key being checked (the pin, or — on first pairing — the
 * candidate key `/api/as/pubkey` just reported) — not just that it can
 * answer a plain GET with a public key, which proves nothing about holding
 * the matching private key.
 *
 * Scope: this refuses a server that cannot sign under the expected key
 * before any credential is sent. It does NOT protect against an on-path
 * relay that transparently forwards every request — including the
 * challenge itself — to the real Authority Server and relays back its
 * genuine answer; against that, only TLS (certificate validation) protects.
 * What this catches is a response that could not have come from whoever
 * holds the real signing key: e.g. a cached/stale public key answer paired
 * with a signature nobody with that key actually produced.
 *
 * Called from auth.ts BEFORE the API key is sent anywhere.
 */
import { createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { canonicalize } from '@hap/core';

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
 * Domain-separation prefix for the challenge signature — a literal byte
 * string (NOT part of the JCS-canonicalized object), terminated with a NUL
 * byte. Deliberately NOT the same scheme as ticket (receipt) signatures,
 * which sign plain `JCS(unsigned)` with no prefix (see hap-core's
 * `verifyReceiptSignature` / the MCP server's ticket-verify.ts): reusing
 * that exact scheme here would mean a signature over a challenge object and
 * a signature over some other JCS-canonicalized object of the same shape
 * are the same bytes if the fields happened to coincide — i.e. a ticket
 * signature could be replayed as a challenge signature, or vice versa. The
 * prefix makes the two signing domains unambiguously different messages
 * under the same key.
 */
const CHALLENGE_DOMAIN_PREFIX = 'hap-as-challenge\u0000';

interface UnsignedChallenge {
  typ: unknown;
  nonce: unknown;
  issuedAt: unknown;
}

/** The exact bytes the Authority Server signs: the domain prefix followed by
 *  `JCS({ typ, nonce, issuedAt })` — exactly those three fields, nothing
 *  reshaped or reordered by hand. */
function challengeSigningBytes(unsigned: UnsignedChallenge): Buffer {
  return Buffer.concat([
    Buffer.from(CHALLENGE_DOMAIN_PREFIX, 'utf-8'),
    Buffer.from(canonicalize({ typ: unsigned.typ, nonce: unsigned.nonce, issuedAt: unsigned.issuedAt }), 'utf-8'),
  ]);
}

/** Decode a hex-encoded raw Ed25519 public key (the shape `/api/as/pubkey`
 *  and the pin both use) into a usable node:crypto key object. */
function publicKeyFromHex(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex, 'hex');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/**
 * Verify an Ed25519 signature over the domain-separated challenge message
 * (see {@link CHALLENGE_DOMAIN_PREFIX}) under `publicKeyHex`. Encoded like
 * ticket signatures: standard base64, but base64url is accepted too (the
 * `-`/`_` → `+`/`/` remap below, same as hap-core's receipt verification).
 *
 * Returns `false` rather than throwing on any malformed input (bad hex,
 * bad base64, wrong-length signature) — the caller treats "doesn't verify"
 * and "couldn't even be checked" identically (both refuse).
 */
export function verifyChallengeSignature(
  publicKeyHex: string,
  unsigned: UnsignedChallenge,
  signature: string,
): boolean {
  try {
    const base64 = signature.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const sigBytes = Buffer.from(base64 + padding, 'base64');
    const key = publicKeyFromHex(publicKeyHex);
    return cryptoVerify(null, challengeSigningBytes(unsigned), key, sigBytes);
  } catch {
    return false;
  }
}

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

  // Domain-separated verification (see CHALLENGE_DOMAIN_PREFIX) — deliberately
  // NOT hap-core's verifyReceiptSignature, which signs plain JCS with no
  // prefix: using that here would make a challenge signature verifiable as a
  // plain-JCS signature (and vice versa), collapsing two signing domains that
  // must stay distinct under the same key.
  if (!verifyChallengeSignature(publicKeyHex, { typ: body.typ, nonce: body.nonce, issuedAt: body.issuedAt }, body.signature)) {
    throw new AsChallengeInvalidError(
      'the challenge signature does not verify under the key being checked — this is exactly what the ' +
        'challenge exists to catch: something answered the request but does not hold the matching private key.',
    );
  }
}
