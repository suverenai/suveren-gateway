/**
 * AU3/AU5 — GET /proposal-status/:id/preview and GET /proposal-status/:id/outcome, over
 * real HTTP (same pattern as archived-mandates-route.test.ts). `preview`'s
 * two outbound calls (the Authority Server, then the MCP server) go through
 * the global `fetch`, stubbed here; `outcome` needs no network at all — it
 * reads the local execution journal file, like denials-reader.test.ts reads
 * denials.enc.json.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProposalStatusRouter } from '../routes/proposal-preview';
import { encryptForRecipients } from '../lib/e2e-crypto';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import { computeProposalContentHash } from '../lib/content-crypto';
import { ShownSnapshotStore } from '../lib/shown-snapshot';
import type { Vault } from '../lib/vault';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const SP_URL = 'https://as.example.test';

// Captured BEFORE any test stubs the global — `preview`'s route handler
// calls the (then-stubbed) bare `fetch` for its own AS/MCP calls, but this
// test's OWN outer call against the local express server must always hit
// the real network stack, never the stub.
const realFetch = globalThis.fetch;

/** AU10 §8.4 — a fixed test key, so `encrypt`/`decrypt` behave like the real
 *  Vault's (AES-256-GCM) without needing a real unseal. */
const TEST_VAULT_KEY = randomBytes(32);

function fakeVault(cookie: string | null, sessionUser: { id: string; did: string } | null = null, unlocked = true): Vault {
  const credentials = new Map<string, Record<string, string>>();
  return {
    getSpCookie: () => cookie,
    getSessionUser: () => sessionUser,
    getCredential: (name: string) => credentials.get(name) ?? null,
    setCredential: (name: string, fields: Record<string, string>) => { credentials.set(name, fields); },
    isUnlocked: () => unlocked,
    encrypt: (plaintext: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', TEST_VAULT_KEY, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    },
    decrypt: (blob: { iv: string; ciphertext: string; tag: string }) => {
      const decipher = createDecipheriv('aes-256-gcm', TEST_VAULT_KEY, Buffer.from(blob.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'hex')), decipher.final()]).toString('utf8');
    },
  } as unknown as Vault;
}

async function withServer(
  dataDir: string,
  cookie: string | null,
  run: (base: string) => Promise<void>,
  vaultOverride?: Vault,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/proposal-status', createProposalStatusRouter(SP_URL, vaultOverride ?? fakeVault(cookie), dataDir, () => {}, new ShownSnapshotStore(dataDir)));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/proposal-status`;
  try {
    await run(base);
  } finally {
    srv.close();
  }
}

