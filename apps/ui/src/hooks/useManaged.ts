import { useEffect, useState } from 'react';

/**
 * Is this gateway managed by IT policy at all — i.e. does `/health` report
 * ANY locked key? Separate from useSimulationPolicy's `locked` (which only
 * answers for the "simulation" key): the dashboard first-run card's step 1
 * needs the general "someone else administers this machine" signal, to show
 * "Your IT sets up the connection" instead of the self-install instructions,
 * not a specific setting's lock state.
 *
 * Same polling shape as useSimulationMode: `/health` is unauthenticated, so
 * this works before login too, and an older control-plane that omits
 * `policyLocked` must behave like "not managed", never throw.
 */
export interface ManagedHealth {
  policyLocked?: string[];
}

/** Pure derivation — exported for testing without a DOM / fetch mock. */
export function deriveManaged(data: ManagedHealth | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  return Array.isArray(data.policyLocked) && data.policyLocked.length > 0;
}

export function useManaged(): boolean {
  const [managed, setManaged] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      fetch('/health')
        .then((r) => r.json())
        .then((data: ManagedHealth) => {
          if (!cancelled) setManaged(deriveManaged(data));
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

  return managed;
}
