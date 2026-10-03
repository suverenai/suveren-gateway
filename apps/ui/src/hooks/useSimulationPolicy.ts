import { useEffect, useState } from 'react';

/**
 * Settings-page counterpart to `useSimulationMode` (the gateway-wide banner's
 * hook): same `/health` fields, but ALSO reports whether simulation mode is
 * locked by IT policy (`policyLocked` includes `"simulation"` — see
 * lib/policy.ts and docs/managed-settings.md) so Settings can render "set by
 * your IT" instead of implying a control that doesn't exist.
 *
 * Kept separate from `useSimulationMode` rather than extending it: that hook
 * already has callers that only want the boolean, and this one's shape
 * (locked vs not) is specific to Settings.
 */
export interface SimulationPolicyHealth {
  simulation?: boolean;
  policyLocked?: string[];
}

export interface SimulationPolicy {
  /** `null` until the first successful read. */
  simulation: boolean | null;
  /** Always `false` for an older control-plane that omits `policyLocked`. */
  locked: boolean;
}

/** Pure derivation — exported for testing without a DOM / fetch mock. */
export function deriveSimulationPolicy(
  data: SimulationPolicyHealth | null | undefined,
): SimulationPolicy {
  if (!data || typeof data !== 'object') return { simulation: null, locked: false };
  const locked = Array.isArray(data.policyLocked) && data.policyLocked.includes('simulation');
  const simulation = typeof data.simulation === 'boolean' ? data.simulation : null;
  return { simulation, locked };
}

export function useSimulationPolicy(): SimulationPolicy {
  const [state, setState] = useState<SimulationPolicy>({ simulation: null, locked: false });

  useEffect(() => {
    let cancelled = false;
    fetch('/health')
      .then(r => r.json())
      .then((data: SimulationPolicyHealth) => { if (!cancelled) setState(deriveSimulationPolicy(data)); })
      .catch(() => { /* server may be momentarily unreachable — keep last value */ });
    return () => { cancelled = true; };
  }, []);

  return state;
}
