/**
 * as-pairing.ts round-trip — the pairing record (AS URL + pinned key) that
 * login (auth.ts) writes and the boot-time re-pair check (index.ts) reads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPairing, writePairing, clearPairing, fingerprintOf } from '../lib/as-pairing';

function realEd25519PublicKeyHex(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(jwk.x!, 'base64url').toString('hex');
}

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'as-pairing-cp-')); dirs.push(d); return d; };

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('readPairing / writePairing / clearPairing', () => {
  it('returns null when nothing is paired', () => {
    expect(readPairing(tmp())).toBeNull();
  });

  it('round-trips asUrl + publicKeyHex, and stamps pairedAt', () => {
    const dir = tmp();
    const key = realEd25519PublicKeyHex();
    const before = Date.now();
    writePairing(dir, 'https://as.example.com', key);
    const pairing = readPairing(dir);
    expect(pairing?.asUrl).toBe('https://as.example.com');
    expect(pairing?.publicKeyHex).toBe(key);
    expect(new Date(pairing!.pairedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('is plaintext on disk (not secret) — same trust level as the rest of config.json', () => {
    const dir = tmp();
    const key = realEd25519PublicKeyHex();
    writePairing(dir, 'https://as.example.com', key);
    const raw = readFileSync(join(dir, 'as-pairing.json'), 'utf-8');
    expect(raw).toContain('https://as.example.com');
    expect(raw).toContain(key);
  });

  it('clearPairing removes the file and is idempotent', () => {
    const dir = tmp();
    writePairing(dir, 'https://as.example.com', realEd25519PublicKeyHex());
    expect(existsSync(join(dir, 'as-pairing.json'))).toBe(true);

    clearPairing(dir);
    expect(existsSync(join(dir, 'as-pairing.json'))).toBe(false);
    expect(readPairing(dir)).toBeNull();

    expect(() => clearPairing(dir)).not.toThrow(); // idempotent — already gone
  });

  it('tolerates a corrupt file (degrades to null, never throws)', () => {
    const dir = tmp();
    writePairing(dir, 'https://as.example.com', realEd25519PublicKeyHex());
    // Hand-corrupt.
    const path = join(dir, 'as-pairing.json');
    writeFileSync(path, '{ not json', 'utf-8');
    expect(readPairing(dir)).toBeNull();
  });
});

describe('fingerprintOf', () => {
  it('is a deterministic, grouped, uppercase hex string', () => {
    const key = realEd25519PublicKeyHex();
    const fp = fingerprintOf(key);
    expect(fp).toMatch(/^[0-9A-F]{4}(:[0-9A-F]{4})+$/);
    expect(fingerprintOf(key)).toBe(fp);
  });

  it('differs for different keys', () => {
    const a = fingerprintOf(realEd25519PublicKeyHex());
    const b = fingerprintOf(realEd25519PublicKeyHex());
    expect(a).not.toBe(b);
  });
});
