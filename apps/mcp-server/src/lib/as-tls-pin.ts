/**
 * Opt-in TLS certificate pinning for connections to the Authority Server
 * (`config set pin-tls on` / `--pin-tls`, default OFF).
 *
 * Scope: the AS-holds-its-key challenge (as-challenge.ts) proves the AS can
 * sign under the expected key, but — as documented there — it is not a
 * substitute for TLS against an on-path relay that transparently forwards
 * every request, including the challenge, to the genuine Authority Server:
 * TLS itself is what's supposed to prevent that, via certificate validation.
 * Pin-tls hardens exactly that: it pins the AS TLS leaf certificate's public
 * key (SPKI, SHA-256 — the same value HPKP called `pin-sha256`) and refuses
 * every later connection whose certificate doesn't carry that same key, even
 * one a locally-trusted CA (e.g. a custom `--ca-file`) would otherwise
 * accept. This is independent of certificate validity/expiry: a renewed
 * certificate for the SAME key keeps the pin; a NEW key needs re-pairing
 * (clear the pin, sign in again) — the same replacement rule as the Ed25519
 * signing-key pin in as-pairing.ts.
 *
 * Pinned connections trust Node's OWN bundled root certificates plus
 * `--ca-file` / `NODE_EXTRA_CA_CERTS` (see {@link effectiveCa}) — NOT the
 * operating system's trust store. A certificate your OS trusts (e.g. one
 * added to the macOS/Windows keychain) is not automatically trusted here;
 * use `--ca-file` for a self-hosted AS's internal CA.
 *
 * The pin is CAPTURED at every verified sign-in challenge (as-challenge.ts),
 * independent of whether pin-tls is currently on — so turning pin-tls on
 * later uses a pin already captured at a past pairing, never a fresh
 * trust-on-first-use moment while enforcement is active. Enforcement
 * (refusing a mismatch, or refusing to connect at all when no pin is on
 * file) only ever applies when pin-tls is on; see {@link AsFetchPinning}.
 *
 * Mirrors `apps/control-plane/src/lib/as-tls-pin.ts`. Keep the two in step.
 */
import { createHash } from 'node:crypto';
import { checkServerIdentity as defaultCheckServerIdentity, rootCertificates } from 'node:tls';
import type { PeerCertificate } from 'node:tls';
import { Agent as HttpsAgent } from 'node:https';
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * The effective trust store for a dispatcher THIS module builds: Node's own
 * default roots, PLUS `--ca-file` / `config set ca-file`'s content if set.
 *
 * bundle/server.js resolves `--ca-file` into `NODE_EXTRA_CA_CERTS` (merged
 * with any pre-existing value) once, at process start, for the DEFAULT
 * Node/undici trust store — where Node's own documented "extra" behaviour
 * (additive to the built-in roots) applies automatically. A dispatcher built
 * here with its own `connect.ca` does NOT get that "extra" treatment for
 * free: passing `ca` to `tls.connect` REPLACES the default roots rather than
 * adding to them, so this explicitly prepends `tls.rootCertificates` — this
 * is the ONLY place that does, which is what makes `--ca-file` keep working
 * together with pin-tls. Read fresh on every call (cheap; a handful of PEM
 * certs) rather than cached, so a changed env takes effect immediately, same
 * reasoning as re-reading the pin itself on every call.
 *
 * Deliberately NOT the OS trust store (there is no portable, dependency-free
 * way to read it from Node) — see the module doc comment.
 */
function effectiveCa(): string[] | undefined {
  const path = process.env.NODE_EXTRA_CA_CERTS;
  if (!path) return undefined;
  try {
    return [...rootCertificates, readFileSync(path, 'utf-8')];
  } catch {
    return undefined; // malformed/unreadable — fall back to the default trust store
  }
}

/**
 * Marks an `Error` as having come from INSIDE a `checkServerIdentity`
 * rejection (ours, or Node's own default hostname check) — as opposed to an
 * ordinary connection failure (DNS, ECONNREFUSED, timeout, TLS handshake
 * failure for an unrelated reason such as an untrusted/expired certificate
 * chain). `fetchAs` uses this to decide whether an Authority Server OUTAGE
 * gets misreported as a certificate-pin security event: only a tagged error
 * becomes {@link AsTlsMismatchError}; everything else passes through
 * unchanged for the caller's normal "AS unreachable" handling.
 */
const PIN_CHECK_ERROR_CODE = 'EAS_TLS_PIN_CHECK';

function taggedCheckError(err: Error): Error {
  (err as NodeJS.ErrnoException).code = PIN_CHECK_ERROR_CODE;
  return err;
}

/** True when `err` (or anything in its `.cause` chain) was tagged by
 *  {@link taggedCheckError} — i.e. genuinely came from a checkServerIdentity
 *  rejection, not from an unrelated network failure. Exported for the
 *  control-plane's `/api` proxy (index.ts), whose `on.error` handler needs
 *  the same distinction to decide whether to lock the gateway. */
