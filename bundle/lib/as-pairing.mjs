/**
 * Minimal reader/writer for `<dataDir>/as-pairing.json` — the CLI's copy.
 *
 * Mirrors `apps/control-plane/src/lib/as-pairing.ts` (same file shape, same
 * rules) but written in plain JS, same reason as `config.mjs`: this runs as
 * `bundle/bin/suveren-gateway.js`, hand-authored ESM shipped as-is. Only
 * what the CLI's `config set pin-tls on --expect-fingerprint` /
 * `start --pin-tls --expect-fingerprint` need is implemented here —
 * `readPairing` and `recordTlsPin`. Keep in step with the TS version if the
 * file shape changes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function pairingPath(dataDir) {
  return join(dataDir, 'as-pairing.json');
}

export function readPairing(dataDir) {
  const path = pairingPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof data.asUrl !== 'string' || typeof data.publicKeyHex !== 'string') return null;
    return {
      asUrl: data.asUrl,
      publicKeyHex: data.publicKeyHex,
      pairedAt: data.pairedAt ?? '',
      ...(typeof data.tlsSpkiPinHex === 'string' ? { tlsSpkiPinHex: data.tlsSpkiPinHex } : {}),
    };
  } catch {
    return null;
  }
}

/** Attach/overwrite the TLS SPKI pin on the EXISTING pairing record for
 *  `asUrl`. Returns false (no-op) when there is no existing pairing for
 *  this URL to attach to — the CLI falls back to the config.json
 *  `pinTlsExpectedFingerprint` staging field in that case (see
 *  suveren-gateway.js), since a pairing record requires a `publicKeyHex`
 *  this command never has. */
export function recordTlsPin(dataDir, asUrl, tlsSpkiPinHex) {
  const existing = readPairing(dataDir);
  if (!existing || existing.asUrl !== asUrl) return false;
  const path = pairingPath(dataDir);
  writeFileSync(
    path,
    JSON.stringify({ ...existing, tlsSpkiPinHex }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  return true;
}

/** Group a hex digest into colon-separated uppercase quads — the
 *  human-readable, compare-over-the-phone form. Same convention as
 *  as-pairing.ts's `fingerprintOf` / as-tls-pin.ts's `formatPinFingerprint`,
 *  applied here to an already-computed digest (never re-hashes anything). */
export function formatFingerprint(hex) {
  const upper = hex.toUpperCase();
  return upper.match(/.{1,4}/g)?.join(':') ?? upper;
}

/**
 * Validate + normalize a candidate SHA-256 fingerprint: accepts with or
 * without colons/spaces/grouping, case-insensitive. Returns
 * `{ ok: true, hex }` (lowercase, no separators) or `{ ok: false, error }`.
 */
export function normalizeFingerprint(raw) {
  const hex = (raw ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return {
      ok: false,
      error: 'must be a 64-character SHA-256 hex digest (colons/spacing are fine), e.g. the output of `openssl dgst -sha256`.',
    };
  }
  return { ok: true, hex };
}
