/**
 * Login must identify the gateway to the AS (the version header is how the
 * AS decides between a 30-day gateway session and the old 24-hour browser
 * session) and must capture `sessionExpiresAt` from the response into the
 * vault — in memory only, never written to disk.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { setInternalSecret } from '../../lib/mcp-bridge';

const tmp = () => mkdtempSync(join(tmpdir(), 'auth-session-'));

function startServer(vault: Vault, onSessionEstablished?: () => void) {
  const app = express();
  app.use(express.json());
  const noopAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const noopRateLimit = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/auth', createAuthRouter(vault, noopAuth, noopRateLimit, onSessionEstablished));
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;
let stop: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;

afterEach(async () => {
  await stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

/**
 * Stubs the fetch the ROUTE HANDLER makes to the AS/MCP — never the test's
 * own call into its local express server, which must hit the real socket.
 * `serverUrl` is known only after `startServer()` returns, so this is called
 * AFTER that, and BEFORE the test issues its own request (both share the one
 * process-wide `globalThis.fetch`).
 */
function stubFetch(serverUrl: string, sessionResponse: { status: number; body: unknown }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(serverUrl)) return realFetch(url, init); // the test's own request
    if (url.includes('/api/auth/session')) {
      return {
        ok: sessionResponse.status >= 200 && sessionResponse.status < 300,
        status: sessionResponse.status,
        headers: { getSetCookie: () => ['hap-session=abc; Path=/; HttpOnly'] },
        json: async () => sessionResponse.body,
      } as unknown as Response;
    }
    // /internal/configure (MCP bridge), /api/users/me/pubkey, etc. — succeed quietly.
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  setInternalSecret('test-secret');
}

describe('POST /auth/login — Authority Server session identification', () => {
  it('sends x-suveren-gateway-version on the AS login call', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault); stop = close;
    stubFetch(url, { status: 200, body: { user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 } });

    await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    const sessionCall = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/auth/session'));
    expect(sessionCall).toBeDefined();
    const headers = (sessionCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-suveren-gateway-version']).toBeTruthy();
  });

  it('stores sessionExpiresAt from the login response, in memory', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault); stop = close;
    stubFetch(url, { status: 200, body: { user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 } });

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(200);
    expect(vault.getSessionExpiresAt()).toBe(1_800_000_000);
  });

  it('tells the scheduler to reschedule after a successful login', async () => {
    const vault = new Vault(tmp());
    const onSessionEstablished = vi.fn();
    const { url, close } = await startServer(vault, onSessionEstablished); stop = close;
    stubFetch(url, { status: 200, body: { user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 } });

    await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(onSessionEstablished).toHaveBeenCalledOnce();
  });

  it('tolerates an AS response with no sessionExpiresAt (older/unpatched AS)', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault); stop = close;
    stubFetch(url, { status: 200, body: { user: { id: 'u1' } } });

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(200);
    expect(vault.getSessionExpiresAt()).toBeNull();
  });

  it('never writes anything about the session to the data directory', async () => {
    const dataDir = tmp();
    const vault = new Vault(dataDir);
    const { url, close } = await startServer(vault); stop = close;
    stubFetch(url, { status: 200, body: { user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 } });

    await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    // Only the vault's own encrypted files may exist — grep every one of
    // them (as ciphertext, so this also proves nothing is stored in the clear).
    for (const name of existsSync(dataDir) ? readdirSync(dataDir) : []) {
      const contents = readFileSync(join(dataDir, name), 'utf-8');
      expect(contents).not.toContain('1800000000');
      expect(contents).not.toContain('sessionExpiresAt');
    }
  });
});

describe('POST /auth/logout — signing out stops the agent too', () => {
  it('clears the MCP server session and ends the session on the Authority Server', async () => {
    const vault = new Vault(tmp());
    vault.setSpCookie('hap-session=abc; Path=/; HttpOnly');
    const { url, close } = await startServer(vault); stop = close;
    stubFetch(url, { status: 200, body: {} });

    const res = await fetch(`${url}/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(200);

    const calls = fetchMock.mock.calls as Array<[string, RequestInit | undefined]>;
    expect(calls.some(([u]) => u.includes('/internal/clear-session')), 'MCP kept its session').toBe(true);
    const asLogout = calls.find(([u]) => u.includes('/api/auth/logout'));
    expect(asLogout, 'the AS session was left alive').toBeTruthy();
    expect((asLogout![1]?.headers as Record<string, string>).cookie).toContain('hap-session=abc');
    expect(vault.getSpCookie()).toBeNull();
  });

  it('still signs out locally when the MCP server and the AS are unreachable', async () => {
    const vault = new Vault(tmp());
    vault.setSpCookie('hap-session=abc');
    const { url, close } = await startServer(vault); stop = close;
    fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
      if (u.startsWith(url)) return realFetch(u, init);
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);
    setInternalSecret('test-secret');

    const res = await fetch(`${url}/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(vault.getSpCookie()).toBeNull();
  });
});
