/**
 * Prove the Authority Server holds the key the app has pinned, BEFORE the phone signs anything for it. The browser
 * counterpart of the gateway's as-challenge.ts, same construction (suveren-as `signChallenge`):
 *
 *   POST /api/as/challenge { nonce }  ->  { typ: "hap-as-challenge", nonce, issuedAt, signature }
 *   signed bytes = utf8("hap-as-challenge" + NUL) || utf8(JCS({ typ, nonce, issuedAt }))
 *
 * What this stops: a server that answers but cannot sign under the pinned key. What it does not stop: a relay that
 * forwards every call to the real server; only TLS stops that (the browser checks the certificate; the app cannot pin it).
 *
 * The key is pinned where the pairing QR carries it (`as_key`, plan 4.3 step 2); at a registration with an enrolment
 * code there is no QR, so the app asks the server for its key once and pins what it found (trust on first use, over TLS).
 */
import { b64uEncode, hexDecode, jcs, randomBytes, utf8, concat, verifyEd25519 } from '@hap/core/device-keys';
import type { Transport } from './transport';
import { UnreachableError } from './transport';

export type AsKeyCheck =
  | { ok: true; keyHex: string }
  | { ok: false; code: 'as_unreachable' | 'as_unverified' | 'as_key_mismatch' | 'as_answer_invalid' };

const CHALLENGE_TYPE = 'hap-as-challenge';
const DOMAIN_PREFIX = 'hap-as-challenge\u0000';
/** How far `issuedAt` may be from now, seconds (same as the gateway). */
export const CHALLENGE_MAX_SKEW = 300;

/** The server signs standard base64; base64url is accepted too. */
function decodeSignature(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Ask the server to sign a fresh nonce and verify it under `keyHex`. */
export async function proveAsKey(t: Transport, keyHex: string, now: () => number): Promise<AsKeyCheck> {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) return { ok: false, code: 'as_key_mismatch' };
  const nonce = b64uEncode(randomBytes(32));
  let reply;
  try {
    reply = await t.call('POST', '/api/as/challenge', { body: { nonce } });
  } catch (e) {
    if (e instanceof UnreachableError) return { ok: false, code: 'as_unreachable' };
    throw e;
  }
  if (reply.status >= 500 || reply.status === 429) return { ok: false, code: 'as_unreachable' };
  const b = reply.body as Record<string, unknown> | null;
  if (reply.status !== 200 || !b || typeof b !== 'object') return { ok: false, code: 'as_answer_invalid' };
  if (b.typ !== CHALLENGE_TYPE || b.nonce !== nonce || typeof b.issuedAt !== 'number' || !Number.isFinite(b.issuedAt)
    || typeof b.signature !== 'string' || !b.signature) return { ok: false, code: 'as_answer_invalid' };
  if (Math.abs(now() - b.issuedAt) > CHALLENGE_MAX_SKEW) return { ok: false, code: 'as_unverified' };
  const sig = decodeSignature(b.signature);
  if (!sig) return { ok: false, code: 'as_answer_invalid' };
  const bytes = concat(utf8(DOMAIN_PREFIX), utf8(jcs({ typ: b.typ, nonce: b.nonce, issuedAt: b.issuedAt })));
  const ok = await verifyEd25519(hexDecode(keyHex), bytes, sig);
  return ok ? { ok: true, keyHex } : { ok: false, code: 'as_unverified' };
}

/**
 * First registration only: learn the key the server names (GET /api/as/pubkey) and require it to prove it holds it.
 * The result is what the app pins.
 */
export async function learnAsKey(t: Transport, now: () => number): Promise<AsKeyCheck> {
  let reply;
  try {
    reply = await t.call('GET', '/api/as/pubkey');
  } catch (e) {
    if (e instanceof UnreachableError) return { ok: false, code: 'as_unreachable' };
    throw e;
  }
  const key = (reply.body as { publicKey?: unknown } | null)?.publicKey;
  if (reply.status !== 200 || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return { ok: false, code: 'as_answer_invalid' };
  return proveAsKey(t, key, now);
}
