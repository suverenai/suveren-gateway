/**
 * Security review 2026-11: the helpers behind A1 (escaping), A2 (host guard on
 * every route), A5 (OAuth state) and B (one path, read one way). The real
 * requests against a running gateway are in suveren-e2e
 * (test/gateway-web-security.test.ts); this pins the rules themselves.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { escapeHtml, oauthResultPage } from '../lib/html-escape';
import { OAuthStateStore } from '../lib/oauth-state';
import { ambiguousPathReason, refuseAmbiguousPath, isApiPath } from '../middleware/request-path';
import { isAllowedHost, extraAllowedHosts } from '../middleware/host-guard';

describe('A1 — escaping', () => {
  it('escapes every character that can open markup or an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;',
    );
  });

  it('the OAuth result page never carries a caller value as markup', () => {
    const page = oauthResultPage('<img src=x onerror=alert(1)>', '<script>alert(1)</script>', 3000);
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Its own close timer stays.
    expect(page).toContain('<script>setTimeout(()=>window.close(),3000)</script>');
  });
});

describe('A5 — OAuth state', () => {
  it('a state answers once, for the connector it was issued for, with its redirect URI', () => {
    const s = new OAuthStateStore();
    const st = s.issue({ integrationId: 'linkedin', redirectUri: 'http://localhost:3400/auth/oauth/linkedin/callback' });
    expect(st.length).toBeGreaterThanOrEqual(40);
    expect(s.consume(st, 'linkedin')).toEqual({
      integrationId: 'linkedin',
      redirectUri: 'http://localhost:3400/auth/oauth/linkedin/callback',
    });
    expect(s.consume(st, 'linkedin')).toBeNull(); // single use
  });

  it('refuses a missing, unknown or foreign state, and spends a state used for the wrong connector', () => {
    const s = new OAuthStateStore();
    expect(s.consume(undefined, 'mail')).toBeNull();
    expect(s.consume('', 'mail')).toBeNull();
    expect(s.consume(['a', 'b'], 'mail')).toBeNull();
    expect(s.consume('made-up', 'mail')).toBeNull();
    const st = s.issue({ integrationId: 'calendar', redirectUri: 'r' });
    expect(s.consume(st, 'mail')).toBeNull();
    expect(s.consume(st, 'calendar')).toBeNull();
  });

  it('expires', () => {
    let now = 1_000;
    const s = new OAuthStateStore(60_000, () => now);
    const st = s.issue({ integrationId: 'mail', redirectUri: 'r' });
    now += 60_000;
    expect(s.consume(st, 'mail')).toBeNull();
  });

  it('two states are never equal', () => {
    const s = new OAuthStateStore();
    const a = s.issue({ integrationId: 'mail', redirectUri: 'r' });
    const b = s.issue({ integrationId: 'mail', redirectUri: 'r' });
    expect(a).not.toBe(b);
    expect(s.consume(a, 'mail')).not.toBeNull();
    expect(s.consume(b, 'mail')).not.toBeNull();
  });
});

describe('A2 — host guard allow list', () => {
  it('allows this machine, any IP literal, and names configured for it', () => {
    const none = new Set<string>();
    for (const h of ['localhost:3400', 'gateway.localhost', '127.0.0.1:7400', '127.0.0.2', '0.0.0.0:3000',
      '[::1]:3400', '[::ffff:127.0.0.1]:3400', '192.168.1.20:3400', '100.101.102.103', '172.17.0.2:3000']) {
      expect(isAllowedHost(h, none), h).toBe(true);
    }
    for (const h of ['evil.example', 'suveren:3000', 'mybox.local', 'localhost.evil.example', '', undefined]) {
      expect(isAllowedHost(h, none), String(h)).toBe(false);
    }
  });

  it('SUVEREN_ALLOWED_HOSTS and the host of SUVEREN_CP_INTERNAL_URL extend it', () => {
    const extra = extraAllowedHosts({
      SUVEREN_ALLOWED_HOSTS: ' MyBox.local , gateway.corp.example:443,',
      SUVEREN_CP_INTERNAL_URL: 'http://control-plane:3000',
    });
    expect([...extra].sort()).toEqual(['control-plane', 'gateway.corp.example', 'mybox.local']);
    for (const h of ['mybox.local:3400', 'gateway.corp.example', 'control-plane:3000']) {
      expect(isAllowedHost(h, extra), h).toBe(true);
    }
    expect(isAllowedHost('evil.example', extra)).toBe(false);
  });
});

describe('B — one path, read one way', () => {
  it('refuses every path two parsers could read differently', () => {
    for (const p of ['/api\\as\\pubkey', '/api%5Cas%5Cpubkey', '/api%5cx', '//api/x', '/api/../vault/x',
      '/api/%2e%2e/vault', '/api/./x', 'http://localhost:3400/api/x', '*']) {
      expect(ambiguousPathReason(p), p).not.toBeNull();
    }
  });

  it('lets ordinary paths and queries through', () => {
    for (const p of ['/', '/api/as/pubkey', '/api/proposals/abc/approve?x=1', '/auth/oauth/mail/callback?state=a&code=b%2Fc',
      '/assets/index-abc123.js', '/api', '/q?path=a\\b', '/a%20b']) {
      expect(ambiguousPathReason(p), p).toBeNull();
    }
  });

  it('/apix is not an /api path', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/as/pubkey')).toBe(true);
    expect(isApiPath('/apix')).toBe(false);
    expect(isApiPath('/ap')).toBe(false);
    expect(isApiPath(null)).toBe(false);
  });

  /**
   * The wire boundary: Express and http-proxy-middleware are the two parsers,
   * so this runs both, wired the way index.ts wires them, against a stand-in
   * upstream that only records what reached it.
   */
  it('with the gateway wiring, no unauthenticated request reaches the upstream', async () => {
    const reached: string[] = [];
    const upstream = express();
    upstream.use((req, res) => { reached.push(req.url); res.status(200).json({ upstream: true }); });
    const up = upstream.listen(0, '127.0.0.1');
    await new Promise(r => up.once('listening', r));
    const upPort = (up.address() as AddressInfo).port;

    const guard: express.RequestHandler = (req, res, next) => {
      if (req.headers['x-api-key'] !== 'k') { res.status(401).json({ error: 'Unauthorized' }); return; }
      next();
    };
    const app = express();
    app.use(refuseAmbiguousPath);
    app.use('/api', guard);
    const proxy = createProxyMiddleware({
      target: `http://127.0.0.1:${upPort}`,
      changeOrigin: true,
      pathFilter: (pathname: string) => isApiPath(pathname),
    });
    app.use((req, res, next) => {
      if (!isApiPath(req.path)) { next(); return; }
      guard(req, res, () => { void proxy(req, res, next); });
    });
    app.use((_req, res) => { res.status(404).send('not found'); });
    const gw = app.listen(0, '127.0.0.1');
    await new Promise(r => gw.once('listening', r));
    const gwPort = (gw.address() as AddressInfo).port;

    const raw = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const r = httpRequest({ host: '127.0.0.1', port: gwPort, path, method: 'GET', headers }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        r.on('error', reject);
        r.end();
      });

    try {
      expect(await raw('/api\\as\\pubkey')).toBe(400);
      expect(await raw('/api%5Cas%5Cpubkey')).toBe(400);
      expect(await raw('//api/as/pubkey')).toBe(400);
      expect(await raw('/apix')).toBe(404);
      expect(await raw('/api/as/pubkey')).toBe(401);
      expect(reached).toEqual([]);
      // And the authenticated path still works.
      expect(await raw('/api/as/pubkey', { 'x-api-key': 'k' })).toBe(200);
      expect(reached).toEqual(['/api/as/pubkey']);
    } finally {
      gw.close();
      up.close();
    }
  });
});
