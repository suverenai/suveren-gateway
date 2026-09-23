/** /api/archived-mandates — round-trip over real HTTP; responses are the persisted list. */
import { it, expect } from 'vitest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchivedMandatesRouter } from '../routes/archived-mandates';

it('route round-trip over real HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-route-'));
  const app = express();
  app.use('/api/archived-mandates', express.json(), createArchivedMandatesRouter(dir));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}/api/archived-mandates`;
  const j = async (u: string, m = 'GET') => { const r = await fetch(u, { method: m }); return [r.status, await r.json()]; };
  expect(await j(base)).toEqual([200, { archived: [] }]);
  expect(await j(`${base}/authz_1`, 'PUT')).toEqual([200, { archived: ['authz_1'] }]);
  expect(await j(`${base}/authz_2`, 'PUT')).toEqual([200, { archived: ['authz_1', 'authz_2'] }]);
  expect(await j(`${base}/authz_1`, 'DELETE')).toEqual([200, { archived: ['authz_2'] }]);
  expect((await j(`${base}/bad%20id`, 'PUT'))[0]).toBe(400);
  expect(await j(base)).toEqual([200, { archived: ['authz_2'] }]);
  srv.close();
});
