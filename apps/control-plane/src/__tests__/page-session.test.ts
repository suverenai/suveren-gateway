/**
 * Page session limits (DEC-47) with the clock moved: one hour without use,
 * 12 hours whatever the use, a restart, and the OS lock / sleep / user-switch
 * signal. Plus which requests count as use, and the Origin / Host rule.
 */
import { describe, it, expect } from 'vitest';
import {
  PageSessions, IDLE_LIMIT_MS, MAX_LIFETIME_MS, createOsSignalHook,
  classifyRequest, checkOriginAndHost, parseCookie, sessionCookieHeader,
} from '../lib/page-session';

const MIN = 60_000;
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('PageSessions', () => {
  it('needs the cookie AND the header token', () => {
    const s = new PageSessions();
    const { cookie, token } = s.open();
    expect(s.validate(cookie, token, true)).toEqual({ ok: true });
    expect(s.validate(cookie, undefined, true)).toMatchObject({ ok: false });
    expect(s.validate(undefined, token, true)).toMatchObject({ ok: false });
    expect(s.validate(cookie, 'x'.repeat(43), true)).toMatchObject({ ok: false, reason: 'session_invalid' });
    expect(s.validate('x'.repeat(43), token, true)).toMatchObject({ ok: false, reason: 'session_invalid' });
    // the cookie value is not the token
    expect(s.validate(cookie, cookie, true)).toMatchObject({ ok: false });
  });

  it('ends after an hour without use', () => {
    const c = clock();
    const s = new PageSessions({ now: c.now });
    const { cookie, token } = s.open();
    c.advance(IDLE_LIMIT_MS - MIN);
    expect(s.validate(cookie, token, true)).toEqual({ ok: true });
    c.advance(IDLE_LIMIT_MS + MIN);
    expect(s.validate(cookie, token, true)).toEqual({ ok: false, reason: 'session_idle' });
    // and stays ended
    expect(s.validate(cookie, token, true)).toMatchObject({ ok: false });
  });

  it('polling for an hour does not keep it open', () => {
    const c = clock();
    const s = new PageSessions({ now: c.now });
    const { cookie, token } = s.open();
    // a passive request every 5 minutes for 59 minutes: all fine
    for (let i = 0; i < 11; i++) { c.advance(5 * MIN); expect(s.validate(cookie, token, false)).toEqual({ ok: true }); }
    // an hour after open, the next passive request is refused, and so is a real one
    c.advance(5 * MIN);
    expect(s.validate(cookie, token, false)).toEqual({ ok: false, reason: 'session_idle' });
    expect(s.validate(cookie, token, true)).toMatchObject({ ok: false });
  });

  it('a person\'s action restarts the idle clock', () => {
    const c = clock();
    const s = new PageSessions({ now: c.now });
    const { cookie, token } = s.open();
    for (let i = 0; i < 10; i++) { c.advance(50 * MIN); expect(s.validate(cookie, token, true)).toEqual({ ok: true }); }
  });

  it('ends after 12 hours whatever the use', () => {
    const c = clock();
    const s = new PageSessions({ now: c.now });
    const { cookie, token } = s.open();
    let last: ReturnType<typeof s.validate> = { ok: true };
    for (let spent = 0; spent < MAX_LIFETIME_MS + 30 * MIN; spent += 30 * MIN) {
      c.advance(30 * MIN);
      last = s.validate(cookie, token, true);
      if (!last.ok) break;
    }
    expect(last).toEqual({ ok: false, reason: 'session_expired' });
    expect(c.now() - 1_000_000).toBeLessThanOrEqual(MAX_LIFETIME_MS + 30 * MIN);
  });

  it('a verified check restarts the 12-hour clock', () => {
    const c = clock();
    const s = new PageSessions({ now: c.now });
    const { cookie, token } = s.open();
    const useFor = (hours: number) => { for (let i = 0; i < hours * 2; i++) { c.advance(30 * MIN); expect(s.validate(cookie, token, true)).toEqual({ ok: true }); } };
    useFor(11);
    s.recordCheck(cookie);
    useFor(11); // 22 hours in all, ended by neither limit
  });

  it('a restart (a new process) knows no session', () => {
    const before = new PageSessions();
    const { cookie, token } = before.open();
    const after = new PageSessions();
    expect(after.validate(cookie, token, true)).toMatchObject({ ok: false, reason: 'session_invalid' });
  });

  it('screen lock, sleep and user switch each end every session (simulated OS signal)', () => {
    for (const signal of ['screen-lock', 'sleep', 'user-switch'] as const) {
      const s = new PageSessions();
      const a = s.open();
      const b = s.open();
      createOsSignalHook(s, () => {})(signal);
      expect(s.count()).toBe(0);
      expect(s.validate(a.cookie, a.token, true)).toMatchObject({ ok: false });
      expect(s.validate(b.cookie, b.token, true)).toMatchObject({ ok: false });
    }
  });
});