export function isPinCheckError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error && (cur as NodeJS.ErrnoException).code === PIN_CHECK_ERROR_CODE) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Thrown when a pin-tls-enforced connection must be refused: the
 *  certificate's SPKI doesn't match the pin, the default hostname check
 *  itself failed, or pin-tls is on but no pin is on file yet (re-pairing
 *  required). Never thrown for an ordinary network failure — see
 *  {@link isPinCheckError}. */
export class AsTlsMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsTlsMismatchError';
  }
}

/**
 * SHA-256 of the DER-encoded SubjectPublicKeyInfo of a peer certificate.
 * `cert.pubkey` is only populated on the DETAILED certificate object
 * (`tls.TLSSocket.getPeerCertificate(true)`, or the object Node's own
 * `checkServerIdentity` is called with) — never on the plain one.
 */
export function spkiSha256Hex(cert: PeerCertificate): string {
  if (!cert.pubkey) {
    throw new Error('peer certificate carries no pubkey (expected the detailed certificate object)');
  }
  return createHash('sha256').update(cert.pubkey).digest('hex');
}

/** Group a hex digest into colon-separated uppercase quads — the form an
 *  admin can read aloud over a second channel (same convention as
 *  as-pairing.ts's `fingerprintOf`, applied here to an already-computed
 *  digest rather than re-hashing a key). */
export function formatPinFingerprint(hex: string): string {
  const upper = hex.toUpperCase();
  return upper.match(/.{1,4}/g)?.join(':') ?? upper;
}

/**
 * Checks a peer certificate against `pinnedSpkiHex` — Node's DEFAULT
 * hostname check first, then the SPKI SHA-256 compare. Shared by every
 * dispatcher/agent this module builds (undici `Agent` below, and the native
 * `https.Agent` for the control-plane's `/api` proxy) so the two can never
 * drift. Every error returned is tagged (see {@link taggedCheckError}).
 */
