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
 * Mirrors `apps/mcp-server/src/lib/as-pairing.ts`, which only reads this file
 * (the MCP server never logs in — the control plane does, and is the only
 * writer). Keep the two in step if the file shape changes.
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
   * challenge/sign-in exchange (see as-challenge.ts / as-tls-pin.ts) and
   * enforced on every connection to this asUrl from then on. Absent when
   * pin-tls is off, or when it was turned on but no sign-in has captured a
   * pin yet. Renewing a certificate with the SAME key keeps this pin valid
   * (SPKI is the key, not the certificate); a NEW key needs re-pairing —
   * same replacement rule as `publicKeyHex`.
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

/**
 * Attach/REFRESH the captured TLS SPKI pin on the EXISTING pairing record
 * for `asUrl`, without touching the signing-key pin or `pairedAt`. Called
 * after every verified sign-in challenge that captured one — see
 * as-challenge.ts / as-tls-pin.ts's module doc comment: capture happens at
 * EVERY pairing, pin-tls on or off, so this always overwrites rather than
 * only filling a gap. (The caller — auth.ts's checkAsKeyBeforeLogin — is
 * what enforces "never silently replace an ENFORCED pin": when pin-tls is
 * on and a pin already existed, a mismatch is refused before this is ever
 * reached, so by the time this runs under enforcement the value passed in
 * is unchanged anyway.) A no-op when there is no existing pairing for this
 * URL to attach to.
 */
export function recordTlsPin(dataDir: string, asUrl: string, tlsSpkiPinHex: string): void {
  const existing = readPairing(dataDir);
  if (!existing || existing.asUrl !== asUrl) return;
  const path = pairingPath(dataDir);
  writeFileSync(
    path,
    JSON.stringify({ ...existing, tlsSpkiPinHex }, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
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
