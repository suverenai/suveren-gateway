import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { spClient, sessionEvents, SESSION_GONE_EVENT, ConfirmationCancelled, type SessionGoneDetail } from './sp-client';
import { SseParser } from './sse-parse';
import { accessFromProbe, LEGACY, afterUnlock, offerSetUp, sessionEndText } from './access';
import { T } from './device-texts';

type Call = { path: string; headers: Record<string, string>; init?: RequestInit };
const original = globalThis.fetch;
let calls: Call[] = [];
function stub(handler: (path: string, headers: Record<string, string>) => { status?: number; body?: unknown }) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    calls.push({ path, headers, init });
    const a = handler(path, headers);
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}
beforeEach(() => { spClient.clearApiKey(); spClient.setSessionToken(null); spClient.setConfirmer(null); });
afterEach(() => { globalThis.fetch = original; });

describe('a gateway without an unlock password: today\'s page, byte for byte on the wire', () => {
  it('sends the account key and nothing of the page session', async () => {
    stub(() => ({ body: { configured: false } }));
    spClient.setApiKey('hap_sk_test');
    await spClient.getCredential('gmail');
    expect(calls[0].headers).toEqual({ 'Content-Type': 'application/json', 'X-API-Key': 'hap_sk_test' });
    expect(Object.keys(calls[0].headers).map(k => k.toLowerCase())).not.toContain('x-suveren-session');
  });

  it('opens an OAuth sign-in at the plain start address, with no ticket call', async () => {
    stub(() => ({}));
    expect(await spClient.oauthStartUrl('gmail')).toBe('/auth/oauth/gmail/start');
    expect(calls).toHaveLength(0);
  });

  it('a 401 is the old plain event (no detail), and only for a signed-in call outside /auth', async () => {
    stub(() => ({ status: 401, body: { code: 'session_idle' } }));
    spClient.setApiKey('k');
    const seen: Event[] = [];
    const on = (e: Event) => seen.push(e);
    sessionEvents.addEventListener(SESSION_GONE_EVENT, on);
    await spClient.request('/api/groups');
    await spClient.request('/auth/login');
    sessionEvents.removeEventListener(SESSION_GONE_EVENT, on);
    expect(seen).toHaveLength(1);
    expect(seen[0] instanceof CustomEvent).toBe(false);
  });

  it('a credential change goes out once, with no confirmation header', async () => {
    stub(() => ({ body: { ok: true } }));
    spClient.setApiKey('k');
    await spClient.setCredential('gmail', { clientId: 'x' });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).not.toHaveProperty('X-Suveren-Confirmation');
  });

  it('a 403 on a credential change stays an error: nothing asks for a confirmation', async () => {
    stub(() => ({ status: 403, body: { code: 'confirmation_required', kind: 'replace', name: 'gmail' } }));
    spClient.setApiKey('k');
    await expect(spClient.setCredential('gmail', { a: 'b' })).rejects.toThrow('Failed to save credential: 403');
  });
});

