/**
 * Fires a callback once the AS session's `sessionExpiresAt` arrives, so the
 * human learns the gateway is about to lock before an agent hits a 401.
 *
 * Two mechanisms, because either alone is unreliable:
 *
 *  - A PRECISE timer for the exact moment. `setTimeout`'s delay is a signed
 *    32-bit int (~24.8 days) — shorter than the 30-day session this exists
 *    for — so a delay beyond that re-arms itself in MAX-sized chunks rather
 *    than the platform silently truncating it (Node fires an overflowing
 *    delay almost immediately, which would lock the gateway a month early).
 *  - A COARSE periodic re-check, because a laptop that was asleep across the
 *    precise moment needs something that just asks "is it time yet?" on
 *    wake, rather than trusting a timer that was paused along with the OS.
 *
 * `onExpired` is expected to be the session-lock's `lockExpiredSession()`,
 * which is itself a no-op once the vault is already locked — so both
 * mechanisms catching the same expiry is harmless, not a double-lock.
 */

export interface SchedulerOptions {
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** How often the coarse re-check runs. Default 5 minutes. */
  coarseIntervalMs?: number;
}

/** setTimeout's signed-32-bit ceiling — a bare `30 * 86400_000` exceeds it. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export class SessionExpiryScheduler {
  private preciseTimer: ReturnType<typeof setTimeout> | null = null;
  private coarseTimer: ReturnType<typeof setInterval> | null = null;

  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly coarseIntervalMs: number;

  constructor(
    /** Read live — so a login that changes it takes effect on the next reschedule(). */
    private readonly getExpiresAt: () => number | null,
    private readonly onExpired: () => void,
    opts: SchedulerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
    this.coarseIntervalMs = opts.coarseIntervalMs ?? 5 * 60_000;
  }

  /** Start the coarse safety-net interval and arm the precise timer. */
  start(): void {
    if (this.coarseTimer) return; // already started
    this.coarseTimer = this.setIntervalFn(() => this.check(), this.coarseIntervalMs);
    this.reschedule();
  }

  stop(): void {
    if (this.preciseTimer) this.clearTimeoutFn(this.preciseTimer);
    if (this.coarseTimer) this.clearIntervalFn(this.coarseTimer);
    this.preciseTimer = null;
    this.coarseTimer = null;
  }

  /** Call whenever `sessionExpiresAt` changes — a login (new value) or a
   *  lock (now null, via getExpiresAt) — to re-arm the precise timer. */
  reschedule(): void {
    if (this.preciseTimer) {
      this.clearTimeoutFn(this.preciseTimer);
      this.preciseTimer = null;
    }
    const exp = this.getExpiresAt();
    if (exp === null) return;

    const delayMs = Math.max(0, exp * 1000 - this.now());
    if (delayMs > MAX_TIMEOUT_MS) {
      // Too far out for one setTimeout — wait out a max-sized chunk, then
      // recompute. Chains until the real moment is within range.
      this.preciseTimer = this.setTimeoutFn(() => this.reschedule(), MAX_TIMEOUT_MS);
      return;
    }
    this.preciseTimer = this.setTimeoutFn(() => this.check(), delayMs);
  }

  /** Idempotent: only fires onExpired when the expiry has actually arrived. */
  check(): void {
    const exp = this.getExpiresAt();
    if (exp !== null && this.now() >= exp * 1000) this.onExpired();
  }
}
