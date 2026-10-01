/**
 * G2 — sign-in must verify the Authority Server HOLDS its signing key (a
 * challenge-response proof) before the API key is sent anywhere, not just
 * that it can answer a plain GET with a public key.
 *
 * Uses REAL local HTTP servers standing in for the AS (unit level — the real
 * end-to-end wire format is covered in hap-e2e) and REAL Ed25519 keypairs, so
 * what's exercised is the gateway's OWN verification logic, not a stub of
 * it — same convention as auth-pairing.test.ts.
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

function signedChallengeBody(
  unsigned: { typ?: string; nonce?: string; issuedAt?: number },
  privateKey: KeyObject,
): Record<string, unknown> {
  const signature = cryptoSign(null, Buffer.from(canonicalize(unsigned), 'utf-8'), privateKey).toString('base64url');
  return { ...unsigned, signature };
}

interface FakeAsOptions {
  pubkeyHex: string;
  /** Build the challenge response body given the nonce the gateway sent.
   *  `undefined` means "no challenge route at all" (404) — the "relay
   *  forwards /api/as/pubkey but has nothing behind /api/as/challenge" shape. */
  challenge?: (nonce: string) => Record<string, unknown>;
  challengeStatus?: number;
}

/** @param getOpts Read live, on every request — lets a test change what the
 *  "AS" reports/signs between two logins against the SAME url+port (needed
 *  for the pin-mismatch case: the pin only applies when the URL is unchanged). */
function fakeAs(getOpts: () => FakeAsOptions): Promise<{
  url: string;
  close: () => Promise<void>;
  sessionCalls: Array<{ apiKey: string | undefined }>;
}> {
  const sessionCalls: Array<{ apiKey: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    const opts = getOpts();
    if (req.url === '/api/as/pubkey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicKey: opts.pubkeyHex }));
      return;
    }
    if (req.url === '/api/as/challenge' && req.method === 'POST') {
      if (!opts.challenge) {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { nonce } = JSON.parse(raw || '{}') as { nonce?: string };
        res.writeHead(opts.challengeStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(opts.challenge!(nonce ?? '')));
      });
      return;
    }
    if (req.url === '/api/auth/session' && req.method === 'POST') {
      sessionCalls.push({ apiKey: req.headers['x-api-key'] as string | undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        sessionCalls,
      });
    });
  });
}

