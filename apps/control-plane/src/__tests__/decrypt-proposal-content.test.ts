/**
 * POST /api/decrypt-proposal-content — the UI-facing (session-authenticated)
 * route approval cards, the AU3 preview and "Edit before signing" use to
 * decrypt sealed proposal content/notes (PE1 brief).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createDecryptProposalContentRouter } from '../routes/decrypt-proposal-content';
import { encryptForRecipients } from '../lib/e2e-crypto';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';

function makeFakeVault(sessionUser: { id: string; did: string } | null): Vault {
  const credentials = new Map<string, Record<string, string>>();
  return {
    getSessionUser: () => sessionUser,
    getCredential: (name: string) => credentials.get(name) ?? null,
    setCredential: (name: string, fields: Record<string, string>) => { credentials.set(name, fields); },
  } as unknown as Vault;
}

function startServer(vault: Vault): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/decrypt-proposal-content', express.json(), createDecryptProposalContentRouter(vault));
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
  return fetch(`${url}/api/decrypt-proposal-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/decrypt-proposal-content', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; });

  it('decrypts the caller\'s own wrap into plaintext', async () => {
    const vault = makeFakeVault({ id: 'alice', did: 'did:key:zAlice' });
    const kp = await loadOrGenerateKeyPair(vault);
    const encrypted = await encryptForRecipients('{"to":"x@example.com"}', [{ userId: 'alice', publicKey: kp.publicKey }]);
    const keys = { alice: { ct: Buffer.from(encrypted.encryptedKeys.alice.ct).toString('base64'), enc: Buffer.from(encrypted.encryptedKeys.alice.enc).toString('base64') } };
    const ciphertext = Buffer.from(encrypted.intentCiphertext).toString('base64');

    const { url, close } = await startServer(vault);
    stop = close;
    const res = await post(url, { ciphertext, keys });
    expect(res.status).toBe(200);
    const { plaintext } = await res.json() as { plaintext: string };
    expect(plaintext).toBe('{"to":"x@example.com"}');
  });

  it('401s with no session', async () => {
    const { url, close } = await startServer(makeFakeVault(null));
    stop = close;
    const res = await post(url, { ciphertext: 'YQ==', keys: {} });
    expect(res.status).toBe(401);
  });

  it('400s on a missing ciphertext', async () => {
    const { url, close } = await startServer(makeFakeVault({ id: 'alice', did: 'did:key:zAlice' }));
    stop = close;
    const res = await post(url, { keys: {} });
    expect(res.status).toBe(400);
  });

  it('403s (not 500) when the caller has no key wrap in this content', async () => {
    const vault = makeFakeVault({ id: 'mallory', did: 'did:key:zMallory' });
    await loadOrGenerateKeyPair(vault);
    const kpAlice = await import('../lib/e2e-crypto').then((m) => m.generateKeyPair());
    const encrypted = await encryptForRecipients('secret', [{ userId: 'alice', publicKey: kpAlice.publicKey }]);
    const ciphertext = Buffer.from(encrypted.intentCiphertext).toString('base64');
    const keys = { alice: { ct: Buffer.from(encrypted.encryptedKeys.alice.ct).toString('base64'), enc: Buffer.from(encrypted.encryptedKeys.alice.enc).toString('base64') } };

    const { url, close } = await startServer(vault);
    stop = close;
    const res = await post(url, { ciphertext, keys });
    expect(res.status).toBe(403);
  });
});
