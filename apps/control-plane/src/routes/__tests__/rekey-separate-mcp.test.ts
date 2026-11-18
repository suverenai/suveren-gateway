/**
 * The MCP server on its OWN data folder (separate containers). While the move
 * to a fresh vault key is not confirmed by it, the control plane must never
 * hand it the new key: its stores are sealed with the old one, and the real
 * GateStore reads a store it cannot open as empty. Nothing may read as empty at
 * any point; a retry that keeps failing is visible (a lock reason), not silent.
 *
 * The MCP side here is a stand-in on a separate folder behind the two endpoints
 * bin/http.ts serves (/internal/configure, /internal/rekey), answered in-process.
 * It keeps GateStore's behaviour that matters: a store it cannot open with the
 * key it was given reads as EMPTY. (apps/mcp-server/test/rekey.test.ts runs the
 * real GateStore through the same re-seal; a test here cannot import it, the
 * packages do not share a source root.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { PageSessions, SESSION_COOKIE, SESSION_HEADER } from '../../lib/page-session';
import { UnlockLimiter } from '../../lib/unlock-limiter';
import { ChangeConfirmations } from '../../lib/change-confirmation';
import { requireAuth, type PageSessionDeps } from '../../middleware/auth';
import { createAuthRouter } from '../auth';
import { mountDeviceKeyRoutes } from '../device-keys-mount';
import { setInternalSecret } from '../../lib/mcp-bridge';
import { rekeyDirectory, sealedWith, CONTROL_PLANE_FILES } from '../../lib/rekey';
import { mcpRekeyClient } from '../../lib/mcp-bridge';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
const PW = 'correct horse battery';
const KEY = 'hap_account_key';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const entry = (id: string) => ({ authorizationId: id, gateContent: { intent: 'secret intent' } });

/** GateStore's way of holding data: one AES-GCM blob per entry in gates.enc.json under the vault key. */
class MiniGateStore {
  private entries = new Map<string, unknown>();
  private key: Buffer | null = null;
  constructor(private readonly dir: string) {}
  private get file() { return join(this.dir, 'gates.enc.json'); }
  setVaultKey(key: Buffer) {
    this.key = key;
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8')) as { entries: Record<string, { iv: string; ciphertext: string; tag: string }> };
      const next = new Map<string, unknown>();
      for (const [k, b] of Object.entries(data.entries)) {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'hex'));
        d.setAuthTag(Buffer.from(b.tag, 'hex'));
        next.set(k, JSON.parse(Buffer.concat([d.update(Buffer.from(b.ciphertext, 'hex')), d.final()]).toString('utf8')));
      }
      this.entries = next;
    } catch {
      this.entries = new Map(); // cannot open: empty, silently, exactly like GateStore
    }
  }
  set(id: string, e: unknown) {
    this.entries.set(id, e);
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.entries) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.key!, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
      out[k] = { iv: iv.toString('hex'), ciphertext: ct.toString('hex'), tag: c.getAuthTag().toString('hex') };
    }
    writeFileSync(this.file, JSON.stringify({ version: 1, entries: out }));
  }
  getAll() { return [...this.entries.values()]; }
}

