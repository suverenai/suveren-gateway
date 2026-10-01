/**
 * Authority Server key pinning + pairing record.
 *
 * At sign-in ("pairing") the gateway fetches the AS's public key
 * (`GET /api/as/pubkey`) and pins it alongside the AS URL it paired against.
 * From then on, a live key that differs from the pin means either the AS
 * rotated its key (unsupported today — re-pairing is the only accepted path,
 * see doc/self-hosted-as.md §10) or something on the network is presenting a
 * different server. Either way the gateway must fail closed rather than
 * silently trust whatever answers next.
 *
 * Plaintext on disk (`<dataDir>/as-pairing.json`) — an AS URL and a public
 * key fingerprint are not secrets; only the vault's own contents need
 * encryption.
 *
 * Mirrors `apps/control-plane/src/lib/as-pairing.ts`, which is the only
 * WRITER (the control plane owns login; the MCP server only ever reads this
 * file to enforce the pin — see attestation-cache.ts). `writePairing` is kept
 * here too, unused today, so the two files stay identical and easy to diff.
 * Keep the two in step if the file shape changes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Pairing {
  asUrl: string;
  /** Hex-encoded Ed25519 public key, exactly as `/api/as/pubkey` returns it. */
  publicKeyHex: string;
  pairedAt: string;
  /**
   * Opt-in TLS pinning (`config set pin-tls on`) — SHA-256 hex of the AS TLS
   * leaf certificate's SubjectPublicKeyInfo (SPKI), captured during the
   * challenge/sign-in exchange (control-plane's as-challenge.ts) and
   * enforced on every connection to this asUrl from then on (see
   * as-tls-pin.ts / sp-client.ts here). Absent when pin-tls is off, or when
   * it was turned on but no sign-in has captured a pin yet.
   */
  tlsSpkiPinHex?: string;
}

function pairingPath(dataDir: string): string {
  return join(dataDir, 'as-pairing.json');
}

export function readPairing(dataDir: string): Pairing | null {
  const path = pairingPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Pairing>;
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

export function writePairing(
  dataDir: string,
  asUrl: string,
  publicKeyHex: string,
  opts: { tlsSpkiPinHex?: string } = {},
): Pairing {
  const pairing: Pairing = {
    asUrl,
    publicKeyHex,
    pairedAt: new Date().toISOString(),
    ...(opts.tlsSpkiPinHex ? { tlsSpkiPinHex: opts.tlsSpkiPinHex } : {}),
  };
  const path = pairingPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(pairing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return pairing;
}

/** Idempotent — safe to call when nothing is paired yet. */
export function clearPairing(dataDir: string): void {
  const path = pairingPath(dataDir);
  try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
}

/**
 * SHA-256 of the raw key bytes, grouped uppercase hex — the form an admin can
 * read aloud over a second channel and compare against the AS admin page
 * (see doc/self-hosted-as.md §9.3, the two-channel fingerprint check).
 */
export function fingerprintOf(publicKeyHex: string): string {
  const raw = Buffer.from(publicKeyHex, 'hex');
  const digest = createHash('sha256').update(raw).digest('hex').toUpperCase();
  return digest.match(/.{1,4}/g)?.join(':') ?? digest;
}
