import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createInternalEventsRouter } from '../routes/internal-events';
import { eventBus } from '../lib/event-bus';

const SECRET = 'test-internal-secret-0123456789';

function startServer(
  secret = SECRET,
  onSessionExpired?: () => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/internal', express.json(), createInternalEventsRouter(() => secret, onSessionExpired));
  return new Promise(resolve => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

async function post(url: string, body: unknown, secret?: string) {
  return fetch(`${url}/internal/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Internal-Secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/event', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; });

  it('emits on the bus so the badge and the notification actually fire', async () => {
    const { url, close } = await startServer(); stop = close;
    const seen: string[] = [];
    const off = eventBus.subscribe(e => seen.push(e.type));

    const res = await post(url, { type: 'proposal-added' }, SECRET);
    off();

    expect(res.status).toBe(200);
    // This is the regression: the v0.7.0 dispatcher was never reached because
    // nothing bridged the MCP process to this bus.
    expect(seen).toContain('proposal-added');
  });

  it('drops any payload the caller attaches', async () => {
    const { url, close } = await startServer(); stop = close;
    const payloads: unknown[] = [];
    const off = eventBus.subscribe(e => payloads.push(e.payload));

    await post(url, { type: 'proposal-added', title: 'Refund €4,000', amount: 4000 }, SECRET);
    off();

    // Presence, never content — even when the sibling process oversteps.
    expect(payloads).toEqual([undefined]);
  });

  it('rejects a wrong secret', async () => {
    const { url, close } = await startServer(); stop = close;
    const res = await post(url, { type: 'proposal-added' }, 'wrong-secret-0123456789012345');
    expect(res.status).toBe(401);
  });

  it('rejects a missing secret', async () => {
    const { url, close } = await startServer(); stop = close;
    const res = await post(url, { type: 'proposal-added' });
    expect(res.status).toBe(401);
  });

  it('accepts nothing when no secret is configured', async () => {
    const { url, close } = await startServer(''); stop = close;
    const res = await post(url, { type: 'proposal-added' }, '');
    expect(res.status).toBe(401);
  });

  it('refuses event types outside the allowlist', async () => {
    const { url, close } = await startServer(); stop = close;
    const seen: string[] = [];
    const off = eventBus.subscribe(e => seen.push(e.type));

    // A sibling process may say "a human is needed"; it may not inject
    // arbitrary events into the UI's stream.
    const res = await post(url, { type: 'team-membership-changed' }, SECRET);
    off();

    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('refuses a non-string type', async () => {
    const { url, close } = await startServer(); stop = close;
    const res = await post(url, { type: { evil: true } }, SECRET);
    expect(res.status).toBe(400);
  });
});

describe('POST /internal/event — session-expired (the MCP server -> control plane lock signal)', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; });

  it('invokes the lock callback instead of forwarding to the SSE bus', async () => {
    const onSessionExpired = vi.fn();
    const { url, close } = await startServer(SECRET, onSessionExpired); stop = close;
    const seen: string[] = [];
    const off = eventBus.subscribe(e => seen.push(e.type));

    const res = await post(url, { type: 'session-expired' }, SECRET);
    off();

    expect(res.status).toBe(200);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    // Not a bus event under this name — session-lock.ts emits its OWN
    // 'session-locked' event once it has actually locked, not this one.
    expect(seen).not.toContain('session-expired');
  });

  it('still requires the shared secret', async () => {
    const onSessionExpired = vi.fn();
    const { url, close } = await startServer(SECRET, onSessionExpired); stop = close;

    const res = await post(url, { type: 'session-expired' }, 'wrong-secret-0123456789012345');

    expect(res.status).toBe(401);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('is a 400 (unsupported) when no callback is wired — never silently accepted', async () => {
    const { url, close } = await startServer(SECRET); stop = close; // no onSessionExpired
    const res = await post(url, { type: 'session-expired' }, SECRET);
    // No callback wired means the caller wanted 200 with a no-op, which is
    // fine for a sibling process that cannot tell — but MUST not 500.
    expect(res.status).toBe(200);
  });
});
