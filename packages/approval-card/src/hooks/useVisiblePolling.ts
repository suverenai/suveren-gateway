import { useEffect, useRef } from 'react';

/**
 * setInterval wrapper that skips ticks while the tab is not visible.
 * Runs `fn` once on mount (when visible) and then every `intervalMs`
 * while `document.visibilityState === 'visible'`. Also fires `fn` when
 * the tab regains focus, to refresh stale data without waiting for the
 * next tick.
 *
 * Pass `restartKey` to force an immediate re-fetch and timer reset when
 * a dependency changes (e.g., the active domain or user).
 *
 * This is the gateway's main defence against Redis-read bleed — dormant
 * tabs and background windows cost zero.
 */
export function useVisiblePolling(fn: () => void, intervalMs: number, restartKey?: unknown): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const isVisible = () =>
      typeof document === 'undefined' ? true : document.visibilityState === 'visible';

    const tick = () => {
      if (isVisible()) fnRef.current();
    };

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibilityChange = () => {
      if (isVisible()) {
        fnRef.current(); // refresh on return
        start();
      } else {
        stop();
      }
    };

    if (isVisible()) {
      fnRef.current(); // initial fetch
      start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, restartKey]);
}
