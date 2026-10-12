/**
 * POST /api/encrypt-proposal-note — G5 (PE1 brief): the deciding gateway
 * encrypts a "change needed" note for the submitter + mandate owner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createEncryptProposalNoteRouter } from '../routes/encrypt-proposal-note';
import { generateKeyPair, decryptIntent } from '../lib/e2e-crypto';
import type { Vault } from '../lib/vault';

const fetchAsMock = vi.fn();
vi.mock('../lib/as-tls-pin', () => ({
  fetchAs: (...args: unknown[]) => fetchAsMock(...args),
}));
vi.mock('../lib/as-pairing', () => ({ readPairing: () => null }));
vi.mock('../lib/as-config', () => ({ resolvePinTls: () => false }));

function jsonResponse(status: number, body: unknown) {
  return { res: { ok: status >= 200 && status < 300, status, json: async () => body } };
}

function makeFakeVault(opts: { sessionUser?: { id: string; did: string } | null; cookie?: string | null } = {}): Vault {
  const sessionUser = 'sessionUser' in opts ? opts.sessionUser : { id: 'decider', did: 'did:key:zDecider' };
  return {
    getSessionUser: () => sessionUser,
    getSpCookie: () => opts.cookie ?? 'sid=1',
  } as unknown as Vault;
}

function startServer(vault: Vault): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/encrypt-proposal-note', express.json(), createEncryptProposalNoteRouter(vault, 'https://as.example', '/tmp/suveren-test'));
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

async function post(url: string, body: unknown) {
  return fetch(`${url}/api/encrypt-proposal-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/encrypt-proposal-note', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; fetchAsMock.mockReset(); });

  it('encrypts the note for the decider + the owner; the owner can decrypt it', async () => {
    const [kpDecider, kpOwner] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    fetchAsMock.mockImplementation((reqUrl: string) => {
      if (reqUrl.includes('/users/decider/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpDecider.publicKey).toString('base64') }));
      if (reqUrl.includes('/users/owner/pubkey')) return Promise.resolve(jsonResponse(200, { pubkey: Buffer.from(kpOwner.publicKey).toString('base64') }));
      return Promise.resolve(jsonResponse(404, {}));
    });

    const { url, close } = await startServer(makeFakeVault());
    stop = close;
    const res = await post(url, { note: 'Please use the smaller logo.', recipientUserIds: ['owner'] });
    expect(res.status).toBe(200);
    const { noteEncrypted, unreadableFor } = await res.json() as { noteEncrypted: { ciphertext: string; keys: Record<string, { ct: string; enc: string }> }; unreadableFor: string[] };
    expect(unreadableFor).toEqual([]);

    const decrypted = await decryptIntent(
      {
        intentCiphertext: new Uint8Array(Buffer.from(noteEncrypted.ciphertext, 'base64')),
        encryptedKeys: {
          owner: {
            ct: new Uint8Array(Buffer.from(noteEncrypted.keys.owner.ct, 'base64')),
            enc: new Uint8Array(Buffer.from(noteEncrypted.keys.owner.enc, 'base64')),
          },
        },
      },
      'owner',
      kpOwner.privateKey,
    );
    expect(decrypted).toBe('Please use the smaller logo.');
  });

  it('400s on an empty note', async () => {
    const { url, close } = await startServer(makeFakeVault());
    stop = close;
    const res = await post(url, { note: '', recipientUserIds: [] });
    expect(res.status).toBe(400);
  });

  it('400s on a note over 500 characters (the gateway enforces the bound the AS cannot see)', async () => {
    const { url, close } = await startServer(makeFakeVault());
    stop = close;
    const res = await post(url, { note: 'x'.repeat(501), recipientUserIds: [] });
    expect(res.status).toBe(400);
  });

  it('401s with no Authority Server session', async () => {
    const { url, close } = await startServer(makeFakeVault({ sessionUser: null }));
    stop = close;
    const res = await post(url, { note: 'ok', recipientUserIds: [] });
    expect(res.status).toBe(401);
  });
});
