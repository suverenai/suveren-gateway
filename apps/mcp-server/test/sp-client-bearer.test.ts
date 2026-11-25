/**
 * A gateway that signed in by its device key holds a bearer token, pushed by the
 * control plane in the slot that holds the session cookie everywhere else
 * (device-keys step 6). SPClient sends a token as `Authorization` and a cookie as
 * `Cookie`, never one as the other. A real local HTTP server stands in for the
 * Authority Server; it records the headers it received.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { SPClient } from '../src/lib/sp-client';

let server: Server | null = null;
afterEach(async () => { await new Promise<void>(r => (server ? server.close(() => r()) : r())); server = null; });

async function asServer(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: 'ab'.repeat(32) }));
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, seen };
}

describe('SPClient credential header', () => {
  it('sends a bearer token as Authorization and no Cookie', async () => {
    const as = await asServer();
    const c = new SPClient(as.url);
    c.setSessionCookie('Bearer 11111111-2222-3333-4444-555555555555');
    await c.getPublicKey();
    expect(as.seen[0].authorization).toBe('Bearer 11111111-2222-3333-4444-555555555555');
    expect(as.seen[0].cookie).toBeUndefined();
    expect(c.isUnlocked()).toBe(true);
  });

  it('sends a session cookie as Cookie and no Authorization, exactly as before', async () => {
    const as = await asServer();
    const c = new SPClient(as.url);
    c.setSessionCookie('hap-session=abc; Path=/');
    await c.getPublicKey();
    expect(as.seen[0].cookie).toBe('hap-session=abc; Path=/');
    expect(as.seen[0].authorization).toBeUndefined();
  });

  it('sends neither before anyone signed in', async () => {
    const as = await asServer();
    await new SPClient(as.url).getPublicKey();
    expect(as.seen[0].cookie).toBeUndefined();
    expect(as.seen[0].authorization).toBeUndefined();
  });
});
