/**
 * A pinned-key mismatch must turn into a REFUSED GatekeeperResult, not a
 * thrown exception that would crash the tool call path — the Gatekeeper's
 * whole job is answering "no, and here's why", never blowing up on its
 * caller. See gatekeeper.ts's try/catch around `cache.getPublicKey()`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPGatekeeper } from '../src/lib/gatekeeper';
import { AttestationCache } from '../src/lib/attestation-cache';
import { SPClient } from '../src/lib/sp-client';
import { writePairing } from '../src/lib/as-pairing';

function realEd25519PublicKeyHex(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(jwk.x!, 'base64url').toString('hex');
}

function fakeAsPubkeyServer(key: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: key }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

const future = Math.floor(Date.now() / 1000) + 3600;
const dirs: string[] = [];
let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.(); close = null;
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('MCPGatekeeper.verifyExecution — AS key mismatch', () => {
  it('returns approved:false (never throws) naming the mismatch, when the pinned key disagrees with the live one', async () => {
    const pinnedKey = realEd25519PublicKeyHex();
    const liveKey = realEd25519PublicKeyHex();
    const { url, close: c } = await fakeAsPubkeyServer(liveKey); close = c;
    const dir = mkdtempSync(join(tmpdir(), 'gatekeeper-mismatch-')); dirs.push(dir);
    writePairing(dir, url, pinnedKey);

    const spClient = new SPClient(url);
    const cache = new AttestationCache(spClient, dir);
    cache.cacheAuthorization({
      authorizationId: 'authz_1',
      profileId: 'email@0.4',
      path: 'email@0.4',
      frame: { recipient_max: 1 },
      attestations: [{ domain: 'owner', blob: 'unparseable-but-unreached', expiresAt: future }],
      requiredDomains: ['owner'],
      attestedDomains: ['owner'],
      deferredCommitmentDomains: [],
      complete: true,
    });

    const gatekeeper = new MCPGatekeeper(cache);
    // Looked up by the per-ceremony authorizationId — that's the cache's map key.
    const { result, authorization } = await gatekeeper.verifyExecution('authz_1', { recipient_max: 1 });

    expect(authorization?.authorizationId).toBe('authz_1');
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.errors[0].message).toMatch(/does not match/);
      expect(result.errors[0].code).toBe('INVALID_SIGNATURE');
    }
  });
});
