/**
 * What the /api proxy sends on to the Authority Server, through the real
 * http-proxy-middleware and the same scrub index.ts installs on proxyReq.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { scrubProxyRequest } from '../lib/proxy-headers';

const servers: http.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });

async function rig(asCookie: string | null) {
  let seen: http.IncomingHttpHeaders = {};
  const upstream = http.createServer((req, res) => { seen = req.headers; res.end('{}'); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
  servers.push(upstream);
  const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const app = express();
  app.use(createProxyMiddleware({ target, changeOrigin: true, on: { proxyReq: proxyReq => scrubProxyRequest(proxyReq, asCookie) } }));
  const proxy = await new Promise<http.Server>(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  servers.push(proxy);
  const port = (proxy.address() as { port: number }).port;
  return {
    send: () => new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/x', headers: {
        cookie: 'suveren_page_session=PAGE-COOKIE; other=1',
        'x-suveren-session': 'PAGE-TOKEN',
        'x-suveren-confirmation': 'CONFIRMATION-ID',
        'x-other': 'kept',
      } }, res => { res.resume(); res.on('end', () => resolve(seen)); });
      req.on('error', reject); req.end();
    }),
  };
}

describe('the /api proxy', () => {
  it('never forwards the page session secrets or the confirmation, and replaces the browser cookie with the AS session cookie', async () => {
    const h = await (await rig('hap-session=AS-SESSION')).send();
    expect(h['x-suveren-session']).toBeUndefined();
    expect(h['x-suveren-confirmation']).toBeUndefined();
    expect(h.cookie).toBe('hap-session=AS-SESSION');
    expect(h['x-other']).toBe('kept');
  });

  it('with no AS cookie it sends no Cookie at all (not the browser\'s, which holds the page session cookie)', async () => {
    const h = await (await rig(null)).send();
    expect(h.cookie).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain('PAGE-COOKIE');
    expect(JSON.stringify(h)).not.toContain('PAGE-TOKEN');
    expect(JSON.stringify(h)).not.toContain('CONFIRMATION-ID');
  });
});
