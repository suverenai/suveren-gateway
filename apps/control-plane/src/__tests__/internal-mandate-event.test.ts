/**
 * Walkthrough 2026-11-11: a mandate the gateway creates after a person approved
 * the AI's Setup proposal did not show under Mandates at once. The creation runs
 * through POST /internal/mandate (the MCP server's committed executor), which
 * never crosses the /api proxy — the only place that announced mandate writes.
 * The route itself must announce it, once the Authority Server holds it, and
 * never for a dry run or a refusal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

vi.mock('../lib/mandate-ceremony', async (orig) => {
  const real = await orig<typeof import('../lib/mandate-ceremony')>();
  const plan = { profile: { id: 'p@1' }, groupName: 'G', mode: 'review', ttlSeconds: 60 };
  return {
    ...real,
    planMandate: vi.fn(async () => plan),
    createMandate: vi.fn(async (req: { refuse?: boolean }) => {
      if (req.refuse) throw new real.MandateRefused('no');
      return { authorizationId: 'authz_1', plan };
    }),
    changeMandate: vi.fn(async () => ({ authorizationId: 'authz_2', plan })),
  };
});

import { createInternalMandateRouter } from '../routes/internal-mandate';
import { eventBus } from '../lib/event-bus';

const SECRET = 'test-internal-secret-0123456789';

async function start(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/internal', express.json(), createInternalMandateRouter(() => SECRET, () => ({ user: null, as: async () => ({ status: 500, body: {} }) }) as never));
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function post(url: string, body: unknown) {
  return fetch(`${url}/internal/mandate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/mandate announces a new mandate', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; vi.restoreAllMocks(); });

  it('emits attestation-changed after the mandate is created', async () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const s = await start(); stop = s.close;
    const res = await post(s.url, { dryRun: false, request: { profile: 'p' } });
    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledWith('attestation-changed');
  });

  it('emits attestation-changed after a mandate change is signed', async () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const s = await start(); stop = s.close;
    const res = await post(s.url, { dryRun: false, request: { change: { mandateId: 'authz_0' } } });
    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledWith('attestation-changed');
  });

  it('stays silent for a dry run and for a refusal', async () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const s = await start(); stop = s.close;
    expect((await post(s.url, { dryRun: true, request: { profile: 'p' } })).status).toBe(200);
    expect((await post(s.url, { dryRun: false, request: { profile: 'p', refuse: true } })).status).toBe(422);
    expect(emit).not.toHaveBeenCalled();
  });
});
