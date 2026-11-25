/**
 * Overlapping async loads may write their result only if no newer load has
 * written already.
 *
 * A refresh that runs on every live event (SSE) can overlap with the one
 * before it: two blocked calls a moment apart send two `denial-recorded`
 * events, and each starts a load. The loads finish in any order. Without a
 * guard, an older load that finishes last writes its older answer over the
 * newer one, and nothing corrects it until the next event or the 5-minute
 * fallback poll (the Blocked badge then stays at 1 with 2 unseen blocks).
 *
 * A load that finishes first still writes at once, even while a newer one is
 * running: dropping it would leave the screen empty or stale for as long as
 * events keep arriving.
 *
 * Usage: `const mayWrite = guard.begin();` before the awaits, then write
 * state only if `mayWrite()` returns true afterwards (call it once).
 */
export interface LatestGuard {
  /** Starts a load. The returned check is true unless a newer load already wrote. */
  begin(): () => boolean;
}

export function createLatestGuard(): LatestGuard {
  let started = 0;
  let written = 0;
  return {
    begin() {
      const mine = ++started;
      return () => {
        if (mine <= written) return false;
        written = mine;
        return true;
      };
    },
  };
}
