/**
 * Sign-in pairs the gateway with the Authority Server's public key (see
 * as-pairing.ts) — and a key that contradicts an EXISTING pin for the same
 * URL must refuse the sign-in outright (fail closed, and say why), rather
 * than let someone in against a server that isn't the one this gateway was
 * paired with.
 *
 * Uses a REAL local HTTP server for both AS routes this flow touches
 * (`/api/auth/session`, `/api/as/pubkey`) instead of a stubbed global fetch —
 * a fake AS is acceptable at this level (see as-pairing-pinning.test.ts in
 * the MCP server for the same convention); nothing here mocks the gateway's
 * OWN code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@hap/core';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { setInternalSecret } from '../../lib/mcp-bridge';
import { readPairing } from '../../lib/as-pairing';

interface TestKeypair {
  publicKeyHex: string;
  privateKey: KeyObject;
}

function realEd25519Keypair(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  return { publicKeyHex: Buffer.from(jwk.x!, 'base64url').toString('hex'), privateKey };
}

/** Sign a real `/api/as/challenge` response for `nonce`, using `privateKey` —
 *  the domain-separated scheme as-challenge.ts verifies (the literal prefix
 *  "hap-as-challenge\0" followed by JCS of {typ, nonce, issuedAt} — NOT the
 *  plain-JCS scheme ticket/receipt signatures use). Used by `fakeAs` below
 *  so sign-in's G2 holds-its-key check (checkAsKeyBeforeLogin →
 *  verifyAsHoldsKey) has something real to verify, not a stub of the
 *  verification itself. */
function signChallenge(nonce: string, privateKey: KeyObject): Record<string, unknown> {
  const unsigned = { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) };
  const bytes = Buffer.concat([Buffer.from('hap-as-challenge\u0000', 'utf-8'), Buffer.from(canonicalize(unsigned), 'utf-8')]);
  const signature = cryptoSign(null, bytes, privateKey).toString('base64url');
  return { ...unsigned, signature };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'auth-pairing-'));

/** A fake Authority Server implementing the three routes login touches —
 *  `/api/as/pubkey`, `/api/as/challenge` (G2 — signs with the SAME keypair
 *  `getKeypair()` currently reports, so a key change between calls produces
 *  a challenge that fails to verify under an old pin, exactly like a real
 *  key rotation would), and `/api/auth/session`. */
function fakeAs(getKeypair: () => TestKeypair): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/as/pubkey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicKey: getKeypair().publicKeyHex }));
      return;
    }
    if (req.url === '/api/as/challenge' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { nonce } = JSON.parse(raw || '{}') as { nonce?: string };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(signChallenge(nonce ?? '', getKeypair().privateKey)));
      });
      return;
    }
    if (req.url === '/api/auth/session' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 }));
      return;
    }
    // Everything else (the fire-and-forget background sweep's calls) — quiet 404.
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

function startGateway(vault: Vault, asUrl: string, dataDir: string) {
  const app = express();
  app.use(express.json());
  const noopAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const noopRateLimit = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/auth', createAuthRouter(vault, noopAuth, noopRateLimit, undefined, { asUrl, dataDir }));
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

let stopAs: (() => Promise<void>) | null = null;
let stopGw: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stopAs?.(); stopAs = null;
  await stopGw?.(); stopGw = null;
});

describe('POST /auth/login — AS key pairing', () => {
  it('pins the key on first sign-in', async () => {
    const kp = realEd25519Keypair();
    const { url: asUrl, close: c1 } = await fakeAs(() => kp); stopAs = c1;
    const dataDir = tmp();
    setInternalSecret('test-secret');

    const { url: gwUrl, close: c2 } = await startGateway(new Vault(dataDir), asUrl, dataDir); stopGw = c2;

    const res = await fetch(`${gwUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(200);
    const pairing = readPairing(dataDir);
    expect(pairing?.asUrl).toBe(asUrl);
    expect(pairing?.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it('signing in again with the SAME key is a no-op (still pinned, still succeeds)', async () => {
    const kp = realEd25519Keypair();
    const { url: asUrl, close: c1 } = await fakeAs(() => kp); stopAs = c1;
    const dataDir = tmp();
    setInternalSecret('test-secret');

    const { url: gwUrl, close: c2 } = await startGateway(new Vault(dataDir), asUrl, dataDir); stopGw = c2;

    await fetch(`${gwUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' } });
    const res2 = await fetch(`${gwUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' } });

    expect(res2.status).toBe(200);
    expect(readPairing(dataDir)?.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it('REFUSAL: a live key that disagrees with an existing pin at the SAME URL blocks sign-in (409)', async () => {
    const pinnedKp = realEd25519Keypair();
    let liveKp = pinnedKp;
    const { url: asUrl, close: c1 } = await fakeAs(() => liveKp); stopAs = c1;
    const dataDir = tmp();
    setInternalSecret('test-secret');

    const vault = new Vault(dataDir);
    const { url: gwUrl, close: c2 } = await startGateway(vault, asUrl, dataDir); stopGw = c2;

    // First sign-in pins pinnedKp's key.
    const first = await fetch(`${gwUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' } });
    expect(first.status).toBe(200);

    // The "AS" now answers (and signs its challenges) with a DIFFERENT
    // keypair at the SAME URL — e.g. a real key rotation, or an impostor.
    liveKp = realEd25519Keypair();
    expect(liveKp.publicKeyHex).not.toBe(pinnedKp.publicKeyHex);

    const second = await fetch(`${gwUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' } });
    expect(second.status).toBe(409);
    const body = await second.json() as { error?: string; message?: string };
    expect(body.error).toBe('as_key_mismatch');
    expect(body.message).toMatch(/does not match/);

    // The pin must NOT have been silently replaced.
    expect(readPairing(dataDir)?.publicKeyHex).toBe(pinnedKp.publicKeyHex);
  });

  it('REFUSAL: a pubkey fetch failure blocks sign-in — never proceeds unpinned', async () => {
    // An AS that 500s on /api/as/pubkey but still answers /api/auth/session.
    // A pubkey glitch must not be a way to bypass pinning by making just
    // that one call fail (accidentally or on purpose).
    let sessionCallReached = false;
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/as/pubkey') { res.writeHead(500); res.end(); return; }
      if (req.url === '/api/auth/session' && req.method === 'POST') {
        sessionCallReached = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const asUrl = await new Promise<string>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    stopAs = () => new Promise<void>(r => server.close(() => r()));

    const dataDir = tmp();
    setInternalSecret('test-secret');
    const { url: gwUrl, close: c2 } = await startGateway(new Vault(dataDir), asUrl, dataDir); stopGw = c2;

    const res = await fetch(`${gwUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' } });
    expect(res.status).not.toBe(200);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_unreachable');
    expect(readPairing(dataDir)).toBeNull();
    // The API key must never have been sent — the key check runs first.
    expect(sessionCallReached, 'the API key was sent to the AS before the key check refused it').toBe(false);
  });
});
