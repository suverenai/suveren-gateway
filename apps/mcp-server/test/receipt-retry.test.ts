/**
 * M3 (gateway side) — receipt pre-flight retry + idempotency-key reuse.
 *
 * The gateway generates one stable idempotencyKey per tool invocation and
 * passes it to SPClient.postReceipt. These tests pin the retry contract:
 *   - a transient failure (network error / 5xx) is retried with the SAME key,
 *     so the AS can dedup it and never double-count;
 *   - a lost response after the AS committed is recovered by the retry, which
 *     surfaces the ORIGINAL receipt;
 *   - a definitive rejection (4xx) is NEVER retried — the pre-flight fails
 *     closed on the first answer;
 *   - with no idempotencyKey, there is exactly one attempt (retrying blind
 *     would risk double-counting).
 *
 * globalThis.fetch is stubbed — this is a unit test of the client's retry
 * logic, not an integration test (the real AS dedup is covered by
 * hap-e2e/test/idempotency.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SPClient, SPReceiptError } from '../src/lib/sp-client';

const BASE = 'http://sp.test';

/** Build a fake fetch Response with a JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Pull the idempotencyKey out of a recorded fetch call's request body. */
function keyOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit;
  const parsed = JSON.parse(init.body as string) as { idempotencyKey?: string };
  return parsed.idempotencyKey;
}

const RECEIPT = (id: string, idempotent = false) => ({
  approved: true,
  idempotent,
  receipt: { id, cumulativeState: { daily: { amount: 10, count: 1 } } },
});

const baseArgs = {
  attestationHash: 'frame-abc',
  profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
  path: 'charge',
  action: 'charge__create',
  actionType: 'charge',
  executionContext: { amount: 10, currency: 'USD', action_type: 'charge' },
  amount: 10,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Zero backoff so the suite doesn't actually wait.
function client() {
  return new SPClient(BASE, { maxAttempts: 3, delaysMs: [0, 0] });
}

describe('M3 gateway — receipt retry + idempotency', () => {
  it('retries a network error and reuses the SAME idempotency key', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(201, RECEIPT('R1')));

    const out = await client().postReceipt({ ...baseArgs, idempotencyKey: 'idem-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(fetchMock.mock.calls[0])).toBe('idem-1');
    expect(keyOf(fetchMock.mock.calls[1])).toBe('idem-1'); // identical across the retry
    expect(out.receipt.id).toBe('R1');
  });

  it('recovers a lost response: retry surfaces the ORIGINAL receipt', async () => {
    // Attempt 1: the AS committed receipt R1 but the response was lost in
    // transit (modelled as a network throw). Attempt 2: the AS sees the same
    // key and returns the original receipt, marked idempotent.
    fetchMock
      .mockRejectedValueOnce(new TypeError('socket hang up'))
      .mockResolvedValueOnce(jsonResponse(200, RECEIPT('R1', true)));

    const out = await client().postReceipt({ ...baseArgs, idempotencyKey: 'idem-2' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.receipt.id).toBe('R1'); // not a second, freshly counted receipt
  });

  it('retries a 5xx and reuses the key, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: 'upstream unavailable' }))
      .mockResolvedValueOnce(jsonResponse(201, RECEIPT('R2')));

    const out = await client().postReceipt({ ...baseArgs, idempotencyKey: 'idem-3' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(fetchMock.mock.calls[0])).toBe('idem-3');
    expect(keyOf(fetchMock.mock.calls[1])).toBe('idem-3');
    expect(out.receipt.id).toBe('R2');
  });

  it('does NOT retry a definitive 4xx rejection (fails closed on first answer)', async () => {
    const rejection = {
      approved: false,
      errors: [{ code: 'LIMIT_EXCEEDED', message: 'Cumulative daily amount exceeds bound' }],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(403, rejection));

    await expect(
      client().postReceipt({ ...baseArgs, idempotencyKey: 'idem-4' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on a real rejection
  });

  it('does NOT retry an approval_required 409', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: 'approval_required', field: 'amount_daily_max' }),
    );

    await expect(
      client().postReceipt({ ...baseArgs, idempotencyKey: 'idem-5' }),
    ).rejects.toBeInstanceOf(SPReceiptError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes exactly ONE attempt when no idempotencyKey is supplied', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));

    await expect(client().postReceipt({ ...baseArgs })).rejects.toBeInstanceOf(TypeError);

    expect(fetchMock).toHaveBeenCalledTimes(1); // retrying blind would double-count
  });

  it('gives up after maxAttempts and throws the last transient error', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('down 1'))
      .mockRejectedValueOnce(new TypeError('down 2'))
      .mockRejectedValueOnce(new TypeError('down 3'));

    await expect(
      client().postReceipt({ ...baseArgs, idempotencyKey: 'idem-6' }),
    ).rejects.toThrow(/down 3/);

    expect(fetchMock).toHaveBeenCalledTimes(3); // maxAttempts
  });
});