/** The MCP server's side of the two endpoints, on its own folder. */
class McpStandIn {
  store: MiniGateStore;
  keyInUse: string | null = null;
  keysHandedOver: string[] = [];
  rekeyFails = true;
  constructor(readonly dir: string) { this.store = new MiniGateStore(dir); }
  configure(keyHex: string) {
    this.keysHandedOver.push(keyHex);
    this.keyInUse = keyHex;
    this.store.setVaultKey(Buffer.from(keyHex, 'hex'));
  }
  /** The re-key was applied but its reply never arrived. */
  loseReply = false;
  stateFails = false;
  state(oldHex: string, newHex: string) {
    if (this.stateFails) throw new Error('unreachable');
    return { sealedWith: sealedWith(this.dir, Buffer.from(oldHex, 'hex'), Buffer.from(newHex, 'hex'), { skip: CONTROL_PLANE_FILES }) };
  }
  rekey(oldHex: string, newHex: string) {
    if (this.rekeyFails) throw new Error('unreachable');
    const key = Buffer.from(newHex, 'hex');
    rekeyDirectory(this.dir, Buffer.from(oldHex, 'hex'), key, { skip: CONTROL_PLANE_FILES });
    this.store.setVaultKey(key);
    this.keyInUse = newHex;
    if (this.loseReply) throw new Error('reply lost');
  }
  /** What a fresh MCP process would read with this key. */
  readableWith(keyHex: string): number {
    const s = new MiniGateStore(this.dir);
    s.setVaultKey(Buffer.from(keyHex, 'hex'));
    return s.getAll().length;
  }
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
  const host = `127.0.0.1:${port}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const h: Record<string, string> = { host, origin: `http://${host}`, ...headers };
  if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(Buffer.byteLength(payload)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { let b = {}; try { b = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); vi.unstubAllGlobals(); });

/** A control plane process over `dir`, talking to `mcp`. */
async function controlPlane(dir: string, mcp: McpStandIn) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith('/internal/rekey')) {
      try { mcp.rekey(body.oldKeyHex, body.newKeyHex); } catch { return { ok: false, status: 502, json: async () => ({}) } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (u.endsWith('/internal/key-state')) {
      try { return { ok: true, status: 200, json: async () => mcp.state(body.oldKeyHex, body.newKeyHex) } as unknown as Response; } catch { return { ok: false, status: 502, json: async () => ({}) } as unknown as Response; }
    }
    if (u.endsWith('/internal/configure')) {
      if (body.vaultKeyHex) mcp.configure(body.vaultKeyHex);
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (u.includes('/api/auth/session')) {
      return { ok: true, status: 200, headers: { getSetCookie: () => ['hap-session=s; Path=/; HttpOnly'] }, json: async () => ({ user: { id: 'u1', did: 'did:key:u1' }, sessionExpiresAt: 1_800_000_000 }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ manifests: [] }) } as unknown as Response;
  }));
  setInternalSecret('test-secret');
  const vault = new Vault(dir, { ...FAST, deviceKeys: true });
  const deps: PageSessionDeps = { sessions: new PageSessions(), listensOnLoopbackOnly: true };
  vault.onLocked(() => deps.sessions.endAll());
  const app = express();
  mountDeviceKeyRoutes(app, {
    enabled: true, vault, pageSession: deps, limiter: new UnlockLimiter(), confirmations: new ChangeConfirmations(),
    hasCheckKey: () => false, mcp: mcpRekeyClient, internalSecret: () => 'sekret',
  });
  app.use('/auth', express.json(), createAuthRouter(vault, requireAuth(vault, deps), (_q, _s, n) => n(), undefined, undefined, undefined, undefined, deps));
  const server: Server = await new Promise(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  servers.push(server);
  return { vault, port: (server.address() as { port: number }).port };
}

const sess = (r: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }) => {
  const cookie = String(r.headers['set-cookie']?.[0] ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
  return { cookie: `${SESSION_COOKIE}=${cookie}`, [SESSION_HEADER]: String(r.body.sessionToken) };
};

/** A gateway as the last release leaves it, its MCP server (own folder) already holding stores sealed with the account-derived key. */
async function legacyWithMcp() {
  const cpDir = tmp('rk-cp-'), mcpDir = tmp('rk-mcp-');
  const mcp = new McpStandIn(mcpDir);
  const first = await controlPlane(cpDir, mcp);
  await first.vault.deriveAndSetKey(KEY);
  first.vault.setSessionUser({ id: 'u1', did: 'did:key:u1' });
  first.vault.setCredential('gmail', { token: 'secret-token-1' });
  const oldHex = first.vault.getVaultKeyHex();
  mcp.configure(oldHex);
  mcp.store.set('a1', entry('a1'));
  mcp.store.set('a2', entry('a2'));
  return { cpDir, mcp, first, oldHex };
}

describe('the MCP server on a separate data folder', () => {
  it('never gets the new key before it has re-sealed; nothing reads as empty; the retry then succeeds', async () => {
    const { cpDir, mcp, first, oldHex } = await legacyWithMcp();

    // 1. the move, with the MCP server unreachable for the re-key
    const set = await call(first.port, 'POST', '/auth/password/set', { 'x-api-key': KEY }, { password: PW });
    expect(set.status).toBe(202);
    expect(set.body.rekeyPending).toBe(true);
    const newHex = first.vault.getVaultKeyHex();
    expect(newHex).not.toBe(oldHex);
    expect(mcp.readableWith(oldHex)).toBe(2);
    expect(mcp.keyInUse).toBe(oldHex);

    // 2. the control plane restarts, unlocks (re-key still failing), signs in and configures
    const cp = await controlPlane(cpDir, mcp);
    const unlock = await call(cp.port, 'POST', '/auth/unlock', {}, { password: PW });
    expect(unlock.status).toBe(200);
    expect(unlock.body.rekeyPending).toBe(true);
    const s = sess(unlock);
    const login = await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {});
    expect(login.status).toBe(200);
    expect(login.body.rekeyPending).toBe(true);
    expect(mcp.keysHandedOver).not.toContain(newHex);        // only ever the old key
    expect(mcp.keyInUse).toBe(oldHex);
    expect(mcp.store.getAll()).toHaveLength(2);               // read with the old key, not empty
    expect(mcp.readableWith(oldHex)).toBe(2);
    // the control plane itself still reads what the MCP server seals with the old key
    expect(cp.vault.decrypt(JSON.parse(JSON.stringify(first.vault.encrypt('x'))))).toBe('x');

    // 3. the retry succeeds: the MCP server re-seals, then it, and only then, gets the new key
    mcp.rekeyFails = false;
    const again = await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {});
    expect(again.status).toBe(200);
    expect(again.body.rekeyPending).toBeUndefined();
    expect(mcp.keyInUse).toBe(newHex);
    expect(mcp.readableWith(newHex)).toBe(2);                 // still nothing lost
    expect(mcp.readableWith(oldHex)).toBe(0);                 // and the account-derived key opens nothing
    expect(cp.vault.hasPendingRekey()).toBe(false);
    expect(cp.vault.hasPendingRekey()).toBe(false);
  });

  it('a retry that keeps failing is visible: the vault locks with a reason, and the MCP server\'s stores are untouched', async () => {
    const { cpDir, mcp, first, oldHex } = await legacyWithMcp();
    await call(first.port, 'POST', '/auth/password/set', { 'x-api-key': KEY }, { password: PW });
    const cp = await controlPlane(cpDir, mcp);

    const unlock = await call(cp.port, 'POST', '/auth/unlock', {}, { password: PW });   // attempt 1
    expect(unlock.status).toBe(200);
    const s = sess(unlock);
    expect((await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {})).status).toBe(200); // attempt 2
    const third = await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {});               // attempt 3
    expect(third.status).toBe(503);
    expect(third.body.code).toBe('rekey_incomplete');
    expect(cp.vault.isUnlocked()).toBe(false);
    expect(cp.vault.getLockedReason()).toBe('rekey-incomplete');

    expect(mcp.readableWith(oldHex)).toBe(2);
    expect(mcp.keysHandedOver.every(k => k === oldHex)).toBe(true);
  });
});

