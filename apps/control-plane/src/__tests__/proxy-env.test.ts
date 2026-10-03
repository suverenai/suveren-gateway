/**
 * proxy-env.ts — pure decision logic for corporate HTTP(S) proxy support.
 * No network, no undici: these are the predicates the task's real-proxy
 * smoke test (corporate-proxy.e2e.test.ts) depends on, tested directly so a
 * NO_PROXY/loopback regression is caught here rather than only as a flaky
 * network test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isLoopbackHostname, matchesNoProxy, readProxyEnv, selectProxyUrl } from '../lib/proxy-env';

const ENV_KEYS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

function setEnv(k: (typeof ENV_KEYS)[number], v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

describe('isLoopbackHostname', () => {
  it('REFUSAL-equivalent: every form of loopback is recognized, regardless of case/brackets', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('LOCALHOST')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.1.2.3')).toBe(true); // all of 127.0.0.0/8 is loopback
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true); // bracket form, as seen in a URL's hostname for IPv6
  });

  it('a real remote host, or a private-but-non-loopback address, is not loopback', () => {
    expect(isLoopbackHostname('example.com')).toBe(false);
    expect(isLoopbackHostname('as.suveren.ai')).toBe(false);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
    expect(isLoopbackHostname('192.168.1.1')).toBe(false);
    expect(isLoopbackHostname('1270.0.0.1')).toBe(false); // NOT 127.x — must not substring-match
  });
});

describe('readProxyEnv', () => {
  it('lower-case env wins when both cases are set (never merged)', () => {
    setEnv('HTTP_PROXY', 'http://upper.example:8080');
    setEnv('http_proxy', 'http://lower.example:8080');
    expect(readProxyEnv().http).toBe('http://lower.example:8080');
  });

  it('falls back to the upper-case variable when only it is set', () => {
    setEnv('HTTPS_PROXY', 'http://upper-only.example:8080');
    expect(readProxyEnv().https).toBe('http://upper-only.example:8080');
  });

  it('defaults noProxy to an empty string, never undefined', () => {
    expect(readProxyEnv().noProxy).toBe('');
  });
});

describe('matchesNoProxy', () => {
  it('exact host match', () => {
    expect(matchesNoProxy('internal.example', 443, 'internal.example')).toBe(true);
    expect(matchesNoProxy('other.example', 443, 'internal.example')).toBe(false);
  });

  it('suffix match via a leading dot or *.', () => {
    expect(matchesNoProxy('sub.internal.example', 443, '.internal.example')).toBe(true);
    expect(matchesNoProxy('sub.internal.example', 443, '*.internal.example')).toBe(true);
    expect(matchesNoProxy('notinternal.example', 443, '.internal.example')).toBe(false); // not a real subdomain
  });

  it('a bare "*" bypasses everything', () => {
    expect(matchesNoProxy('anything.example', 443, '*')).toBe(true);
  });

  it('comma/space separated list, case-insensitive', () => {
    expect(matchesNoProxy('FOO.example', 443, 'bar.example, foo.example  baz.example')).toBe(true);
  });

  it('a :port suffix restricts the match to that port', () => {
    expect(matchesNoProxy('internal.example', 8443, 'internal.example:443')).toBe(false);
    expect(matchesNoProxy('internal.example', 443, 'internal.example:443')).toBe(true);
  });

  it('empty NO_PROXY matches nothing', () => {
    expect(matchesNoProxy('internal.example', 443, '')).toBe(false);
  });
});

describe('selectProxyUrl — the one decision point', () => {
  it('no proxy env set at all: direct', () => {
    expect(selectProxyUrl('https://as.suveren.ai')).toBeUndefined();
  });

  it('HTTPS_PROXY applies to an https:// target', () => {
    setEnv('HTTPS_PROXY', 'http://proxy.corp.example:8080');
    expect(selectProxyUrl('https://as.suveren.ai')).toBe('http://proxy.corp.example:8080');
  });

  it('HTTP_PROXY applies to an http:// target; HTTPS_PROXY is ignored for it', () => {
    setEnv('HTTP_PROXY', 'http://http-proxy.corp.example:8080');
    setEnv('HTTPS_PROXY', 'http://https-proxy.corp.example:8080');
    expect(selectProxyUrl('http://internal.example/health')).toBe('http://http-proxy.corp.example:8080');
  });

  it('falls back to HTTP_PROXY for an https:// target when only HTTP_PROXY is set', () => {
    setEnv('HTTP_PROXY', 'http://only-http.corp.example:8080');
    expect(selectProxyUrl('https://as.suveren.ai')).toBe('http://only-http.corp.example:8080');
  });

  it('REFUSAL: a loopback target is NEVER proxied, even with a proxy configured and no NO_PROXY set', () => {
    setEnv('HTTPS_PROXY', 'http://proxy.corp.example:8080');
    setEnv('HTTP_PROXY', 'http://proxy.corp.example:8080');
    expect(selectProxyUrl('https://127.0.0.1:4100')).toBeUndefined();
    expect(selectProxyUrl('http://localhost:3431/internal/event')).toBeUndefined();
  });

  it('NO_PROXY excludes a specific host from an otherwise-configured proxy', () => {
    setEnv('HTTPS_PROXY', 'http://proxy.corp.example:8080');
    setEnv('NO_PROXY', 'as.suveren.ai');
    expect(selectProxyUrl('https://as.suveren.ai')).toBeUndefined();
    expect(selectProxyUrl('https://other.example')).toBe('http://proxy.corp.example:8080');
  });
});
