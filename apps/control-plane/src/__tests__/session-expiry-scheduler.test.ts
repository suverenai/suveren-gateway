/**
 * Time-based locking: the gateway must lock at sessionExpiresAt even if no
 * 401 happens to arrive first, and it must still catch up promptly after a
 * laptop sleeps through the precise moment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionExpiryScheduler } from '../lib/session-expiry-scheduler';

/** A controllable clock: `now` is read live, timers are driven manually. */
function fakeClock(startMs: number) {
  let now = startMs;
  const timeouts = new Map<number, { fn: () => void; delay: number }>();
  const intervals = new Map<number, { fn: () => void; period: number; sinceLast: number }>();
  let nextId = 1;

  const setTimeoutFn = ((fn: () => void, delay?: number) => {
    const id = nextId++;
    timeouts.set(id, { fn, delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => { timeouts.delete(id as number); }) as typeof clearTimeout;
  const setIntervalFn = ((fn: () => void, delay?: number) => {
    const id = nextId++;
    intervals.set(id, { fn, period: delay ?? 0, sinceLast: 0 });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalFn = ((id: unknown) => { intervals.delete(id as number); }) as typeof clearInterval;

  return {
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    setIntervalFn,
    clearIntervalFn,
    /** Advance the clock and fire any timers now due. Coarse: fires ALL due
     *  timeouts (they may re-arm themselves) and every interval once per call. */
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timeouts]) {
        t.delay -= ms;
        if (t.delay <= 0) { timeouts.delete(id); t.fn(); }
      }
      for (const t of intervals.values()) {
        t.sinceLast += ms;
        while (t.period > 0 && t.sinceLast >= t.period) {
          t.sinceLast -= t.period;
          t.fn();
        }
      }
    },
    pendingTimeoutDelays: () => [...timeouts.values()].map(t => t.delay),
    intervalCount: () => intervals.size,
  };
}

describe('SessionExpiryScheduler', () => {
  let onExpired: ReturnType<typeof vi.fn>;
  beforeEach(() => { onExpired = vi.fn(); });

  it('fires when the precise moment arrives', () => {
    const clock = fakeClock(0);
    const expiresAtSec = 1000; // seconds
    const s = new SessionExpiryScheduler(() => expiresAtSec, onExpired, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
      coarseIntervalMs: 5 * 60_000,
    });
    s.start();

    clock.advance(999_000); // 999s — not yet
    expect(onExpired).not.toHaveBeenCalled();

    clock.advance(2_000); // past 1000s
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it('does not fire before expiry, even across several coarse ticks', () => {
    const clock = fakeClock(0);
    const s = new SessionExpiryScheduler(() => 10_000, onExpired, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
      coarseIntervalMs: 60_000,
    });
    s.start();
    clock.advance(60_000);
    clock.advance(60_000);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('a null expiresAt (locked, or never logged in) never fires', () => {
    const clock = fakeClock(0);
    const s = new SessionExpiryScheduler(() => null, onExpired, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    });
    s.start();
    clock.advance(10_000_000);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('catches a sleep gap: the clock jumps past expiry, the next coarse tick locks', () => {
    const clock = fakeClock(0);
    const expiresAtSec = 100_000;
    const s = new SessionExpiryScheduler(() => expiresAtSec, onExpired, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
      coarseIntervalMs: 5 * 60_000,
    });
    s.start();

    // Simulate the OS suspending the process: wall-clock jumps by far more
    // than one coarse interval in a single step (no intermediate ticks —
    // that's what "asleep" means), then the process resumes and its next
    // real interval tick runs.
    clock.advance(200_000_000);
    expect(onExpired).toHaveBeenCalled();
  });

  it('caps any single setTimeout delay at the 32-bit signed ceiling (30-day sessions exceed it)', () => {
    const clock = fakeClock(0);
    // ~35 days out — comfortably past the ~24.8-day setTimeout ceiling.
    const expiresAtSec = 35 * 86_400;
    const s = new SessionExpiryScheduler(() => expiresAtSec, onExpired, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    });
    s.start();

    const MAX = 2_147_483_647;
    for (const d of clock.pendingTimeoutDelays()) expect(d).toBeLessThanOrEqual(MAX);

    // Chain forward past the cap in MAX-sized hops; onExpired must still land
    // on the real moment, not fire early or never.
    clock.advance(MAX);
    for (const d of clock.pendingTimeoutDelays()) expect(d).toBeLessThanOrEqual(MAX);
    expect(onExpired).not.toHaveBeenCalled();

    clock.advance(MAX);
    expect(onExpired).toHaveBeenCalled();
  });

  it('reschedule() re-arms against a NEW expiresAt (a fresh login after a lock)', () => {
    const clock = fakeClock(0);
    let expiresAtSec: number | null = 1000;
    // Real callers read this from vault.getSessionExpiresAt(), which the real
    // lock (a no-op once already locked) clears to null — model that so the
    // coarse interval's repeat checks don't keep re-firing after the first.
    const onExpiredOnce = vi.fn(() => { expiresAtSec = null; });
    const s = new SessionExpiryScheduler(() => expiresAtSec, onExpiredOnce, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    });
    s.start();

    // Logged in again with a later expiry before the first one arrives.
    expiresAtSec = 5000;
    s.reschedule();

    clock.advance(1_500_000); // past the OLD 1000s mark
    expect(onExpiredOnce).not.toHaveBeenCalled();

    clock.advance(4_000_000); // past the NEW 5000s mark
    expect(onExpiredOnce).toHaveBeenCalledOnce();
  });

  it('stop() cancels both timers', () => {
    const clock = fakeClock(0);
    const s = new SessionExpiryScheduler(() => 1000, onExpired, {
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    });
    s.start();
    s.stop();
    clock.advance(10_000_000);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
