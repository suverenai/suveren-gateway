import { useEffect, useState } from 'react';

/**
 * Polls the control-plane's `/health` for the gateway-wide simulation-mode
 * flag. Separate from `useUpdateCheck` (which polls the same endpoint) rather
 * than folded into it: the two concerns are unrelated and either hook should
 * keep working if the other is ever removed.
 *
 * `/health` is unauthenticated (see useUpdateCheck's note), so this works
 * before login too — the banner is accurate on the login screen as well.
 */
export function useSimulationMode(): boolean {
  const [simulation, setSimulation] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      fetch('/health')
        .then(r => r.json())
        .then((data: { simulation?: boolean }) => {
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
