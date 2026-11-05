/**
 * A signed-in tab whose session the gateway no longer accepts (restart →
 * vault locked) must go to sign-in, not show page errors like "MCP server is
 * not reachable" (live gateway after the 0.41.1 update, 2026-11-04).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spClient, SESSION_GONE_EVENT, sessionEvents, isAuthPath } from './sp-client';

const client = spClient as unknown as { apiKey: string | null; fetch: (p: string) => Promise<Response> };

afterEach(() => { vi.unstubAllGlobals(); client.apiKey = null; });

function withFetch(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
}

describe('session gone → one event, sign-in calls excluded', () => {
  it('isAuthPath matches the sign-in routes only', () => {
    expect(isAuthPath('/auth/login')).toBe(true);
    expect(isAuthPath('/api/auth/session')).toBe(true);
    expect(isAuthPath('/mcp/integrations')).toBe(false);
    expect(isAuthPath('/api/mandates/mine')).toBe(false);
  });

  it('a 401 on a signed-in request fires the event', async () => {
    withFetch(401);
    const seen = vi.fn();
    sessionEvents.addEventListener(SESSION_GONE_EVENT, seen);
    client.apiKey = 'k';
    await client.fetch('/mcp/integrations');
    sessionEvents.removeEventListener(SESSION_GONE_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('no event for a sign-in 401, for a signed-out client, or for other errors', async () => {
    const seen = vi.fn();
    sessionEvents.addEventListener(SESSION_GONE_EVENT, seen);
    const f = (p: string) => client.fetch(p);
    client.apiKey = null;
    withFetch(401); await f('/mcp/integrations'); // signed out: no key
    client.apiKey = 'k';
    await f('/auth/login');
    withFetch(500); await f('/mcp/integrations');
    withFetch(403); await f('/mcp/integrations');
    sessionEvents.removeEventListener(SESSION_GONE_EVENT, seen);
    expect(seen).not.toHaveBeenCalled();
  });
});
