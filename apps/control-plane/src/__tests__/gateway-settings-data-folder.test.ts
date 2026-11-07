/** GET /api/gateway-settings/data-folder — behind the real auth guard, returns the resolved folder. */
import { it, expect } from 'vitest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Vault } from '../lib/vault';
import { requireAuth } from '../middleware/auth';
import { createGatewaySettingsRouter } from '../routes/gateway-settings';

it('requires a signed-in session and returns the resolved data folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-df-'));
  const vault = new Vault(dir);
  await vault.deriveAndSetKey('test-api-key');
  const app = express();
  app.use('/api/gateway-settings', express.json(), requireAuth(vault), createGatewaySettingsRouter(dir));
  const srv = app.listen(0);
  const url = `http://127.0.0.1:${(srv.address() as any).port}/api/gateway-settings/data-folder`;

  const anon = await fetch(url);
  expect(anon.status).toBe(401);
  expect(await anon.text()).not.toContain(dir);

  const wrong = await fetch(url, { headers: { 'x-api-key': 'nope' } });
  expect(wrong.status).toBe(401);

  const ok = await fetch(url, { headers: { 'x-api-key': 'test-api-key' } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ dataDir: resolve(dir) });

  srv.close();
});