describe('what the MCP server reports decides which key it is configured with', () => {
  it('LOST REPLY: the MCP applied the re-key but the answer was lost; the next login configures the NEW key, and nothing reads as empty or is overwritten', async () => {
    const { cpDir, mcp, first, oldHex } = await legacyWithMcp();
    mcp.rekeyFails = false;
    mcp.loseReply = true;
    const handedBefore = mcp.keysHandedOver.length;
    // /auth/password/set: the MCP re-seals and switches, then the answer is lost. What it reports (new) decides.
    const set = await call(first.port, 'POST', '/auth/password/set', { 'x-api-key': KEY }, { password: PW });
    expect(set.status).toBe(200);
    const newHex = first.vault.getVaultKeyHex();
    expect(mcp.keyInUse).toBe(newHex);

    mcp.loseReply = false;
    const cp = await controlPlane(cpDir, mcp);
    const unlock = await call(cp.port, 'POST', '/auth/unlock', {}, { password: PW });
    const s = sess(unlock);
    const login = await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {});
    expect(login.status).toBe(200);
    expect(mcp.keysHandedOver.slice(handedBefore)).not.toContain(oldHex); // the old key never went back to it
    expect(mcp.store.getAll()).toHaveLength(2);
    mcp.store.set('a3', entry('a3'));
    expect(mcp.readableWith(newHex)).toBe(3);                    // the next write did not destroy a1 and a2
  });

  it('when what it is sealed with cannot be determined nothing is configured, and the vault locks visibly after repeated failure', async () => {
    const { cpDir, mcp, first } = await legacyWithMcp();
    mcp.rekeyFails = true;
    await call(first.port, 'POST', '/auth/password/set', { 'x-api-key': KEY }, { password: PW });
    const handedBefore = mcp.keysHandedOver.length;
    mcp.stateFails = true;
    const cp = await controlPlane(cpDir, mcp);
    const unlock = await call(cp.port, 'POST', '/auth/unlock', {}, { password: PW });          // attempt 1
    const s = sess(unlock);
    const second = await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {}); // attempt 2
    expect(second.status).toBe(200);
    expect(second.body.rekeyPending).toBe(true);
    expect(mcp.keysHandedOver).toHaveLength(handedBefore);                                      // nothing configured
    const third = await call(cp.port, 'POST', '/auth/login', { ...s, 'x-api-key': KEY }, {});   // attempt 3
    expect(third.status).toBe(503);
    expect(cp.vault.getLockedReason()).toBe('rekey-incomplete');
    expect(mcp.keysHandedOver).toHaveLength(handedBefore);
  });
});
