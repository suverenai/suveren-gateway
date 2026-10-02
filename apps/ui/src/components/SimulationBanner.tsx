import { useEffect, useRef } from 'react';
import { useSimulationMode } from '../hooks/useSimulationMode';

/**
 * Gateway-wide banner shown on every page while simulation mode is on.
 *
 * Backend truth, not optimistic state: driven entirely by `/health`'s
 * `simulation` flag (see useSimulationMode) — there is no local toggle here,
 * because the UI has no way to change the mode (it's a CLI-only, restart-
 * required switch; see `suveren-gateway simulation on|off`).
 *
 * Mirrors UpdateBanner's push-down mechanics (a fixed strip under the nav that
 * measures its own height into a CSS var so the sidebar/main-content shift
 * down), but simpler: no dismiss, no animation — it is exactly as persistent
 * as the mode it reports.
 */
export function SimulationBanner() {
  const simulation = useSimulationMode();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!simulation) {
      document.documentElement.style.removeProperty('--sim-banner-h');
      return;
    }
    const measure = () => {
      const h = ref.current?.offsetHeight ?? 0;
      document.documentElement.style.setProperty('--sim-banner-h', `${h}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--sim-banner-h');
    };
  }, [simulation]);

  if (!simulation) return null;

  return (
    <div ref={ref} className="simulation-banner" role="status" aria-live="polite">
      <span className="simulation-banner-text">
        Simulation mode — real systems are blocked.
      </span>
    </div>
  );
}
