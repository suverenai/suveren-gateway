/**
 * verifyAsHoldsKey (G2) — direct unit tests, using a REAL Ed25519 keypair
 * and a REAL local HTTP server standing in for the Authority Server's
 * `/api/as/challenge` endpoint (acceptable at this unit level — the real
 * end-to-end wire format is covered in hap-e2e). Integration coverage of
 * the same checks wired into sign-in (checkAsKeyBeforeLogin) lives in
 * routes/__tests__/auth-challenge.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { canonicalize } from '@hap/core';
import { verifyAsHoldsKey, AsChallengeUnreachableError, AsChallengeInvalidError } from '../lib/as-challenge';

function realEd25519Keypair(): { publicKeyHex: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  return { publicKeyHex: Buffer.from(jwk.x!, 'base64url').toString('hex'), privateKey };
}

type Responder = (nonce: string) => { status: number; body: unknown } | null;

/** A fake AS implementing only POST /api/as/challenge. `null` from
 *  `respond` means "no route at all" (404). */
function fakeChallengeServer(respond: Responder): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/as/challenge' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { nonce } = JSON.parse(raw || '{}') as { nonce?: string };
        const answer = respond(nonce ?? '');
        if (!answer) { res.writeHead(404); res.end(); return; }
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function sign(unsigned: Record<string, unknown>, privateKey: KeyObject): string {
  return cryptoSign(null, Buffer.from(canonicalize(unsigned), 'utf-8'), privateKey).toString('base64url');
}

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.(); stop = null;
});

describe('verifyAsHoldsKey', () => {
  it('resolves for a fresh, correctly-signed challenge', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((nonce) => {
      const unsigned = { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) };
      return { status: 200, body: { ...unsigned, signature: sign(unsigned, kp.privateKey) } };
    });
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).resolves.toBeUndefined();
  });

  it('rejects when the response echoes a different nonce than the one sent', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((_nonce) => {
      const unsigned = { typ: 'hap-as-challenge', nonce: 'wrong-nonce', issuedAt: Math.floor(Date.now() / 1000) };
      return { status: 200, body: { ...unsigned, signature: sign(unsigned, kp.privateKey) } };
    });
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeInvalidError);
  });

  it('rejects a stale issuedAt (beyond the skew tolerance)', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((nonce) => {
      const unsigned = { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) - 600 };
      return { status: 200, body: { ...unsigned, signature: sign(unsigned, kp.privateKey) } };
    });
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeInvalidError);
  });

  it('rejects an issuedAt implausibly far in the future', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((nonce) => {
      const unsigned = { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) + 600 };
      return { status: 200, body: { ...unsigned, signature: sign(unsigned, kp.privateKey) } };
    });
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeInvalidError);
  });

  it('rejects a signature made by a DIFFERENT key than the one being checked', async () => {
    const kp = realEd25519Keypair();
    const otherKp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((nonce) => {
      const unsigned = { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) };
      return { status: 200, body: { ...unsigned, signature: sign(unsigned, otherKp.privateKey) } };
    });
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeInvalidError);
  });

  it('rejects a response with the wrong typ', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((nonce) => {
      const unsigned = { typ: 'not-a-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) };
      return { status: 200, body: { ...unsigned, signature: sign(unsigned, kp.privateKey) } };
    });
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeInvalidError);
  });

  it('rejects a response with no signature at all', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer((nonce) => ({
      status: 200,
      body: { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000) },
    }));
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeInvalidError);
  });

  it('rejects when the route does not exist at all (404)', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer(() => null);
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeUnreachableError);
  });

  it('rejects on a 5xx from the challenge endpoint', async () => {
    const kp = realEd25519Keypair();
    const { url, close } = await fakeChallengeServer(() => ({ status: 500, body: { error: 'boom' } }));
    stop = close;
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeUnreachableError);
  });

  it('rejects on a network error (nothing listening)', async () => {
    const kp = realEd25519Keypair();
    // Nothing listens on this port — a closed-connection, not a 404.
    await expect(verifyAsHoldsKey('http://127.0.0.1:1', kp.publicKeyHex))
      .rejects.toBeInstanceOf(AsChallengeUnreachableError);
  });

  it('rejects a malformed (non-JSON) response body', async () => {
    const kp = realEd25519Keypair();
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    stop = () => new Promise<void>((r) => server.close(() => r()));
    await expect(verifyAsHoldsKey(url, kp.publicKeyHex)).rejects.toBeInstanceOf(AsChallengeUnreachableError);
  });
});
