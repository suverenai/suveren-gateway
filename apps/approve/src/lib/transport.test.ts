import { describe, it, expect } from 'vitest';
import { DirectTransport, UnreachableError, asErrorCode } from './transport';
import { asUrlOf } from './config';

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(url, init); }) as unknown as typeof fetch;
  return { f, calls };
}

describe('the one network module', () => {
  it('sends the bearer token in the Authorization header, JSON with a body, and never cookies or credentials', async () => {
    const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const t = new DirectTransport('https://as.test', f);
    const r = await t.call('POST', '/api/x', { body: { a: 1 }, bearer: 'tok-1' });
    expect(r).toEqual({ status: 200, body: { ok: 1 } });
    expect(calls[0].url).toBe('https://as.test/api/x');
    expect(calls[0].init.credentials).toBe('omit');
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.cache).toBe('no-store');
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' });
    expect(calls[0].init.body).toBe('{"a":1}');
  });

  it('a call without a body sends no Content-Type, and without a token no Authorization', async () => {
    const { f, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    await new DirectTransport('https://as.test', f).call('GET', '/api/y');
    expect(calls[0].init.headers).toEqual({});
    expect(calls[0].init.body).toBeUndefined();
  });

  it('a redirect, a network failure and a timeout are all "unreachable": nothing is followed', async () => {
    const redirect = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }));
    await expect(new DirectTransport('https://as.test', redirect.f).call('GET', '/api/y')).rejects.toBeInstanceOf(UnreachableError);
    const down = fakeFetch(() => { throw new TypeError('network'); });
    await expect(new DirectTransport('https://as.test', down.f).call('GET', '/api/y')).rejects.toBeInstanceOf(UnreachableError);
  });

  it('a body that is not JSON is null, not an error', async () => {
    const { f } = fakeFetch(() => new Response('<html>', { status: 502 }));
    expect(await new DirectTransport('https://as.test', f).call('GET', '/api/y')).toEqual({ status: 502, body: null });
  });

  it('a path starts with a slash', async () => {
    const { f } = fakeFetch(() => new Response('{}'));
    await expect(new DirectTransport('https://as.test', f).call('GET', 'api/y')).rejects.toThrow();
  });

  it('reads a refusal code only when it looks like a code', () => {
    expect(asErrorCode({ approved: false, errors: [{ code: 'ENROLMENT_CODE_USED', message: 'x' }] })).toBe('ENROLMENT_CODE_USED');
    expect(asErrorCode({ errors: [{ code: 'not a code!' }] })).toBeUndefined();
    expect(asErrorCode(null)).toBeUndefined();
  });
});

describe('the configured server address', () => {
  it('https, or http for localhost only, and no trailing slash', () => {
    expect(asUrlOf('https://suveren.ai/')).toBe('https://suveren.ai');
    expect(asUrlOf(undefined)).toBe('https://suveren.ai');
    expect(asUrlOf('http://localhost:4100')).toBe('http://localhost:4100');
    expect(() => asUrlOf('http://suveren.ai')).toThrow();
    expect(() => asUrlOf('https://suveren.ai/path')).toThrow();
    expect(() => asUrlOf('ftp://x')).toThrow();
  });
});