describe('GET /proposal-status/:id/preview', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('401s with no Authority Server session — never reaches the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const dir = mkdtempSync(join(tmpdir(), 'preview-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await realFetch(`${base}/prop-1/preview`);
        expect(res.status).toBe(401);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates a proposal-fetch failure as a non-200 (contract: "always 200 unless auth/proposal fetch fails")', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('/api/proposals/prop-404');
      return new Response(JSON.stringify({ error: 'Proposal not found' }), { status: 404 });
    }));
    const dir = mkdtempSync(join(tmpdir(), 'preview-route-'));
    try {
      await withServer(dir, 'cookie', async (base) => {
        const res = await realFetch(`${base}/prop-404/preview`);
        expect(res.status).toBe(404);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relays the MCP server\'s "none" verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/proposals/')) {
        return new Response(JSON.stringify({ proposal: { tool: 'erp__create_quote', toolArgs: { value: 100 } } }), { status: 200 });
      }
      if (url.includes('/internal/preview')) {
        return new Response(JSON.stringify({ status: 'none' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const dir = mkdtempSync(join(tmpdir(), 'preview-route-'));
    try {
      await withServer(dir, 'cookie', async (base) => {
        const res = await realFetch(`${base}/prop-1/preview`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'none' });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps readAt on an "ok" result and otherwise relays it unchanged', async () => {
    const okBody = {
      status: 'ok',
      integration: 'erp',
      tool: 'get_quote',
      body: { structured: { id: 'Q1', revision: 1 } },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/proposals/')) {
        return new Response(
          JSON.stringify({ proposal: { tool: 'erp__send_quote', toolArgs: { id: 'Q1', revision: 1, value: 100 } } }),
          { status: 200 },
        );
      }
      if (url.includes('/internal/preview')) {
        return new Response(JSON.stringify(okBody), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const dir = mkdtempSync(join(tmpdir(), 'preview-route-'));
    const before = Date.now();
    try {
      await withServer(dir, 'cookie', async (base) => {
        const res = await realFetch(`${base}/prop-1/preview`);
        expect(res.status).toBe(200);
        const data = await res.json() as { readAt: number };
        expect(data).toMatchObject(okBody);
        expect(data.readAt).toBeGreaterThanOrEqual(before);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PE1: decrypts a sealed proposal (content, no toolArgs) before asking the MCP server to preview it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-route-'));
    const vault = fakeVault('cookie', { id: 'alice', did: 'did:key:zAlice' });
    const kp = await loadOrGenerateKeyPair(vault);
    const toolArgs = { id: 'Q1', revision: 1, value: 100 };
    const encrypted = await encryptForRecipients(JSON.stringify(toolArgs), [{ userId: 'alice', publicKey: kp.publicKey }]);
    const content = {
      v: 1,
      alg: 'HPKE-X25519-HKDF-SHA256-AES256GCM',
      ciphertext: Buffer.from(encrypted.intentCiphertext).toString('base64'),
      keys: { alice: { ct: Buffer.from(encrypted.encryptedKeys.alice.ct).toString('base64'), enc: Buffer.from(encrypted.encryptedKeys.alice.enc).toString('base64') } },
      hash: computeProposalContentHash(toolArgs),
    };

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/proposals/')) {
        return new Response(JSON.stringify({ proposal: { tool: 'erp__send_quote', content } }), { status: 200 });
      }
      if (url.includes('/internal/preview')) {
        // The MCP server must receive the DECRYPTED toolArgs, never the ciphertext.
        const body = JSON.parse(String(init?.body)) as { toolArgs: unknown };
        expect(body.toolArgs).toEqual(toolArgs);
        return new Response(JSON.stringify({ status: 'ok', integration: 'erp', tool: 'get_quote', body: { structured: { id: 'Q1', revision: 1 } } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    try {
      await withServer(dir, 'cookie', async (base) => {
        const res = await realFetch(`${base}/prop-1/preview`);
        expect(res.status).toBe(200);
        const data = await res.json() as { status: string };
        expect(data.status).toBe('ok');
      }, vault);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PE1: a device with no key wrap for this content answers unavailable, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-route-'));
    const vault = fakeVault('cookie', { id: 'mallory', did: 'did:key:zMallory' });
    const content = {
      v: 1,
      alg: 'HPKE-X25519-HKDF-SHA256-AES256GCM',
      ciphertext: 'YQ==',
      keys: { alice: { ct: 'YQ==', enc: 'YQ==' } }, // no wrap for "mallory"
      hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/proposals/')) {
        return new Response(JSON.stringify({ proposal: { tool: 'erp__send_quote', content } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    try {
      await withServer(dir, 'cookie', async (base) => {
        const res = await realFetch(`${base}/prop-1/preview`);
        expect(res.status).toBe(200);
        const data = await res.json() as { status: string };
        expect(data.status).toBe('unavailable');
      }, vault);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /proposal-status/:id/outcome', () => {
  it('"none" when no journal row exists for this proposal (incl. no journal file at all)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-none/outcome`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'none' });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeJournal(dir: string, entries: unknown[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'execution-journal.json'), JSON.stringify({ version: 1, entries }));
  }

  it('"intent" for a row that began but has not finished', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-route-'));
    writeJournal(dir, [{ ticketId: 't1', proposalId: 'prop-1', tool: 'x__y', argsHash: 'h', state: 'intent', startedAt: 111, pid: 1 }]);
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/outcome`);
        expect(await res.json()).toEqual({ state: 'intent', at: 111 });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"done" for a finished, successful row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-route-'));
    writeJournal(dir, [{ ticketId: 't1', proposalId: 'prop-1', tool: 'x__y', argsHash: 'h', state: 'done', startedAt: 111, finishedAt: 222, pid: 1 }]);
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/outcome`);
        expect(await res.json()).toEqual({ state: 'done', at: 222 });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"failed"/"refused" carries the stored detail text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-route-'));
    writeJournal(dir, [{
      ticketId: 't1', proposalId: 'prop-1', tool: 'erp__send_quote', argsHash: 'h',
      state: 'failed', outcome: 'refused', detail: 'Quote Q-0001 is at revision 2; this request is for revision 1.',
      startedAt: 111, finishedAt: 222, pid: 1,
    }]);
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/outcome`);
        expect(await res.json()).toEqual({
          state: 'failed',
          outcome: 'refused',
          detail: 'Quote Q-0001 is at revision 2; this request is for revision 1.',
          at: 222,
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"failed"/"changed" (AU4) carries no detail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-route-'));
    writeJournal(dir, [{
      ticketId: 't1', proposalId: 'prop-1', tool: 'erp__send_quote', argsHash: 'h',
      state: 'failed', outcome: 'changed', startedAt: 111, finishedAt: 222, pid: 1,
    }]);
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/outcome`);
        expect(await res.json()).toEqual({ state: 'failed', outcome: 'changed', at: 222 });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks the NEWEST row when a proposal has more than one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-route-'));
    writeJournal(dir, [
      { ticketId: 't1', proposalId: 'prop-1', tool: 'x__y', argsHash: 'h', state: 'failed', outcome: 'refused', startedAt: 100, finishedAt: 101, pid: 1 },
      { ticketId: 't2', proposalId: 'prop-1', tool: 'x__y', argsHash: 'h', state: 'done', startedAt: 200, finishedAt: 201, pid: 1 },
    ]);
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/outcome`);
        expect(await res.json()).toEqual({ state: 'done', at: 201 });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST + GET /proposal-status/:id/shown-snapshot (AU10 §8.4)', () => {
  const sampleSnapshot = {
    readAt: 1_760_000_000_000,
    preview: { status: 'none' as const },
    requestContext: { request: { status: 'none' as const }, history: { status: 'no_customer_link' as const } },
  };

  it('POST stores the snapshot and returns its hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/shown-snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sampleSnapshot),
        });
        expect(res.status).toBe(200);
        const { shownHash } = await res.json() as { shownHash: string };
        expect(shownHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET returns the stored snapshot, its hash, and verifiedLocally: true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const postRes = await fetch(`${base}/prop-1/shown-snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sampleSnapshot),
        });
        const { shownHash } = await postRes.json() as { shownHash: string };

        const getRes = await fetch(`${base}/prop-1/shown-snapshot`);
        expect(getRes.status).toBe(200);
        const body = await getRes.json() as { storedAt: number };
        expect(body).toEqual({
          status: 'ok',
          snapshot: sampleSnapshot,
          shownHash,
          storedAt: body.storedAt,
          verifiedLocally: true,
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET returns off_device for a proposal never saved on this gateway', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/never-saved/shown-snapshot`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'off_device' });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST 401s when the vault is locked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/shown-snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sampleSnapshot),
        });
        expect(res.status).toBe(401);
      }, fakeVault(null, null, false));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET 401s when the vault is locked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/shown-snapshot`);
        expect(res.status).toBe(401);
      }, fakeVault(null, null, false));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST 400s on a non-object body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        const res = await fetch(`${base}/prop-1/shown-snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify('not an object'),
        });
        expect(res.status).toBe(400);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two different proposals get independent snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-route-'));
    try {
      await withServer(dir, null, async (base) => {
        await fetch(`${base}/prop-a/shown-snapshot`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sampleSnapshot, readAt: 1 }),
        });
        await fetch(`${base}/prop-b/shown-snapshot`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sampleSnapshot, readAt: 2 }),
        });
        const a = await (await fetch(`${base}/prop-a/shown-snapshot`)).json() as { snapshot: { readAt: number }; shownHash: string };
        const b = await (await fetch(`${base}/prop-b/shown-snapshot`)).json() as { snapshot: { readAt: number }; shownHash: string };
        expect(a.snapshot.readAt).toBe(1);
        expect(b.snapshot.readAt).toBe(2);
        expect(a.shownHash).not.toBe(b.shownHash);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
