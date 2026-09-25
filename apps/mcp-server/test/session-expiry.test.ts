/**
 * Gateway sessions now last up to 30 days on the Authority Server side, and
 * are revoked earlier on suspension/deletion/key change — so a 401 can land
 * at any time, not just "never logged in". SPClient must tell the difference:
 *
 *  - a 401 while a session WAS active means the session ended → clear the
 *    cookie immediately (so every other in-flight/subsequent call also reads
 *    "locked" without waiting on a round trip) and tell the control plane
 *    ONCE, no matter how many concurrent calls hit the same dead cookie.
 *  - a network error or a 5xx is NOT a lock — SPClient keeps today's
 *    fail-closed behaviour and says nothing to the control plane.
 *
 * `globalThis.fetch` is stubbed for both the AS calls SPClient makes AND the
 * fire-and-forget ping to the control plane (cp-notify uses the same global),
 * so calls are told apart by URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SPClient, SPReceiptError } from '../src/lib/sp-client';

const BASE = 'http://sp.test';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let notifyCalls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  notifyCalls = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/internal/event')) {
      notifyCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`unexpected fetch to ${url} — configure a response first`);
  });
  vi.stubGlobal('fetch', fetchMock);
  process.env.SUVEREN_INTERNAL_SECRET = 'test-secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUVEREN_INTERNAL_SECRET;
});

/** Route one specific AS call to a canned response, leaving cp-notify's mock alone. */
function mockAsCall(path: string, response: Response) {
  fetchMock.mockImplementationOnce(async (url: string) => {
    expect(url).toBe(`${BASE}${path}`);
    return response;
  });
}

describe('SPClient — session-end detection', () => {
  it('a 401 while a session was active clears the cookie and reports "expired"', async () => {
    const client = new SPClient(BASE);
    client.setSessionCookie('hap-session=abc');
    expect(client.isUnlocked()).toBe(true);

    mockAsCall('/api/attestations?authorization_id=x', jsonResponse(401, { error: 'Authentication required' }));

    await expect(client.getAttestations('x')).rejects.toThrow();

    expect(client.isUnlocked()).toBe(false);
    expect(client.getLockReason()).toBe('expired');
  });

  it('notifies the control plane exactly once for several concurrent 401s', async () => {
    const client = new SPClient(BASE);
    client.setSessionCookie('hap-session=abc');

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/internal/event')) {
        notifyCalls.push({ url, body: null });
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(401, { error: 'Authentication required' });
    });

    // Several tool calls in flight under the same now-dead cookie.
    await Promise.allSettled([
      client.getAttestations('a'),
      client.getPendingAttestations('charge'),
      client.getAuthorizationSummary('b'),
    ]);

    expect(notifyCalls).toHaveLength(1);
  });

  it('a 401 with no prior session is not a "session ended" event', async () => {
    const client = new SPClient(BASE); // never logged in — sessionCookie is ''
    expect(client.isUnlocked()).toBe(false);

    mockAsCall('/api/attestations?authorization_id=x', jsonResponse(401, { error: 'no cookie' }));
    await expect(client.getAttestations('x')).rejects.toThrow();

    expect(client.getLockReason()).toBeNull();
    expect(notifyCalls).toHaveLength(0);
  });

  it('a network error does NOT lock — fail-closed as before, nothing reported', async () => {
    const client = new SPClient(BASE);
    client.setSessionCookie('hap-session=abc');

    fetchMock.mockImplementationOnce(async () => { throw new TypeError('network down'); });

    await expect(client.getAttestations('x')).rejects.toThrow('network down');

    expect(client.isUnlocked()).toBe(true); // still holds its session
    expect(client.getLockReason()).toBeNull();
    expect(notifyCalls).toHaveLength(0);
  });

  it('a 5xx does NOT lock', async () => {
    const client = new SPClient(BASE);
    client.setSessionCookie('hap-session=abc');

    mockAsCall('/api/attestations?authorization_id=x', jsonResponse(500, { error: 'upstream down' }));
    await expect(client.getAttestations('x')).rejects.toThrow();

    expect(client.isUnlocked()).toBe(true);
    expect(client.getLockReason()).toBeNull();
    expect(notifyCalls).toHaveLength(0);
  });

  it('postReceipt (the ticket pre-flight) surfaces SPReceiptError with statusCode 401 and locks', async () => {
    const client = new SPClient(BASE, { maxAttempts: 3, delaysMs: [0, 0] });
    client.setSessionCookie('hap-session=abc');

    mockAsCall('/api/as/receipt', jsonResponse(401, { error: 'Authentication required' }));

    await expect(
      client.postReceipt({
        authorizationId: 'authz_1',
        profileId: 'p@0.1',
        action: 'charge__create',
        executionContext: { amount: 1 },
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ statusCode: 401 } as Partial<SPReceiptError>);

    // Fail-closed on a definitive 4xx — no retry, exactly one AS call.
    expect(fetchMock.mock.calls.filter(c => !String(c[0]).includes('/internal/event'))).toHaveLength(1);
    expect(client.isUnlocked()).toBe(false);
    expect(client.getLockReason()).toBe('expired');
  });

  it('a fresh login (setSessionCookie) clears a prior "expired" reason', async () => {
    const client = new SPClient(BASE);
    client.setSessionCookie('hap-session=abc');
    mockAsCall('/api/attestations?authorization_id=x', jsonResponse(401, {}));
    await expect(client.getAttestations('x')).rejects.toThrow();
    expect(client.getLockReason()).toBe('expired');

    client.setSessionCookie('hap-session=new');
    expect(client.isUnlocked()).toBe(true);
    expect(client.getLockReason()).toBeNull();
  });

  it('clearSession() (the control-plane push) locks unconditionally, without waiting for a 401', async () => {
    const client = new SPClient(BASE);
    client.setSessionCookie('hap-session=abc');
    client.clearSession();
    expect(client.isUnlocked()).toBe(false);
    expect(client.getLockReason()).toBe('expired');
  });
});
