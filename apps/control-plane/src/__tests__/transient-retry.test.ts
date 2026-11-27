/**
 * withTransientRetry: a one-shot step (the E2EE key registration after sign-in) survives a reset
 * connection, but never repeats on an answer or a pinning error. No timers: sleep is injected.
 */
import { describe, it, expect } from 'vitest';
import { withTransientRetry, isTransientNetworkError } from '../lib/transient-retry';

const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
const noSleep = async () => {};

describe('withTransientRetry', () => {
  it('retries a reset connection and returns the later success', async () => {
    let calls = 0;
    const out = await withTransientRetry(async () => { calls += 1; if (calls < 3) throw reset(); return 'ok'; }, { sleep: noSleep });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the last delay and throws the network error', async () => {
    let calls = 0;
    await expect(withTransientRetry(async () => { calls += 1; throw reset(); }, { delaysMs: [1, 1], sleep: noSleep })).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('never repeats a non-network error (an answer, a pin mismatch)', async () => {
    let calls = 0;
    class AsTlsMismatchError extends Error {}
    await expect(withTransientRetry(async () => { calls += 1; throw new AsTlsMismatchError('pin'); }, { sleep: noSleep })).rejects.toThrow('pin');
    expect(calls).toBe(1);
    expect(isTransientNetworkError(new Error('HTTP 500'))).toBe(false);
  });

  it('counts timeouts and nested undici causes as transient', () => {
    expect(isTransientNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
    expect(isTransientNetworkError(reset())).toBe(true);
  });
});
