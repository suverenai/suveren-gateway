/**
 * Authority Server key pinning — the refusal path.
 *
 * Uses a REAL Ed25519 keypair (Node's own `crypto.generateKeyPairSync`) and a
 * real local HTTP server standing in for `GET /api/as/pubkey` — this is a
 * fake AS, acceptable at this (unit) level: what's under test is the
 * gateway's OWN comparison logic (pinned key vs. what the live endpoint
 * answers), not the Authority Server's implementation of that route. The
 * real end-to-end wire format is covered in hap-e2e.
 *
 * Central claim: once paired, a live key that disagrees with the pin must
 * refuse — never silently re-pin, never silently trust whichever key
 * answered most recently.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttestationCache, AsKeyMismatchError } from '../src/lib/attestation-cache';
import { SPClient } from '../src/lib/sp-client';
import { writePairing, readPairing, fingerprintOf } from '../src/lib/as-pairing';

/** A real Ed25519 keypair, public half as hex — the same shape `/api/as/pubkey` answers with. */
function realEd25519PublicKeyHex(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('test setup: could not extract raw Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url').toString('hex');
}

/** A fake AS that only implements GET /api/as/pubkey, answering whatever
 *  hex string the test hands it — mutable so a test can simulate the key
 *  changing between calls. */
function fakeAsPubkeyServer(getKey: () => string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/as/pubkey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicKey: getKey() }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'as-pairing-'));
let close: (() => Promise<void>) | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await close?.(); close = null;
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('AttestationCache.getPublicKey — AS key pinning', () => {
  it('unpinned (no dataDir given): trust-on-first-use, same as before pinning existed', async () => {
    const keyA = realEd25519PublicKeyHex();
    const { url, close: c } = await fakeAsPubkeyServer(() => keyA); close = c;

    const cache = new AttestationCache(new SPClient(url)); // no dataDir
    await expect(cache.getPublicKey()).resolves.toBe(keyA);
  });

  it('unpinned (dataDir given but nothing paired yet): trust-on-first-use', async () => {
    const keyA = realEd25519PublicKeyHex();
    const { url, close: c } = await fakeAsPubkeyServer(() => keyA); close = c;
    const dir = tmp(); dirs.push(dir);

    const cache = new AttestationCache(new SPClient(url), dir);
    await expect(cache.getPublicKey()).resolves.toBe(keyA);
    // Still not paired — getPublicKey() does not pin on its own; only login does.
    expect(readPairing(dir)).toBeNull();
  });

  it('pinned + matching live key: succeeds, returns the key', async () => {
    const key = realEd25519PublicKeyHex();
    const { url, close: c } = await fakeAsPubkeyServer(() => key); close = c;
    const dir = tmp(); dirs.push(dir);
    writePairing(dir, url, key);

    const cache = new AttestationCache(new SPClient(url), dir);
    await expect(cache.getPublicKey()).resolves.toBe(key);
  });

  it('REFUSAL: pinned key disagrees with the live key at the same URL — throws, never silently re-pins', async () => {
    const pinnedKey = realEd25519PublicKeyHex();
    const liveKey = realEd25519PublicKeyHex(); // a second, different real keypair
    expect(liveKey).not.toBe(pinnedKey);

    const { url, close: c } = await fakeAsPubkeyServer(() => liveKey); close = c;
    const dir = tmp(); dirs.push(dir);
    writePairing(dir, url, pinnedKey);

    const cache = new AttestationCache(new SPClient(url), dir);
    await expect(cache.getPublicKey()).rejects.toBeInstanceOf(AsKeyMismatchError);

    // Fail CLOSED, and say why: the pinned fingerprint is named in the message.
    await cache.getPublicKey().catch((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(fingerprintOf(pinnedKey));
    });

    // Never silently re-pinned to the new (live) key.
    expect(readPairing(dir)?.publicKeyHex).toBe(pinnedKey);
  });

  it('a pin recorded for a DIFFERENT AS URL is not compared — that is the AS-URL-change path, not this one', async () => {
    const keyOld = realEd25519PublicKeyHex();
    const keyNew = realEd25519PublicKeyHex();
    const { url, close: c } = await fakeAsPubkeyServer(() => keyNew); close = c;
    const dir = tmp(); dirs.push(dir);
    // Pin belongs to a different (abandoned) AS URL.
    writePairing(dir, 'https://old-as.example.com', keyOld);

    const cache = new AttestationCache(new SPClient(url), dir);
    await expect(cache.getPublicKey()).resolves.toBe(keyNew);
  });

  it('fingerprintOf is a stable, human-comparable grouped hex string', () => {
    const key = realEd25519PublicKeyHex();
    const fp = fingerprintOf(key);
    expect(fp).toMatch(/^[0-9A-F]{4}(:[0-9A-F]{4})+$/);
    expect(fingerprintOf(key)).toBe(fp); // deterministic
  });
});
