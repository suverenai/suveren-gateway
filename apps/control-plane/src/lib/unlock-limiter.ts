/**
 * Rate limit for every place the unlock password is tried (unlock, change,
 * confirmation). One limiter for the whole gateway, not one per address: every
 * caller arrives from this machine, so an address means nothing.
 *
 * An attempt is counted BEFORE the password is checked (scrypt is slow, and
 * parallel guesses must not all be free), and forgiven on success. After
 * FREE_ATTEMPTS failures in a row the next attempts are refused without being
 * checked at all, for a time that doubles with each further failure.
 */

export const FREE_ATTEMPTS = 5;
export const BASE_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 15 * 60_000;
/** A quiet period this long, with no failure, forgets earlier failures. */
export const DECAY_MS = 30 * 60_000;

export type AttemptResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class UnlockLimiter {
  private failures = 0;
  private blockedUntil = 0;
  private lastFailureAt = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Call before checking a password. */
  begin(): AttemptResult {
    const t = this.now();
    if (t < this.blockedUntil) return { allowed: false, retryAfterSeconds: Math.ceil((this.blockedUntil - t) / 1000) };
    // Failures fade after a quiet period, so a stray wrong password last week
    // does not count against the person today (and a local process that provokes
    // failures can only ever cost the wait, never lock the owner out for good).
    if (this.failures > 0 && t - this.lastFailureAt >= DECAY_MS) this.failures = 0;
    this.lastFailureAt = t;
    // Counted as a failure until it succeeds, so parallel guesses all count.
    this.failures++;
    // The FREE_ATTEMPTS-th attempt is still allowed; the next one is not.
    if (this.failures >= FREE_ATTEMPTS) {
      const wait = Math.min(BASE_LOCKOUT_MS * 2 ** (this.failures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
      this.blockedUntil = t + wait;
    }
    return { allowed: true };
  }

  /** The password was right. */
  succeed(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }
}
