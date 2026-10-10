/**
 * AU3/AU5 — GET /proposals/:id/preview and GET /proposals/:id/outcome, over
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
import type { Vault } from '../lib/vault';

const SP_URL = 'https://as.example.test';

// Captured BEFORE any test stubs the global — `preview`'s route handler
// calls the (then-stubbed) bare `fetch` for its own AS/MCP calls, but this
// test's OWN outer call against the local express server must always hit
// the real network stack, never the stub.
const realFetch = globalThis.fetch;

function fakeVault(cookie: string | null): Vault {
  return { getSpCookie: () => cookie } as unknown as Vault;
}

async function withServer(
  dataDir: string,
  cookie: string | null,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/proposals', createProposalStatusRouter(SP_URL, fakeVault(cookie), dataDir, () => {}));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/proposals`;
  try {
    await run(base);
  } finally {
    srv.close();
  }
}

describe('GET /proposals/:id/preview', () => {
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
});

describe('GET /proposals/:id/outcome', () => {
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
