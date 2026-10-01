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
 * key (SPKI, SHA-256 — the same value HPKP called `pin-sha256`) at pairing,
 * and refuses every later connection whose certificate doesn't carry that
 * same key, even one a locally-trusted CA (e.g. a custom `--ca-file`) would
 * otherwise accept. This is independent of certificate validity/expiry: a
 * renewed certificate for the SAME key keeps the pin; a NEW key needs
 * re-pairing (clear the pin, sign in again) — the same replacement rule as
 * the Ed25519 signing-key pin in as-pairing.ts.
 *
 * Mirrors `apps/control-plane/src/lib/as-tls-pin.ts`. Keep the two in step.
 */
import { createHash } from 'node:crypto';
import { checkServerIdentity as defaultCheckServerIdentity, rootCertificates } from 'node:tls';
import type { PeerCertificate } from 'node:tls';
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

/** Thrown whenever a pin-tls-enforced connection's certificate does not
 *  carry the pinned SPKI — including when the underlying `fetch` call
 *  itself failed for some other reason while a dispatcher built by
 *  {@link buildPinnedDispatcher} was in use, so callers don't have to
 *  separately unwrap undici's connection-error wrapping to tell a pin
 *  failure apart from an ordinary network error. */
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
 * An undici Agent whose TLS `checkServerIdentity`:
 *  1. Runs Node's DEFAULT hostname check first (so ordinary certificate and
 *     hostname validation still applies — including trust via a custom
 *     `--ca-file`, which Node threads into the CA store this check runs
 *     against).
 *  2. Then ALSO requires the leaf certificate's SPKI SHA-256 to equal
 *     `pinnedSpkiHex`.
 * Returning an `Error` from `checkServerIdentity` aborts the TLS handshake
 * itself — before any request headers or body are sent, and before any
 * response is read — not merely after the fact.
 */
export function buildPinnedDispatcher(pinnedSpkiHex: string): Dispatcher {
  const wantHex = pinnedSpkiHex.toLowerCase();
  return new Agent({
    connect: {
      ca: effectiveCa(),
      checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
        const defaultErr = defaultCheckServerIdentity(hostname, cert);
        if (defaultErr) return defaultErr;
        let actualHex: string;
        try {
          actualHex = spkiSha256Hex(cert);
        } catch (err) {
          return new Error(
            `could not read the server certificate's public key to check the TLS pin — ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (actualHex !== wantHex) {
          return new Error(
            `TLS certificate pin mismatch for ${hostname}: expected SPKI sha256 ` +
              `${formatPinFingerprint(wantHex)}, got ${formatPinFingerprint(actualHex)}.`,
          );
        }
        return undefined;
      },
    },
  });
}

/**
 * An undici Agent that runs ONLY the default hostname/trust check (no pin
 * enforcement — there is nothing to enforce yet) and records the detailed
 * certificate of the first connection it makes, for the caller to pin.
 * Used exactly once per gateway, at the moment pin-tls has just been turned
 * on and no pin exists yet for this Authority Server URL.
 */
export function buildCapturingDispatcher(): { dispatcher: Dispatcher; getCapturedCert: () => PeerCertificate | undefined } {
  let captured: PeerCertificate | undefined;
  const dispatcher = new Agent({
    connect: {
      ca: effectiveCa(),
      checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
        captured = cert;
        return defaultCheckServerIdentity(hostname, cert);
      },
    },
  });
  return { dispatcher, getCapturedCert: () => captured };
}

export interface AsFetchPinning {
  /** `config set pin-tls on` / `--pin-tls` — the saved setting. */
  enabled: boolean;
  /** The pinned SPKI hash for this exact Authority Server URL, if one has
   *  already been captured. */
  pinnedSpkiHex?: string;
  /**
   * Allow CAPTURING a new pin from this call when `pinnedSpkiHex` is unset.
   * Only ever true for the challenge/sign-in exchange (as-challenge.ts) —
   * every other AS call must either enforce an existing pin or refuse, never
   * silently adopt whatever certificate answers it. Ignored once a pin
   * already exists: that path always enforces, never re-captures — pin
   * replacement is only by re-pairing (clear the pin, sign in again).
   */
  captureIfUnpinned?: boolean;
}

export interface AsFetchResult {
  res: Response;
  /** Set only when pinning was enabled, no pin existed yet, capture was
   *  allowed, and the connection succeeded — the SPKI hash of the leaf
   *  certificate that answered THIS call. The caller persists it (see
   *  as-pairing.ts's `writePairing` / `recordTlsPin`) only once the rest of
   *  the exchange it was captured from (the Ed25519 challenge) has verified. */
  capturedSpkiHex?: string;
}

/**
 * The ONE place every Authority Server HTTP call from this process must go
 * through once pin-tls is a concern — in this app that's `SPClient.fetch()`
 * in sp-client.ts, the single chokepoint every AS call (receipt, proposals,
 * attestations, pubkey, …) already goes through. Not wired into bare
 * `fetch()` globally — only the AS call site uses this.
 *
 * @throws AsTlsMismatchError when pinning is enabled and either (a) a pin
 *   exists but the live certificate's SPKI doesn't match it, or (b) no pin
 *   exists yet and this call isn't allowed to capture one.
 */
export async function fetchAs(
  url: string,
  init: RequestInit | undefined,
  pinning: AsFetchPinning,
): Promise<AsFetchResult> {
  if (!pinning.enabled) {
    const res = await fetch(url, init);
    return { res };
  }

  if (pinning.pinnedSpkiHex) {
    const dispatcher = buildPinnedDispatcher(pinning.pinnedSpkiHex);
    try {
      const res = (await undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher })) as unknown as Response;
      return { res };
    } catch (err) {
      throw new AsTlsMismatchError(
        `TLS pin check failed for ${url} — ${describeFetchError(err)}. Refusing the connection; the API ` +
          `key / session cookie were never sent. If the Authority Server's certificate changed ` +
          `intentionally (a new key, not just renewal), an operator must clear the pairing and sign in ` +
          `again to re-pin it.`,
      );
    }
  }

  if (!pinning.captureIfUnpinned) {
    throw new AsTlsMismatchError(
      `TLS pinning is enabled but no certificate is pinned yet for ${url} — sign in once to establish ` +
        `the pin before this call can be trusted.`,
    );
  }

  const { dispatcher, getCapturedCert } = buildCapturingDispatcher();
  const res = (await undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher })) as unknown as Response;
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
