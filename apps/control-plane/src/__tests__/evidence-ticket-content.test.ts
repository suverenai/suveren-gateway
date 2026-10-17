/**
 * UI spec §14 — GET /api/evidence/receipt/:id carries `sentArgsCheck` and
 * `result` from the MCP server, and GET /api/evidence/headlines passes the
 * automatic tickets' headline values through. Real HTTP against the router;
 * the MCP server's internal endpoints are a stubbed global fetch (same
 * pattern as proposal-preview-route.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createEvidenceRouter } from '../routes/evidence';

const realFetch = globalThis.fetch;

const ENTRY = {
  archivedAt: 1,
  authorizationId: 'authz_1',
  asUrl: 'https://as.test',
  receipt: { id: 't-1' },
  sentArgs: { amount: '0.10' },
};

function stubMcp(ticket: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/internal/evidence')) {
      return new Response(JSON.stringify({ receipts: [ENTRY], authorizations: [], gates: [] }), { status: 200 });
    }
    if (url.endsWith('/internal/evidence/headlines')) {
      return new Response(JSON.stringify({ headlines: { 't-1': { amount: '0.10' } } }), { status: 200 });
    }
    if (url.includes('/internal/evidence/ticket/')) return ticket(url);
    return new Response('not stubbed', { status: 500 });
  }));
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use('/api/evidence', createEvidenceRouter());
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await realFetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GET /api/evidence/receipt/:id — §14 fields', () => {
  it('carries the MCP server\'s args check and the kept result next to the entry', async () => {
    stubMcp(() => new Response(JSON.stringify({ sentArgsCheck: 'match', result: { ok: true, text: '{"id":"pl_1"}' } }), { status: 200 }));
    const { status, body } = await get('/api/evidence/receipt/t-1');
    expect(status).toBe(200);
    expect((body.entry as { sentArgs: unknown }).sentArgs).toEqual({ amount: '0.10' });
    expect(body.sentArgsCheck).toBe('match');
    expect(body.result).toEqual({ ok: true, text: '{"id":"pl_1"}' });
  });

  it('passes a mismatch through unchanged', async () => {
    stubMcp(() => new Response(JSON.stringify({ sentArgsCheck: 'mismatch', result: null }), { status: 200 }));
    const { body } = await get('/api/evidence/receipt/t-1');
    expect(body.sentArgsCheck).toBe('mismatch');
    expect(body.result).toBeNull();
  });

  it('the content call failing degrades to unchecked / no result — never a claimed match, never a lost entry', async () => {
    stubMcp(() => new Response('boom', { status: 500 }));
    const { status, body } = await get('/api/evidence/receipt/t-1');
    expect(status).toBe(200);
    expect(body.entry).toBeDefined();
    expect(body.sentArgsCheck).toBe('unchecked');
    expect(body.result).toBeNull();
  });
});

describe('GET /api/evidence/headlines', () => {
  it('returns the automatic tickets\' headline values', async () => {
    stubMcp(() => new Response('{}', { status: 200 }));
    const { status, body } = await get('/api/evidence/headlines');
    expect(status).toBe(200);
    expect(body.headlines).toEqual({ 't-1': { amount: '0.10' } });
  });
});
