/**
 * The switch (SUVEREN_DEVICE_KEYS=on): off, none of the new routes exist; and a
 * vault that already has a password header never falls back to the account key,
 * switch or no switch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { PageSessions } from '../../lib/page-session';
import { UnlockLimiter } from '../../lib/unlock-limiter';
import { ChangeConfirmations } from '../../lib/change-confirmation';
import { requireAuth, type PageSessionDeps } from '../../middleware/auth';
import { createAuthRouter } from '../auth';
import { createVaultRouter } from '../vault';
import { mountDeviceKeyRoutes, deviceKeysEnabled } from '../device-keys-mount';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const PW = 'correct horse battery';
const KEY = 'hap_account_key';
const tmp = () => mkdtempSync(join(tmpdir(), 'dk-mount-'));

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const host = `127.0.0.1:${port}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const h: Record<string, string> = { host, ...headers };
  if (method !== 'GET') h.origin = `http://${host}`;
  if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(Buffer.byteLength(payload)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { let b = {}; try { b = JSON.parse(d); } catch { /* html 404 */ } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(vault: Vault, enabled: boolean) {
  const deps: PageSessionDeps = { sessions: new PageSessions(), listensOnLoopbackOnly: true };
  const app = express();
  mountDeviceKeyRoutes(app, {
    enabled, vault, pageSession: deps, limiter: new UnlockLimiter(), confirmations: new ChangeConfirmations(),
    hasCheckKey: () => false, internalSecret: () => 'sekret',
  });
  const guard = requireAuth(vault, deps);
  app.use('/auth', express.json(), createAuthRouter(vault, guard, (_q, _s, n) => n(), undefined, undefined, undefined, undefined, deps));
  app.get('/api/x', guard, (_q, s) => { s.json({ ok: true }); });
  const server: Server = await new Promise(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  servers.push(server);
  return { port: (server.address() as { port: number }).port, deps };
}

describe('SUVEREN_DEVICE_KEYS', () => {
  it('is on only for the exact value "on"', () => {
    expect(deviceKeysEnabled({})).toBe(false);
    expect(deviceKeysEnabled({ SUVEREN_DEVICE_KEYS: '1' })).toBe(false);
    expect(deviceKeysEnabled({ SUVEREN_DEVICE_KEYS: 'ON' })).toBe(false);
    expect(deviceKeysEnabled({ SUVEREN_DEVICE_KEYS: 'on' })).toBe(true);
  });

  const routes: Array<[string, string]> = [
    ['GET', '/auth/password/status'], ['POST', '/auth/password/set'], ['POST', '/auth/unlock'],
    ['POST', '/auth/password/change'], ['POST', '/auth/confirm/request'], ['POST', '/auth/confirm'],
    ['POST', '/internal/os-signal'],
  ];

  it('off: none of the new routes exist (404)', async () => {
    const { port } = await boot(new Vault(tmp(), FAST), deviceKeysEnabled({}));
    for (const [m, p] of routes) expect((await call(port, m, p, {}, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(404);
  });

  it('on: they are mounted', async () => {
    const { port } = await boot(new Vault(tmp(), FAST), deviceKeysEnabled({ SUVEREN_DEVICE_KEYS: 'on' }));
    for (const [m, p] of routes) expect((await call(port, m, p, {}, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).not.toBe(404);
    expect((await call(port, 'GET', '/auth/password/status')).body).toEqual({ passwordSet: false });
  });

  it('off, no password: the account key works as it always did', async () => {
    const vault = new Vault(tmp(), FAST);
    await vault.deriveAndSetKey(KEY);
    const { port } = await boot(vault, false);
    expect((await call(port, 'GET', '/api/x', { 'x-api-key': KEY })).status).toBe(200);
  });

  it('off BUT the vault has a password header: fail closed, the account key is refused and nothing is wiped', async () => {
    const dir = tmp();
    const first = new Vault(dir, { ...FAST, deviceKeys: true });
    await first.deriveAndSetKey(KEY);
    first.setSessionUser({ id: 'u1', did: 'did:key:u1' });
    first.setCredential('gmail', { token: 'secret-token-1' });
    await first.setPassword(PW, 'u1');

    // restarted with the switch OFF
    const vault = new Vault(dir, FAST);
    expect(vault.hasPassword()).toBe(true);
    const { port } = await boot(vault, false);
    expect((await call(port, 'GET', '/api/x', { 'x-api-key': KEY })).status).toBe(401);
    expect((await call(port, 'POST', '/auth/login', { 'x-api-key': 'hap_someone_else' }, { confirmWipe: true })).status).toBe(409);
    expect((await call(port, 'POST', '/auth/login', { 'x-api-key': KEY }, {})).status).toBe(401);
    expect(vault.isUnlocked()).toBe(false);
    // no unlock route exists with the switch off: locked out until it is turned back on
    expect((await call(port, 'POST', '/auth/unlock', {}, { password: PW })).status).toBe(404);
    // nothing was wiped
    const again = new Vault(dir, FAST);
    expect(await again.unlockWithPassword(PW)).toBe(true);
    expect(again.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });

  it('off, header present: replacing a stored login is refused by the vault router', async () => {
    const dir = tmp();
    const first = new Vault(dir, { ...FAST, deviceKeys: true });
    await first.deriveAndSetKey(KEY);
    first.setSessionUser({ id: 'u1', did: 'did:key:u1' });
    first.setCredential('gmail', { token: 'secret-token-1' });
    await first.setPassword(PW, 'u1');
    const vault = new Vault(dir, FAST);
    await vault.unlockWithPassword(PW);
    const { refusingGate } = await import('../../lib/change-confirmation');
    const app = express();
    app.use('/vault', express.json(), createVaultRouter(vault, refusingGate));
    const server: Server = await new Promise(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    expect((await call(port, 'PUT', '/vault/credentials/gmail', {}, { token: 'x' })).status).toBe(403);
    expect((await call(port, 'DELETE', '/vault/credentials/gmail')).status).toBe(403);
    expect(vault.getCredential('gmail')).toEqual({ token: 'secret-token-1' });
  });
});
