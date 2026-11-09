import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnreachableRetry, isRetriableRead, ATTEMPT_TIMEOUT_MS, WAIT_BETWEEN_TRIES_MS } from './unreachable-retry';

const ok = (body = 'fine') => new Response(body, { status: 200 });
const never = (signal: AbortSignal) => new Promise<Response>((_, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted')));
});

describe('UnreachableRetry', () => {
  let r: UnreachableRetry;
  beforeEach(() => { vi.useFakeTimers(); r = new UnreachableRetry(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a hung read is tried again silently and answers without telling anyone', async () => {
    const attempt = vi.fn().mockImplementationOnce(never).mockResolvedValueOnce(ok('second'));
    const p = r.read('/api/a', attempt);
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS);
    expect(await (await p).text()).toBe('second');
    expect(r.getState().waiting).toBe(false);
  });

  it('after two failures it says so, counts down, tries again and clears', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(new Response('', { status: 504 })).mockResolvedValueOnce(ok());
    const p = r.read('/api/a', attempt);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.getState().waiting).toBe(true);
    expect(r.getState().nextTryAt).toBe(Date.now() + WAIT_BETWEEN_TRIES_MS);
    await vi.advanceTimersByTimeAsync(WAIT_BETWEEN_TRIES_MS);
    await p;
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(r.getState()).toEqual({ waiting: false, nextTryAt: null });
  });

  it('an answer that is a refusal is an answer, not an outage', async () => {
    const attempt = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    expect((await r.read('/api/a', attempt)).status).toBe(403);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('polling during an outage shares one try, and every caller can read the body', async () => {
    let answer: (r: Response) => void = () => {};
    const attempt = vi.fn().mockImplementation(() => new Promise<Response>((res) => { answer = res; }));
    const a = r.read('/api/a', attempt);
    const b = r.read('/api/a', attempt);
    answer(ok('both'));
    expect(await (await a).text()).toBe('both');
    expect(await (await b).text()).toBe('both');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('"Try now" does not wait for the countdown', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(ok());
    const p = r.read('/api/a', attempt);
    await vi.advanceTimersByTimeAsync(0);
    r.tryNow();
    await p;
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('signing out ends the waiting', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('x'));
    const p = r.read('/api/a', attempt).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    r.cancelAll();
    expect(await p).toMatch(/Signed out/);
    expect(r.getState().waiting).toBe(false);
  });
});

describe('isRetriableRead', () => {
  it('covers reads from the server, not exports, files or local routes', () => {
    expect(isRetriableRead('/api/mandates/mine?status=active')).toBe(true);
    expect(isRetriableRead('/api/evidence-export')).toBe(false);
    expect(isRetriableRead('/api/report/export')).toBe(false);
    expect(isRetriableRead('/api/evidence/receipt/x/attachment-preview/y')).toBe(false);
    expect(isRetriableRead('/proposal-status/x/preview')).toBe(false);
  });
});
