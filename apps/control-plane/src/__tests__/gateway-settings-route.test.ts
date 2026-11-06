/**
 * /api/gateway-settings behind the real auth guard — round-trip over real HTTP.
 * Pins the approval panel's "open approvals by themselves" setting: default on,
 * the response is the persisted state, bad input is refused, and nothing is
 * readable or writable without the API key.
 */
import { it, expect } from 'vitest';
import express from 'express';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireAuth } from '../middleware/auth';
import { createGatewaySettingsRouter } from '../routes/gateway-settings';

const KEY = 'test-key';
const fakeVault = { isUnlocked: () => true, validateApiKey: (k: string) => k === KEY } as never;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gs-route-'));
  const app = express();
  app.use('/api/gateway-settings', express.json(), requireAuth(fakeVault), createGatewaySettingsRouter(dir));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/gateway-settings`;
  return { dir, srv, base };
}
const authed = { 'X-API-Key': KEY, 'Content-Type': 'application/json' };

it('requires the API key to read and to write', async () => {
  const { srv, base, dir } = await setup();
  expect((await fetch(base)).status).toBe(401);
  expect((await fetch(base, { headers: { 'X-API-Key': 'wrong' } })).status).toBe(401);
  const put = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openApprovalsAutomatically: false }) });
  expect(put.status).toBe(401);
  // The refused write changed nothing.
  expect((await (await fetch(base, { headers: authed })).json() as { openApprovalsAutomatically: boolean }).openApprovalsAutomatically).toBe(true);
  expect(() => readFileSync(join(dir, 'settings.json'))).toThrow();
  srv.close();
});

it('defaults on; PUT returns and persists the saved state; other settings stay', async () => {
  const { srv, base, dir } = await setup();
  const get = async () => (await fetch(base, { headers: authed })).json() as Promise<{ desktopNotifications: boolean; openApprovalsAutomatically: boolean }>;
  expect(await get()).toEqual({ desktopNotifications: true, openApprovalsAutomatically: true });

  const off = await fetch(base, { method: 'PUT', headers: authed, body: JSON.stringify({ openApprovalsAutomatically: false }) });
  expect(off.status).toBe(200);
  expect(await off.json()).toEqual({ desktopNotifications: true, openApprovalsAutomatically: false });
  expect(await get()).toEqual({ desktopNotifications: true, openApprovalsAutomatically: false });
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).openApprovalsAutomatically).toBe(false);

  // A write of the other setting leaves this one alone.
  await fetch(base, { method: 'PUT', headers: authed, body: JSON.stringify({ desktopNotifications: false }) });
  expect(await get()).toEqual({ desktopNotifications: false, openApprovalsAutomatically: false });
  srv.close();
});

it('refuses a non-boolean value', async () => {
  const { srv, base } = await setup();
  const r = await fetch(base, { method: 'PUT', headers: authed, body: JSON.stringify({ openApprovalsAutomatically: 'no' }) });
  expect(r.status).toBe(400);
  srv.close();
});
