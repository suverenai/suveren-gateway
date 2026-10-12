/**
 * WS4 (work-plan "Added 2026-10-11 — an account is Personal OR in one
 * team"): a managed gateway (IT policy `Team`) must refuse sign-in for an
 * account whose active workspace is not that team — checked against the
 * Authority Server itself (`GET /api/groups/me`), BEFORE the vault stores
 * anything.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { createAuthRouter } from '../auth';
import { managedWrongTeamMessage } from '../../lib/session-lock';
import { setInternalSecret } from '../../lib/mcp-bridge';

const tmp = () => mkdtempSync(join(tmpdir(), 'auth-managed-team-'));

function startServer(vault: Vault, managedTeamId?: string) {
  const app = express();
  app.use(express.json());
  const noopAuth = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const noopRateLimit = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use(
    '/auth',
    createAuthRouter(vault, noopAuth, noopRateLimit, undefined, undefined, undefined, managedTeamId),
  );
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

/** `groupsMe` is the raw `GET /api/groups/me` response body; `undefined` =
 *  the call fails (network error) instead of answering. */
function stubFetch(serverUrl: string, groupsMe: { group: { id: string } | null } | undefined) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(serverUrl)) return realFetch(url, init); // the test's own request
    if (url.includes('/api/auth/session')) {
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => ['hap-session=abc; Path=/; HttpOnly'] },
        json: async () => ({ user: { id: 'u1' }, sessionExpiresAt: 1_800_000_000 }),
      } as unknown as Response;
    }
    if (url.includes('/api/groups/me')) {
      if (groupsMe === undefined) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => groupsMe } as unknown as Response;
    }
    // /internal/configure, /api/users/me/pubkey, etc. — succeed quietly.
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  setInternalSecret('test-secret');
}

describe('POST /auth/login — unmanaged gateway (no Team policy)', () => {
  it('never calls /api/groups/me at all', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault); stop = close;
    stubFetch(url, { group: null });

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/api/groups/me'))).toBe(false);
  });
});

describe('POST /auth/login — managed gateway (Team policy set)', () => {
  it('succeeds when the account\'s active team matches the policy', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault, 'grp_team1'); stop = close;
    stubFetch(url, { group: { id: 'grp_team1' } });

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(200);
    expect(vault.isUnlocked()).toBe(true);
  });

  it('REFUSES (403) an account in a DIFFERENT team, naming the policy team', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault, 'grp_team1'); stop = close;
    stubFetch(url, { group: { id: 'grp_other' } });

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('managed_wrong_team');
    expect(body.message).toBe(managedWrongTeamMessage('grp_team1'));
    expect(vault.isUnlocked()).toBe(false);
  });

  it('REFUSES (403) a Personal account (no active team)', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault, 'grp_team1'); stop = close;
    stubFetch(url, { group: null });

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(403);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('REFUSES (502) rather than sign in when the check itself cannot be performed', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault, 'grp_team1'); stop = close;
    stubFetch(url, undefined); // /api/groups/me throws

    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(res.status).toBe(502);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('never stores the session cookie before the team check passes', async () => {
    const vault = new Vault(tmp());
    const { url, close } = await startServer(vault, 'grp_team1'); stop = close;
    stubFetch(url, { group: { id: 'grp_other' } });

    await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'hap_test' },
    });

    expect(vault.getSpCookie()).toBeNull();
  });
});