describe('a gateway with a page session', () => {
  it('sends the header token on every request', async () => {
    stub(() => ({ body: {} }));
    spClient.setSessionToken('tok123');
    await spClient.request('/api/groups');
    await spClient.request('/auth/device/status');
    expect(calls.map(c => c.headers['X-Suveren-Session'])).toEqual(['tok123', 'tok123']);
    expect(spClient.hasPageSession()).toBe(true);
  });

  it('a 401 says why the session ended, on any path, for the session codes only', async () => {
    const details: string[] = [];
    const on = (e: Event) => details.push((e as CustomEvent<SessionGoneDetail>).detail.code);
    sessionEvents.addEventListener(SESSION_GONE_EVENT, on);
    spClient.setSessionToken('t');
    for (const code of ['session_idle', 'session_expired', 'session_missing', 'locked']) {
      stub(() => ({ status: 401, body: { error: 'Unauthorized', code } }));
      await spClient.request('/api/groups');
    }
    stub(() => ({ status: 401, body: { code: 'unauthorized', reason: 'session_idle' } }));
    await spClient.request('/auth/device/status'); // the device routers name the reason beside `unauthorized`
    stub(() => ({ status: 401, body: { code: 'wrong_password' } }));
    await spClient.request('/auth/unlock', { method: 'POST' }); // a wrong password is the unlock screen's own error
    sessionEvents.removeEventListener(SESSION_GONE_EVENT, on);
    expect(details).toEqual(['session_idle', 'session_expired', 'session_missing', 'locked', 'session_idle']);
  });

  it('OAuth starts from a one-time ticket', async () => {
    stub(() => ({ body: { url: '/auth/oauth/gmail/start?ticket=abc' } }));
    spClient.setSessionToken('t');
    expect(await spClient.oauthStartUrl('gmail')).toBe('/auth/oauth/gmail/start?ticket=abc');
    expect(calls[0].path).toBe('/auth/oauth/gmail/start-ticket');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('a stored sign-in asks for the confirmation of THAT change, then repeats the call with the confirmed request', async () => {
    let n = 0;
    stub((path, headers) => {
      if (path.endsWith('/start-ticket')) {
        n++;
        return n === 1
          ? { status: 403, body: { code: 'confirmation_required', kind: 'replace', name: 'gmail' } }
          : { body: { url: '/auth/oauth/gmail/start?ticket=zzz' } };
      }
      if (path.includes('/change')) return { body: { change: { route: 'oauth', op: 'sign-in', replaces: ['gmail'] } } };
      return { body: {} };
    });
    spClient.setSessionToken('t');
    const asked: unknown[] = [];
    spClient.setConfirmer(async ask => { asked.push(ask); return 'req-1'; });
    expect(await spClient.oauthStartUrl('gmail')).toContain('ticket=zzz');
    expect(asked).toEqual([{ kind: 'replace', name: 'gmail', change: { route: 'oauth', op: 'sign-in', replaces: ['gmail'] } }]);
    const last = calls[calls.length - 1];
    expect(last.headers['X-Suveren-Confirmation']).toBe('req-1');
  });

  it('a credential change repeats once with the confirmation, hashing the same fields', async () => {
    let first = true;
    stub((_p, headers) => {
      if (first) { first = false; return { status: 403, body: { code: 'confirmation_required', kind: 'replace', name: 'gmail' } }; }
      expect(headers['X-Suveren-Confirmation']).toBe('req-9');
      return { body: { ok: true } };
    });
    spClient.setSessionToken('t');
    let asked: unknown;
    spClient.setConfirmer(async a => { asked = a; return 'req-9'; });
    await spClient.setCredential('gmail', { clientId: 'x' });
    expect(asked).toEqual({ kind: 'replace', name: 'gmail', change: { route: 'credentials', op: 'put-merge', fields: { clientId: 'x' } } });
    expect(calls).toHaveLength(2);
  });

  it('cancelling the confirmation sends nothing more', async () => {
    stub(() => ({ status: 403, body: { code: 'confirmation_required', kind: 'remove', name: 'gmail' } }));
    spClient.setSessionToken('t');
    spClient.setConfirmer(async () => null);
    await expect(spClient.setCredential('gmail', { a: 'b' })).rejects.toBeInstanceOf(ConfirmationCancelled);
    expect(calls).toHaveLength(1);
  });

  it('a decision refused on the device path reads in the page\'s words; a legacy refusal keeps today\'s reading', async () => {
    stub(() => ({ status: 409, body: { error: 'content_mismatch', code: 'content_mismatch', message: 'placeholder' } }));
    spClient.setSessionToken('t');
    spClient.setDeviceDecisions(true);
    await expect(spClient.approveProposal('p1')).rejects.toThrow('What this page shows is not what was sent');
    spClient.setDeviceDecisions(false);
    stub(() => ({ status: 409, body: { error: 'Already decided' } }));
    await expect(spClient.approveProposal('p1')).rejects.toThrow('Already decided');
  });

  it('the page asks whether decisions are signed here once it has its session', async () => {
    stub(() => ({ body: { ok: true, deviceKeys: true } }));
    spClient.setSessionToken('t');
    expect(await spClient.detectDeviceDecisions()).toBe(true);
    expect(calls[0].path).toBe('/device-decision/status');
    expect(calls[0].headers['X-Suveren-Session']).toBe('t');
    spClient.setDeviceDecisions(false);
  });

  it('the event stream is opened with the session header (fetch, not EventSource)', async () => {
    stub(() => ({ body: {} }));
    spClient.setSessionToken('t');
    await spClient.openEventStream(new AbortController().signal);
    expect(calls[0].path).toBe('/events');
    expect(calls[0].headers['X-Suveren-Session']).toBe('t');
    expect(calls[0].headers.Accept).toBe('text/event-stream');
  });
});

describe('a switch-off gateway behind the single-page fallback', () => {
  it('a 200 index.html for /auth/password/status is today\'s page: not switch on, no password offer', async () => {
    const { DeviceClient } = await import('./device-client');
    const c = new DeviceClient(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const s = accessFromProbe(await c.passwordStatus());
    expect(s).toEqual(LEGACY);
    expect(offerSetUp(s, true)).toBe(false);
  });
});

describe('SseParser', () => {
  it('a "\\r\\n" split across two chunks is one line break', () => {
    const p = new SseParser();
    expect(p.push('event: x\r')).toEqual([]);
    expect(p.push('\ndata: 1\r\n\r\n')).toEqual([{ event: 'x', data: '1' }]);
  });
  it('reads named events across chunks, ignores comments', () => {
    const p = new SseParser();
    expect(p.push(': ping\n\nevent: proposal-add')).toEqual([]);
    expect(p.push('ed\ndata: {"a":1}\n\nevent: x\r\ndata: y\r\n\r\n')).toEqual([
      { event: 'proposal-added', data: '{"a":1}' },
      { event: 'x', data: 'y' },
    ]);
  });
  it('joins multi-line data and defaults the event name', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});

describe('access: which way in', () => {
  it('switch off (404), network failure or an unreadable answer: today\'s page', () => {
    expect(accessFromProbe({ ok: false, code: 'bad_request', status: 404, extra: {} })).toEqual(LEGACY);
    expect(accessFromProbe({ ok: false, code: 'gateway_unreachable', status: 0, extra: {} })).toEqual(LEGACY);
    expect(accessFromProbe({ ok: true, status: 200, data: {} as never })).toEqual(LEGACY);
    expect(accessFromProbe({ ok: true, status: 200, data: { passwordSet: 'yes' } as never })).toEqual(LEGACY);
  });
  it('switch on without a password: still the account key, and the password is offered once after the sign-in', () => {
    const s = accessFromProbe({ ok: true, status: 200, data: { passwordSet: false } });
    expect(s).toEqual({ access: 'legacy', switchOn: true, passwordSet: false });
    expect(offerSetUp(s, true)).toBe(true);
    expect(offerSetUp(s, false)).toBe(false);
    expect(offerSetUp(LEGACY, true)).toBe(false); // switch off: never offered
  });
  it('a password: the page signs in with the password', () => {
    const s = accessFromProbe({ ok: true, status: 200, data: { passwordSet: true } });
    expect(s.access).toBe('password');
    expect(offerSetUp(s, true)).toBe(false);
  });
  it('after the unlock', () => {
    expect(afterUnlock({ setUp: true, signedIn: true })).toBe('in');
    expect(afterUnlock({ setUp: true, signedIn: false })).toBe('sign-in');
    expect(afterUnlock({ setUp: false, signedIn: false })).toBe('account-key');
  });
  it('why the session ended', () => {
    expect(sessionEndText('session_idle')).toBe(T.sessionIdle);
    expect(sessionEndText(null)).toBeNull();
  });
});
