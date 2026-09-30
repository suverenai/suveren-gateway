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
    return { asUrl: data.asUrl, publicKeyHex: data.publicKeyHex, pairedAt: data.pairedAt ?? '' };
  } catch {
    return null;
  }
}

export function writePairing(dataDir: string, asUrl: string, publicKeyHex: string): Pairing {
  const pairing: Pairing = { asUrl, publicKeyHex, pairedAt: new Date().toISOString() };
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
