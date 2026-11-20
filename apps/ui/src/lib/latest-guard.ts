/**
 * Only the newest of several overlapping async loads may write its result.
 *
 * A refresh that runs on every live event (SSE) can overlap with the one
 * before it: two blocked calls a moment apart send two `denial-recorded`
 * events, and each starts a load. The loads finish in any order. Without a
 * guard, an older load that finishes last writes its older answer over the
 * newer one, and nothing corrects it until the next event or the 5-minute
 * fallback poll (the Blocked badge then stays at 1 with 2 unseen blocks).
 *
 * Usage: `const isLatest = guard.begin();` before the awaits, then write
 * state only if `isLatest()` is still true afterwards.
 */
export interface LatestGuard {
  /** Starts a load. The returned check is true until a newer load begins. */
  begin(): () => boolean;
}

export function createLatestGuard(): LatestGuard {
  let current = 0;
  return {
    begin() {
      const mine = ++current;
      return () => mine === current;
    },
  };
}
