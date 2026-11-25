import { useEffect, useState } from 'react';

/**
 * Polls the control-plane's `/health` for the gateway-wide simulation-mode
 * flag. Separate from `useUpdateCheck` (which polls the same endpoint) rather
 * than folded into it: the two concerns are unrelated and either hook should
 * keep working if the other is ever removed.
 *
 * `/health` is unauthenticated (see useUpdateCheck's note), so this works
 * before login too — the banner is accurate on the login screen as well.
 *
 * `null` until the gateway has answered once. A layout that differs by mode (the Connectors page) waits for
 * it — assuming "off" first drew the production layout and then rebuilt every card in the simulation one.
 */
/**
 * The last answer this page got (DEC-100): a frame that replaces another (the dashboard greyed out after the sign-in →
 * the real dashboard) mounts with the banner already there instead of drawing it a moment later and pushing the page
 * down. Only a starting point: each mount asks /health again at once.
 */
let lastSimulation: boolean | null = null;
/** Tests only. */
export function resetSimulationSeenForTests(): void { lastSimulation = null; }
/** Notes an answer of /health for the next mount. */
export function noteSimulation(on: boolean): void { lastSimulation = on; }

export function useSimulationMode(): boolean | null {
  const [simulation, setSimulation] = useState<boolean | null>(lastSimulation);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      fetch('/health')
        .then(r => r.json())
        .then((data: { simulation?: boolean }) => {
          noteSimulation(data.simulation === true);
          if (!cancelled) setSimulation(data.simulation === true);
        })
        .catch(() => { /* server may be momentarily unreachable — keep last value */ });
    };

    check();
    const id = setInterval(check, 30_000);

    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return simulation;
}