describe('clocks', () => {
  it('turning the wall clock back does not extend a session (the monotonic clock still counts)', () => {
    let mono = 0, wall = 1_000_000;
    const s = new PageSessions({ clock: { mono: () => mono, wall: () => wall } });
    const { cookie, token } = s.open();
    mono += IDLE_LIMIT_MS + MIN;
    wall -= 24 * 60 * MIN; // set back a day
    expect(s.validate(cookie, token, true)).toEqual({ ok: false, reason: 'session_idle' });
  });

  it('a sleep that stops the monotonic clock does not extend a session (the wall clock jumped)', () => {
    let mono = 0, wall = 1_000_000;
    const s = new PageSessions({ clock: { mono: () => mono, wall: () => wall } });
    const { cookie, token } = s.open();
    wall += MAX_LIFETIME_MS + MIN; // slept; mono stood still
    expect(s.validate(cookie, token, false)).toEqual({ ok: false, reason: 'session_expired' });
  });
});

describe('watching a session end', () => {
  it('tells a watcher when the session ends by idle limit, by 12 hours, and by lock; not before', () => {
    const c = clock();
    const s = new PageSessions({ now: c.now });
    const a = s.open(), b = s.open(), d = s.open();
    const ended: string[] = [];
    s.watch(a.cookie, () => ended.push('idle'));
    s.watch(b.cookie, () => ended.push('b'));
    s.watch(d.cookie, () => ended.push('lock'));
    c.advance(30 * MIN);
    s.validate(b.cookie, b.token, true); s.validate(d.cookie, d.token, true);
    s.expireDue();
    expect(ended).toEqual([]);
    c.advance(31 * MIN);          // a: 61 min idle; b, d: 31
    s.expireDue();
    expect(ended).toEqual(['idle']);
    s.endAll();
    expect(ended.sort()).toEqual(['b', 'idle', 'lock']);
  });
});

describe('which requests count as use', () => {
  it('counts a person\'s action', () => {
    for (const [m, p] of [
      ['POST', '/api/decrypt-proposal-content'], ['POST', '/api/mandate'], ['PUT', '/vault/credentials/gmail'],
      ['DELETE', '/vault/credentials/gmail'], ['POST', '/auth/logout'], ['PATCH', '/api/anything'],
      ['GET', '/proposal-status/abc/preview'], ['GET', '/proposal-status/abc/request-context'],
      ['GET', '/proposal-status/abc/attachment-preview/deadbeef'],
    ]) expect(classifyRequest(m, p), `${m} ${p}`).toBe('use');
  });

  it('never counts polling, the event stream or status calls', () => {
    for (const [m, p] of [
      ['GET', '/events'], ['GET', '/health'], ['GET', '/vault/status'], ['GET', '/api/proposals'],
      ['GET', '/api/authorizations'], ['GET', '/proposal-status/abc/outcome'], ['GET', '/proposal-status/abc/shown-snapshot'],
      ['GET', '/auth/oauth/gmail/health'], ['GET', '/mcp/status'], ['HEAD', '/health'], ['OPTIONS', '/api/x'],
      ['GET', '/api/tickets-seen'],
    ]) expect(classifyRequest(m, p), `${m} ${p}`).toBe('passive');
  });
});

describe('Origin and Host', () => {
  const host = '127.0.0.1:3402';
  it('accepts this server\'s own origin and a plain GET without one', () => {
    expect(checkOriginAndHost('POST', host, `http://${host}`)).toBe(true);
    expect(checkOriginAndHost('GET', host, undefined)).toBe(true);
    expect(checkOriginAndHost('GET', 'localhost:3402', 'http://localhost:3402')).toBe(true);
    expect(checkOriginAndHost('GET', '[::1]:3402', 'http://[::1]:3402')).toBe(true);
  });
  it('refuses a foreign or other-port Origin, a missing Origin on a change, and a foreign or missing Host', () => {
    expect(checkOriginAndHost('POST', host, 'http://evil.example')).toBe(false);
    expect(checkOriginAndHost('GET', host, 'http://127.0.0.1:3401')).toBe(false);   // another port on the same host
    expect(checkOriginAndHost('POST', host, 'null')).toBe(false);
    expect(checkOriginAndHost('POST', host, undefined)).toBe(false);
    expect(checkOriginAndHost('GET', 'evil.example:3402', 'http://evil.example:3402')).toBe(false);
    expect(checkOriginAndHost('GET', '192.168.1.5:3402', undefined)).toBe(false);
    expect(checkOriginAndHost('GET', undefined, undefined)).toBe(false);
  });
});

describe('cookie', () => {
  it('is HttpOnly, SameSite=Strict, host-only (no Domain) and not persistent', () => {
    const h = sessionCookieHeader('abc');
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Strict');
    expect(h.toLowerCase()).not.toContain('domain');
    expect(h.toLowerCase()).not.toContain('expires');
    expect(h.toLowerCase()).not.toContain('max-age');
  });
  it('is read from a cookie header', () => {
    expect(parseCookie('a=1; suveren_page_session=xyz; b=2', 'suveren_page_session')).toBe('xyz');
    expect(parseCookie(undefined, 'a')).toBeUndefined();
  });
});
