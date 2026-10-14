/** /api/blocked-seen — round-trip over real HTTP; responses are the persisted cutoff. */
import { it, expect } from 'vitest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlockedSeenRouter } from '../routes/blocked-seen';

it('route round-trip over real HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-route-'));
  const app = express();
  app.use('/api/blocked-seen', express.json(), createBlockedSeenRouter(dir));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}/api/blocked-seen`;
  const j = async (u: string, init?: RequestInit): Promise<[number, { lastSeenBlockedAt: number }]> => {
    const r = await fetch(u, init);
    const data = (await r.json()) as { lastSeenBlockedAt: number };
    return [r.status, data];
  };

  // Never seen yet.
  expect(await j(base)).toEqual([200, { lastSeenBlockedAt: 0 }]);

  // Mark seen with an explicit ts — persisted and echoed back.
  expect(await j(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: 1_700_000_000_000 }),
  })).toEqual([200, { lastSeenBlockedAt: 1_700_000_000_000 }]);
  expect(await j(base)).toEqual([200, { lastSeenBlockedAt: 1_700_000_000_000 }]);

  // Marking again with no body falls back to "now" — just check it moved
  // forward and GET agrees with the POST response.
  const before = Date.now();
  const [status, body] = await j(base, { method: 'POST' });
  expect(status).toBe(200);
  expect(body.lastSeenBlockedAt).toBeGreaterThanOrEqual(before);
  expect(await j(base)).toEqual([200, body]);

  srv.close();
});