function startGateway(vault: Vault, asUrl: string, dataDir: string) {
  const app = express();
  app.use(express.json());
  const noopAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const noopRateLimit = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/auth', createAuthRouter(vault, noopAuth, noopRateLimit, undefined, { asUrl, dataDir }));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'auth-challenge-'));

let stopAs: (() => Promise<void>) | null = null;
let stopGw: (() => Promise<void>) | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await stopAs?.(); stopAs = null;
  await stopGw?.(); stopGw = null;
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function login(gwUrl: string): Promise<Response> {
  return fetch(`${gwUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
  });
}

describe('POST /auth/login — Authority Server holds-its-key challenge (G2)', () => {
  it('valid challenge: sign-in proceeds, pins the key, and the API key is sent only after', async () => {
    const kp = realEd25519Keypair();
    const as = await fakeAs(() => ({
      pubkeyHex: kp.publicKeyHex,
      challenge: (nonce) => signedChallengeBody({ typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) }, kp.privateKey),
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(200);
    expect(as.sessionCalls).toHaveLength(1);
    expect(as.sessionCalls[0].apiKey).toBe('hap_test');
    expect(readPairing(dataDir)?.publicKeyHex).toBe(kp.publicKeyHex);
  });

  it('REFUSAL: wrong nonce echoed back — refused (502 as_unverified), API key never sent, nothing pinned', async () => {
    const kp = realEd25519Keypair();
    const as = await fakeAs(() => ({
      pubkeyHex: kp.publicKeyHex,
      challenge: (_nonce) =>
        signedChallengeBody({ typ: 'hap-as-challenge', nonce: 'not-the-nonce-that-was-sent', issuedAt: Math.floor(Date.now() / 1000) }, kp.privateKey),
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(502);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_unverified');
    expect(as.sessionCalls, 'the API key must never reach the AS when the challenge fails').toHaveLength(0);
    expect(readPairing(dataDir)).toBeNull();
  });

  it('REFUSAL: stale issuedAt — refused (502 as_unverified), API key never sent', async () => {
    const kp = realEd25519Keypair();
    const as = await fakeAs(() => ({
      pubkeyHex: kp.publicKeyHex,
      challenge: (nonce) =>
        signedChallengeBody({ typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) - 600 }, kp.privateKey),
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(502);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_unverified');
    expect(as.sessionCalls).toHaveLength(0);
    expect(readPairing(dataDir)).toBeNull();
  });

  it('REFUSAL: challenge signed by a DIFFERENT key than the one reported at /api/as/pubkey — refused, API key never sent', async () => {
    // Models a relay that forwards the genuine AS's /api/as/pubkey answer
    // (a cheap, non-secret read) but cannot produce a valid signature under
    // that key — either because it has no challenge route at all (next test)
    // or, as here, because it tries anyway with a key it actually holds.
    const claimed = realEd25519Keypair();
    const actualSigner = realEd25519Keypair();
    const as = await fakeAs(() => ({
      pubkeyHex: claimed.publicKeyHex,
      challenge: (nonce) =>
        signedChallengeBody({ typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) }, actualSigner.privateKey),
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(502);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_unverified');
    expect(as.sessionCalls).toHaveLength(0);
    expect(readPairing(dataDir)).toBeNull();
  });

  it('REFUSAL: a relay that forwards /api/as/pubkey but has no /api/as/challenge route at all — refused, API key never sent', async () => {
    const kp = realEd25519Keypair();
    const as = await fakeAs(() => ({ pubkeyHex: kp.publicKeyHex })); // no `challenge` → 404
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(502);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_unverified');
    expect(as.sessionCalls).toHaveLength(0);
    expect(readPairing(dataDir)).toBeNull();
  });

  it('REFUSAL: a 5xx from the challenge endpoint — refused fail-closed, API key never sent', async () => {
    const kp = realEd25519Keypair();
    const as = await fakeAs(() => ({
      pubkeyHex: kp.publicKeyHex,
      challenge: (nonce) => signedChallengeBody({ typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) }, kp.privateKey),
      challengeStatus: 500,
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(502);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('as_unverified');
    expect(as.sessionCalls).toHaveLength(0);
    expect(readPairing(dataDir)).toBeNull();
  });

  it('REFUSAL: wrong typ in the challenge response — refused, API key never sent', async () => {
    const kp = realEd25519Keypair();
    const as = await fakeAs(() => ({
      pubkeyHex: kp.publicKeyHex,
      challenge: (nonce) =>
        signedChallengeBody({ typ: 'something-else', nonce, issuedAt: Math.floor(Date.now() / 1000) }, kp.privateKey),
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    const res = await login(gw.url);

    expect(res.status).toBe(502);
    expect(as.sessionCalls).toHaveLength(0);
    expect(readPairing(dataDir)).toBeNull();
  });

  it('REFUSAL: an existing pin whose live AS fails the challenge is refused with 409, never re-pinned', async () => {
    // One server at ONE url for the whole test — the pin only applies when
    // the URL is unchanged, so this must be a single fakeAs instance whose
    // reported pubkey/signer can change between the two logins, not two
    // servers on different ports.
    const pinnedKp = realEd25519Keypair();
    let signer = pinnedKp;
    const as = await fakeAs(() => ({
      pubkeyHex: pinnedKp.publicKeyHex,
      challenge: (nonce) => signedChallengeBody({ typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) }, signer.privateKey),
    }));
    stopAs = as.close;
    const dataDir = tmp(); dirs.push(dataDir);
    setInternalSecret('test-secret');
    const gw = await startGateway(new Vault(dataDir), as.url, dataDir);
    stopGw = gw.close;

    // First pairing with a genuine, challenge-proving AS…
    const first = await login(gw.url);
    expect(first.status).toBe(200);
    expect(readPairing(dataDir)?.publicKeyHex).toBe(pinnedKp.publicKeyHex);
    const sessionCallsAfterFirstLogin = as.sessionCalls.length;

    // …then the SAME URL is later fronted by something that still reports
    // the pinned key at /api/as/pubkey (irrelevant now — the pin is used,
    // not a live fetch) but signs the challenge with a DIFFERENT key —
    // exactly what an impostor (or an un-pre-authorized key rotation) would
    // produce: it cannot actually sign under the key everyone still expects.
    signer = realEd25519Keypair();

    const second = await login(gw.url);
    expect(second.status).toBe(409);
    const body = await second.json() as { error?: string };
    expect(body.error).toBe('as_key_mismatch');
    // No NEW /api/auth/session call from this second, refused attempt.
    expect(as.sessionCalls).toHaveLength(sessionCallsAfterFirstLogin);
    expect(readPairing(dataDir)?.publicKeyHex).toBe(pinnedKp.publicKeyHex);
  });
});
