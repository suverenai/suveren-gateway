import { describe, it, expect } from 'vitest';
import {
  remotePreflightTarget,
  preflightRemoteAuth,
  isBlankCredential,
} from '../src/lib/remote-auth-preflight';

/**
 * Mollie with a rejected token opened a Mollie login window in the browser on
 * every gateway start: mcp-remote treats a 401 as "start OAuth", not as a
 * failure. The gateway now asks the remote first and refuses to spawn on
 * 401/403 — and only then, so a working connector is never held back.
 */
const mollieArgs = ['https://mcp.mollie.com/mcp', '--header', 'Authorization: Bearer access_org_x'];

describe('remotePreflightTarget', () => {
  it('finds url + header in an mcp-remote argv', () => {
    expect(remotePreflightTarget('mcp-remote', mollieArgs)).toEqual({
      url: 'https://mcp.mollie.com/mcp',
      authorization: 'Bearer access_org_x',
    });
  });
  it('accepts a full path to the binary', () => {
    expect(remotePreflightTarget('/x/node_modules/.bin/mcp-remote', mollieArgs)).not.toBeNull();
  });
  it('is not for local stdio connectors or header-less remotes', () => {
    expect(remotePreflightTarget('npx', ['-y', '@humanagencyp/deploy-mcp'])).toBeNull();
    expect(remotePreflightTarget('mcp-remote', ['https://mcp.example.com/mcp'])).toBeNull();
    expect(remotePreflightTarget('mcp-remote', ['https://x/mcp', '--header', 'X-Api-Key: k'])).toBeNull();
  });
});

describe('isBlankCredential', () => {
  it('spots an interpolated-away token', () => {
    expect(isBlankCredential('Bearer ')).toBe(true);
    expect(isBlankCredential('Bearer')).toBe(true);
    expect(isBlankCredential('Bearer abc')).toBe(false);
  });
});

describe('preflightRemoteAuth', () => {
  const target = { url: 'https://mcp.mollie.com/mcp', authorization: 'Bearer nope' };
  const respond = (status: number) =>
    (async () => new Response(null, { status })) as unknown as typeof fetch;

  it('refuses on 401 and says why, naming the host', async () => {
    const v = await preflightRemoteAuth(target, respond(401));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain('mcp.mollie.com');
      expect(v.reason).toContain('401');
      expect(v.reason).toContain('browser');
    }
  });

  it('refuses on 403 too', async () => {
    expect((await preflightRemoteAuth(target, respond(403))).ok).toBe(false);
  });

  it('refuses an empty token without touching the network', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    const v = await preflightRemoteAuth({ ...target, authorization: 'Bearer ' }, spy);
    expect(v.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('lets everything else through — 200, other 4xx/5xx, unreachable', async () => {
    expect((await preflightRemoteAuth(target, respond(200))).ok).toBe(true);
    expect((await preflightRemoteAuth(target, respond(404))).ok).toBe(true);
    expect((await preflightRemoteAuth(target, respond(500))).ok).toBe(true);
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect((await preflightRemoteAuth(target, down)).ok).toBe(true);
  });

  it('sends the connector\'s own header on an initialize POST', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const capture = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await preflightRemoteAuth(target, capture);
    expect(seen!.url).toBe(target.url);
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer nope');
    expect(JSON.parse(seen!.init.body as string).method).toBe('initialize');
  });
});
