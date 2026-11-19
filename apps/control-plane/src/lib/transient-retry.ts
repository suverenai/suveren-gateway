/**
 * Retry a step that failed on the NETWORK only — a reset, refused or broken connection, a timeout —
 * never on an answer the Authority Server gave and never on a pinning mismatch.
 *
 * Why: some steps run once per sign-in. The control plane registers its end-to-end key with the
 * Authority Server in the background after sign-in; a single reset connection there left the account
 * with no key until the next sign-in, and every proposal to it was refused ("No recipient … has a
 * registered end-to-end key"). Seen in suveren-e2e (read ECONNRESET on the first request), 2026-11-19.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CLOSED',
]);

/** A network-level failure worth trying again (fetch's TypeError with such a cause, or a timeout/abort). */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; cause?: unknown; message?: string };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  if (e.cause) return isTransientNetworkError(e.cause);
  return false;
}

export const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * Run `step`; when it throws a transient network error, wait and run it again, once per delay.
 * Any other error, and the last transient one, is thrown to the caller unchanged.
 */
export async function withTransientRetry<T>(
  step: () => Promise<T>,
  o: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const delays = o.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= delays.length || !isTransientNetworkError(err)) throw err;
      o.onRetry?.(attempt + 1, err);
      await sleep(delays[attempt]);
    }
  }
}