function pinnedCheckServerIdentity(pinnedSpkiHex: string) {
  const wantHex = pinnedSpkiHex.toLowerCase();
  return (hostname: string, cert: PeerCertificate): Error | undefined => {
    const defaultErr = defaultCheckServerIdentity(hostname, cert);
    if (defaultErr) return taggedCheckError(defaultErr);
    let actualHex: string;
    try {
      actualHex = spkiSha256Hex(cert);
    } catch (err) {
      return taggedCheckError(new Error(
        `could not read the server certificate's public key to check the TLS pin — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ));
    }
    if (actualHex !== wantHex) {
      return taggedCheckError(new Error(
        `TLS certificate pin mismatch for ${hostname}: expected SPKI sha256 ` +
          `${formatPinFingerprint(wantHex)}, got ${formatPinFingerprint(actualHex)}.`,
      ));
    }
    return undefined;
  };
}

/**
 * An undici Agent whose TLS `checkServerIdentity` enforces `pinnedSpkiHex`
 * (see {@link pinnedCheckServerIdentity}). Returning an `Error` from
 * `checkServerIdentity` aborts the TLS handshake itself — before any request
 * headers or body are sent, and before any response is read — not merely
 * after the fact.
 */
export function buildPinnedDispatcher(pinnedSpkiHex: string): Dispatcher {
  return new Agent({
    connect: {
      ca: effectiveCa(),
      checkServerIdentity: pinnedCheckServerIdentity(pinnedSpkiHex),
    },
  });
}

/**
 * An undici Agent that runs ONLY the default hostname/trust check (no pin
 * enforcement — there is nothing to enforce yet) and records the detailed
 * certificate of the first connection it makes, for the caller to pin.
 * Used by the verified sign-in challenge (as-challenge.ts) to capture — or,
 * with pin-tls off, refresh — the pin on every successful sign-in.
 */
export function buildCapturingDispatcher(): { dispatcher: Dispatcher; getCapturedCert: () => PeerCertificate | undefined } {
  let captured: PeerCertificate | undefined;
  const dispatcher = new Agent({
    connect: {
      ca: effectiveCa(),
      checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
        captured = cert;
        const defaultErr = defaultCheckServerIdentity(hostname, cert);
        return defaultErr ? taggedCheckError(defaultErr) : undefined;
      },
    },
  });
  return { dispatcher, getCapturedCert: () => captured };
}

/**
 * A native `https.Agent` enforcing the SAME pin check as the undici-based
 * dispatchers above, for callers that hand an agent to Node's own
 * `http(s).request` rather than calling `fetch` — namely the control-plane's
 * long-lived `/api` proxy (http-proxy-middleware → node-http-proxy →
 * `https.request({ agent, ... })`), which cannot be expressed as a single
 * `fetchAs` call. `getPinning` is called on EVERY new connection (not
 * cached), so a pin captured by this SAME process moments ago (or a
 * live-edited pin-tls setting) takes effect on the very next connection —
 * existing keep-alive sockets are not retroactively re-checked, same as any
 * TLS pin.
 */
export function buildPinnedHttpsAgent(getPinning: () => AsFetchPinning): HttpsAgent {
  return new HttpsAgent({
    checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
      const pinning = getPinning();
      if (!pinning.enforce) return defaultCheckServerIdentity(hostname, cert);
      if (!pinning.pinnedSpkiHex) {
        return taggedCheckError(new Error(
          `pin-tls is on but no certificate is pinned yet for ${hostname} — sign in again to establish ` +
            `it (re-pairing required).`,
        ));
      }
      return pinnedCheckServerIdentity(pinning.pinnedSpkiHex)(hostname, cert);
    },
    ca: effectiveCa(),
  });
}

export interface AsFetchPinning {
  /**
   * Refuse a MISMATCH, and refuse to connect at all when no pin is on file
   * — true only when `config set pin-tls on` / `--pin-tls`. When false, a
   * missing or differing pin is never refused by this call: either it is
   * being captured/refreshed (see `capture`), or the call simply proceeds
   * unpinned, exactly like a bare `fetch`.
   */
  enforce: boolean;
  /** The pin on file for this Authority Server URL, if any — independent
   *  of `enforce` (see the module doc comment: capture always happens, at
   *  every verified sign-in, whether or not pin-tls is currently on). */
  pinnedSpkiHex?: string;
  /**
   * Only ever set by the verified sign-in challenge (as-challenge.ts) —
   * every OTHER AS call must leave this unset. Permits (re)capturing:
   *  - `enforce: false` → the live certificate's SPKI is captured/returned
   *    UNCONDITIONALLY, overwriting whatever was on file — pinning is off,
   *    so there is nothing to betray, and this is what keeps the pin fresh
   *    for whenever it's later turned on.
   *  - `enforce: true` → captured ONLY when `pinnedSpkiHex` is unset (a
   *    genuine first-ever pairing with pin-tls already on — trust-on-
   *    first-use at the one moment that's legitimate). An EXISTING pin is
   *    enforced instead and never silently replaced.
   */
  capture?: boolean;
}

export interface AsFetchResult {
  res: Response;
  /** Set only when `capture` was requested and the connection succeeded —
   *  the SPKI hash of the leaf certificate that answered THIS call. The
   *  caller persists it (as-pairing.ts's `writePairing` / `recordTlsPin`)
   *  only once the rest of the exchange it was captured from (the Ed25519
   *  challenge) has verified. */
  capturedSpkiHex?: string;
}

/**
 * Upper bound on how long ANY single `fetchAs` call may stay in flight,
 * applied even when the caller passed no `signal` of its own (and combined
 * with one if it did — whichever fires first wins). Exists because a
 * production incident (2026-10-02) showed the alternative: `SPClient.fetch`
 * (sp-client.ts) never passes a `signal` at all, so once undici reused — or
 * this module's own per-call Agent opened — a connection that went silent (a
 * dead keep-alive socket a load balancer/edge dropped without the client
 * ever seeing a FIN/RST), the `await` never settled. The sibling incident
 * was `POST /auth/login` on the control-plane side; this app's every gated
 * tool call goes through the exact same unbounded path via `SPClient.fetch`.
 * There is nothing dangerous about erroring out an AS call after a bound
 * this generous — every caller already treats a thrown error here as "the
 * Authority Server could not be reached" and fails closed.
 */
const DEFAULT_AS_FETCH_TIMEOUT_MS = 15_000;

/** `init.signal` combined with a {@link DEFAULT_AS_FETCH_TIMEOUT_MS} bound —
 *  whichever fires first aborts the call. A caller-supplied signal is never
 *  weakened, only ever tightened. */
function withBoundedSignal(init: RequestInit | undefined): RequestInit {
  const timeout = AbortSignal.timeout(DEFAULT_AS_FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal as AbortSignal, timeout]) : timeout;
  return { ...init, signal };
}

/**
 * Closes `dispatcher` once `pending` settles, without making the caller wait
 * for it (undici's `Dispatcher.close()` itself waits for any still-streaming
 * response body to finish before actually tearing down the connection — see
 * its doc comment — so this never cuts a response short; it only stops the
 * per-call Agent this module builds for the pinned/capturing branches from
 * being silently abandoned, which otherwise leaks one open socket per call
 * forever (the OTHER half of the 2026-10-02 incident: long-running
 * processes accumulating idle ESTABLISHED connections, one per sign-in
 * attempt, none of them ever closed).
 */
function closeAfter(dispatcher: Dispatcher, pending: Promise<unknown>): void {
  pending.catch(() => {}).finally(() => { void dispatcher.close().catch(() => {}); });
}

/**
 * The ONE place every Authority Server HTTP call from this process must go
 * through once pin-tls is a concern — in this app that's `SPClient.fetch()`
 * in sp-client.ts, the single chokepoint every AS call (receipt, proposals,
 * attestations, pubkey, …) already goes through. {@link buildPinnedHttpsAgent}
 * exists here only to mirror the control-plane's module shape (its `/api`
 * proxy is the one caller that needs it); this app has no long-lived proxy
 * agent of its own to attach it to.
 *
 * Every branch below is bounded by {@link DEFAULT_AS_FETCH_TIMEOUT_MS} (see
 * {@link withBoundedSignal}) and, for the pinned/capturing branches, closes
 * its per-call Agent once the call settles (see {@link closeAfter}) — a
 * caller forgetting its own `signal` (as `SPClient.fetch` always has), or the
 * AS going quietly unresponsive, can therefore never hang this call or leak
 * its connection forever.
 *
 * @throws AsTlsMismatchError when `pinning.enforce` and either (a) a pin
 *   exists but the live certificate's SPKI (or hostname) doesn't check out,
 *   or (b) no pin exists yet and this call isn't the capturing challenge.
 *   Never thrown for an ordinary connection failure (DNS, ECONNREFUSED,
 *   timeout, an untrusted certificate chain) — those propagate as-is so an
 *   Authority Server OUTAGE is never misreported as a pin mismatch.
 */
export async function fetchAs(
  url: string,
  init: RequestInit | undefined,
  pinning: AsFetchPinning,
): Promise<AsFetchResult> {
  // Ordinary call (not the capturing challenge), pin-tls off: nothing to
  // enforce and nothing to capture — exactly a bare fetch (still bounded —
  // this is the branch every SPClient call takes by default).
  if (!pinning.enforce && !pinning.capture) {
    const res = await fetch(url, withBoundedSignal(init));
    return { res };
  }

  // Ordinary call, pin-tls on, but nothing is pinned yet (an old pairing
  // from before pin-tls existed, or before this process ever reached a
  // verified sign-in) — refuse outright. Re-pairing (a fresh sign-in, which
  // IS allowed to capture) is required; this call never trusts on first use.
  if (pinning.enforce && !pinning.capture && !pinning.pinnedSpkiHex) {
    throw new AsTlsMismatchError(
      `pin-tls is on but no certificate is pinned yet for ${url} — sign in again to establish it ` +
        `(re-pairing required).`,
    );
  }

  // An existing pin is enforced whenever one is on file — whether this is
  // an ordinary call, or the challenge call finding a pin already there
  // (never silently replaced, even though `capture` is set).
  if (pinning.pinnedSpkiHex && (pinning.enforce || !pinning.capture)) {
    const dispatcher = buildPinnedDispatcher(pinning.pinnedSpkiHex);
    const pending = undiciFetch(url, { ...(withBoundedSignal(init) as Record<string, unknown>), dispatcher });
    closeAfter(dispatcher, pending);
    try {
      const res = (await pending) as unknown as Response;
      return { res };
    } catch (err) {
      if (!isPinCheckError(err)) throw err; // an AS outage, not a pin mismatch — pass through unchanged
      throw new AsTlsMismatchError(
        `TLS pin check failed for ${url} — ${describeFetchError(err)}. Refusing the connection; the API ` +
          `key / session cookie were never sent. If the Authority Server's certificate changed ` +
          `intentionally (a new key, not just renewal), an operator must clear the pairing and sign in ` +
          `again to re-pin it.`,
      );
    }
  }

  // Capturing: the verified challenge, with either pin-tls off (always
  // captures/refreshes) or pin-tls on and genuinely nothing pinned yet
  // (first-ever pairing — trust-on-first-use at the one legitimate moment).
  const { dispatcher, getCapturedCert } = buildCapturingDispatcher();
  const pending = undiciFetch(url, { ...(withBoundedSignal(init) as Record<string, unknown>), dispatcher });
  closeAfter(dispatcher, pending);
  let res: Response;
  try {
    res = (await pending) as unknown as Response;
  } catch (err) {
    if (!isPinCheckError(err)) throw err; // an ordinary connection failure — not a pin/hostname rejection
    throw new AsTlsMismatchError(
      `could not verify the Authority Server at ${url} while establishing its TLS pin — ` +
        `${describeFetchError(err)}.`,
    );
  }
  const cert = getCapturedCert();
  return { res, capturedSpkiHex: cert ? spkiSha256Hex(cert) : undefined };
}

/** Unwrap undici's connection-error wrapping (`cause`) to surface the actual
 *  `checkServerIdentity` message (or whatever else went wrong) rather than
 *  a generic "fetch failed". */
function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return err.message;
  }
  return String(err);
}
