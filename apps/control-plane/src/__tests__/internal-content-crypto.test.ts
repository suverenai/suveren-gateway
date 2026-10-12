/**
 * POST /internal/encrypt-content, POST /internal/decrypt-content — the
 * secret-guarded routes the MCP server uses to seal/open proposal content
 * (PE1 brief). Same harness style as internal-events.test.ts: a real express
 * server on an ephemeral port, real fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createInternalContentCryptoRouter } from '../routes/internal-content-crypto';
import { generateKeyPair } from '../lib/e2e-crypto';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';

const SECRET = 'test-internal-secret-0123456789';

const fetchAsMock = vi.fn();
vi.mock('../lib/as-tls-pin', () => ({
  fetchAs: (...args: unknown[]) => fetchAsMock(...args),
}));
vi.mock('../lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../lib/as-config', () => ({ resolvePinTls: () => false }));

function jsonResponse(status: number, body: unknown) {
  return { res: { ok: status >= 200 && status < 300, status, json: async () => body } };
}

/** A minimal Vault fake — only the surface loadOrGenerateKeyPair + these routes touch. */
function makeFakeVault(opts: { sessionUser?: { id: string; did: string } | null; cookie?: string | null } = {}): Vault {
  const credentials = new Map<string, Record<string, string>>();
  const sessionUser = 'sessionUser' in opts ? opts.sessionUser : { id: 'self', did: 'did:key:z6Mkself' };
  return {
    getSessionUser: () => sessionUser,
    getSpCookie: () => opts.cookie ?? 'sid=1',
    getCredential: (name: string) => credentials.get(name) ?? null,
    setCredential: (name: string, fields: Record<string, string>) => { credentials.set(name, fields); },
  } as unknown as Vault;
}

function startServer(vault: Vault, spUrl = 'https://as.example', dataDir = '/tmp/suveren-test'): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/internal', express.json(), createInternalContentCryptoRouter(() => SECRET, vault, spUrl, dataDir));
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function post(url: string, path: string, body: unknown, secret?: string) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Internal-Secret': secret } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/encrypt-content, /internal/decrypt-content', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; fetchAsMock.mockReset(); });

  it('401s without the shared secret', async () => {
    const { url, close } = await startServer(makeFakeVault());
    stop = close;
    const res = await post(url, '/internal/encrypt-content', { toolArgs: { x: 1 }, recipientUserIds: [] });
    expect(res.status).toBe(401);
  });

  it('encrypts for self + recipients, and the MCP server\'s own round trip (encrypt then decrypt) matches the original toolArgs', async () => {
    const selfVault = makeFakeVault({ sessionUser: { id: 'self', did: 'did:key:zSelf' } });
    // The AS always answers GET /users/self/pubkey with what THIS gateway
    // itself registered — i.e. loadOrGenerateKeyPair(selfVault)'s own public
    // key, not an arbitrary one, so decrypt-content (which loads the SAME
    // vault's key pair) can actually open its own seal.
    const kpSelf = await loadOrGenerateKeyPair(selfVault);
    const kpOwner = await generateKeyPair();
    fetchAsMock.mockImplementation((reqUrl: string) => {
      if (reqUrl.includes('/users/self/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpSelf.publicKey).toString('base64') }));
      if (reqUrl.includes('/users/owner/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpOwner.publicKey).toString('base64') }));
      return Promise.resolve(jsonResponse(404, {}));
    });

    const { url, close } = await startServer(selfVault);
    stop = close;

    const toolArgs = { to: 'customer@example.com', amount: 42 };
    const encRes = await post(url, '/internal/encrypt-content', { toolArgs, recipientUserIds: ['owner'] }, SECRET);
    expect(encRes.status).toBe(200);
    const { content, unreadableFor } = await encRes.json() as { content: { v: 1; alg: string; ciphertext: string; keys: Record<string, { ct: string; enc: string }>; hash: string }; unreadableFor: string[] };
    expect(unreadableFor).toEqual([]);
    expect(Object.keys(content.keys).sort()).toEqual(['owner', 'self']);

    // Decrypt as "self" through the SAME route (a second server instance using
    // self's own vault, mirroring the committed executor reading its own content).
    const decRes = await post(url, '/internal/decrypt-content', { ciphertext: content.ciphertext, keys: content.keys }, SECRET);
    expect(decRes.status).toBe(200);
    const { plaintext } = await decRes.json() as { plaintext: string };
    expect(JSON.parse(plaintext)).toEqual(toolArgs);
  });

  it('decrypt-content 401s when the vault has no session user', async () => {
    const { url, close } = await startServer(makeFakeVault({ sessionUser: null }));
    stop = close;
    const res = await post(url, '/internal/decrypt-content', { ciphertext: 'YQ==', keys: {} }, SECRET);
    expect(res.status).toBe(401);
  });

  it('encrypt-content 400s on a non-object toolArgs', async () => {
    const { url, close } = await startServer(makeFakeVault());
    stop = close;
    const res = await post(url, '/internal/encrypt-content', { toolArgs: 'nope', recipientUserIds: [] }, SECRET);
    expect(res.status).toBe(400);
  });

  it('encrypt-content 400s past the 50-recipient cap', async () => {
    const { url, close } = await startServer(makeFakeVault());
    stop = close;
    const recipientUserIds = Array.from({ length: 51 }, (_, i) => `u${i}`);
    const res = await post(url, '/internal/encrypt-content', { toolArgs: { x: 1 }, recipientUserIds }, SECRET);
    expect(res.status).toBe(400);
  });
});
