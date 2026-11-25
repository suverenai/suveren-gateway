/**
 * How set-up and device sign-in decide to trust the Authority Server, built from
 * the same pieces the account-key login uses (routes/auth.ts checkAsKeyBeforeLogin):
 * the signing key it holds is proven by a challenge before anything is sent to it,
 * a first pairing is recorded, and the TLS pin is kept fresh. The `aud` of a
 * sign-in is this verified key, never a key the Authority Server names later.
 */

import { readPairing, writePairing, recordTlsPin, fingerprintOf } from './as-pairing';
import { resolvePinTls, clearPinTlsExpectedFingerprint } from './as-config';
import type { AsFetchPinning } from './as-tls-pin';
import type { AsKeyCheck } from './device-signin';

interface RawCheck {
  ok: boolean;
  publicKeyHex?: string;
  tlsSpkiPinHex?: string;
  error?: 'as_unreachable' | 'as_unverified' | 'as_key_mismatch' | 'as_tls_mismatch';
  message?: string;
}

export function createAsKeyCheck(
  asUrl: string,
  dataDir: string,
  /** routes/auth.ts `checkAsKeyBeforeLogin`. */
  check: (asUrl: string, dataDir: string) => Promise<RawCheck>,
  log: (m: string) => void = m => console.error(m),
): () => Promise<AsKeyCheck> {
  return async () => {
    const k = await check(asUrl, dataDir);
    if (!k.ok || !k.publicKeyHex) return { ok: false, code: k.error ?? 'as_unverified', ...(k.message ? { message: k.message } : {}) };
    const existing = readPairing(dataDir);
    if (!existing || existing.asUrl !== asUrl) {
      writePairing(dataDir, asUrl, k.publicKeyHex, { tlsSpkiPinHex: k.tlsSpkiPinHex });
      log(`[Control Plane] Paired with Authority Server ${asUrl} (fingerprint ${fingerprintOf(k.publicKeyHex)})`);
    } else if (k.tlsSpkiPinHex && k.tlsSpkiPinHex !== existing.tlsSpkiPinHex) {
      recordTlsPin(dataDir, asUrl, k.tlsSpkiPinHex);
    }
    clearPinTlsExpectedFingerprint(dataDir);
    return { ok: true, publicKeyHex: k.publicKeyHex };
  };
}

/** The TLS pin rules for every Authority Server call after the key check (enforced only where pin-tls is on). */
export function asPinning(asUrl: string, dataDir: string): AsFetchPinning {
  const pin = readPairing(dataDir);
  return { enforce: resolvePinTls(dataDir), pinnedSpkiHex: pin && pin.asUrl === asUrl ? pin.tlsSpkiPinHex : undefined };
}
