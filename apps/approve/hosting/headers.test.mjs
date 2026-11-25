import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cacheControlFor, contentSecurityPolicy, IMMUTABLE, NO_STORE, PERMISSIONS_POLICY, resolveServedPath, REVALIDATE, securityHeaders,
} from './headers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('phone app hosting headers (DEC-112)', () => {
  it('never caches index.html and sw.js; hashed assets are immutable; the rest is revalidated', () => {
    expect(cacheControlFor('/index.html')).toBe(NO_STORE);
    expect(cacheControlFor('/sw.js')).toBe(NO_STORE);
    expect(cacheControlFor('/assets/index-8rtM0BMJ.js')).toBe(IMMUTABLE);
    expect(cacheControlFor('/manifest.webmanifest')).toBe(REVALIDATE);
    expect(cacheControlFor('/fonts/Inter-Regular.woff2')).toBe(REVALIDATE);
    expect(cacheControlFor('/icons/icon-192.png')).toBe(REVALIDATE);
  });

  it('falls back to index.html only for paths without an extension; a missing file is a 404', () => {
    const files = new Set(['/index.html', '/sw.js', '/assets/a-1.js']);
    const has = (p) => files.has(p);
    expect(resolveServedPath('/', has)).toBe('/index.html');
    expect(resolveServedPath('/devices', has)).toBe('/index.html');
    expect(resolveServedPath('/r/abc123', has)).toBe('/index.html');
    expect(resolveServedPath('/assets/a-1.js', has)).toBe('/assets/a-1.js');
    expect(resolveServedPath('/assets/missing-2.js', has)).toBeNull();
    expect(resolveServedPath('/sw.js', has)).toBe('/sw.js');
  });

  it('the CSP allows only this origin and the Authority Server, never inline script or a frame', () => {
    const csp = contentSecurityPolicy('https://www.suveren.ai/some/path');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self' https://www.suveren.ai");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
  });

  it('sends the security headers on every response', () => {
    const h = securityHeaders('https://www.suveren.ai');
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d+/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(PERMISSIONS_POLICY).toContain('camera=(self)');
    expect(PERMISSIONS_POLICY).toContain('publickey-credentials-get=(self)');
    expect(PERMISSIONS_POLICY).toContain('microphone=()');
  });

  it('the hosting guide lists exactly these values (the guide and the code cannot drift)', () => {
    const guide = join(here, '..', '..', '..', 'docs', 'phone-app-hosting.md');
    expect(existsSync(guide)).toBe(true);
    const text = readFileSync(guide, 'utf8');
    for (const v of Object.values(securityHeaders('https://www.suveren.ai'))) expect(text).toContain(v);
    for (const v of [NO_STORE, IMMUTABLE, REVALIDATE]) expect(text).toContain(v);
  });
});
