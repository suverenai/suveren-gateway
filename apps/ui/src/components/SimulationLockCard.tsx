/**
 * "Simulation mode" status in Settings — shown ONLY when IT policy has
 * locked it (see docs/managed-settings.md). Simulation mode has no UI
 * toggle today (it's a CLI-only, restart-required switch — see
 * SimulationBanner.tsx), so there is nothing useful to show here for an
 * unmanaged install; this card exists purely to tell a managed employee
 * WHY they can't change it, same as AuthorityServerCard does for the AS URL.
 *
 * Backend truth, not optimistic state: driven entirely by `/health`'s
 * `simulation` + `policyLocked` fields (see useSimulationPolicy). An older
 * control-plane that omits `policyLocked` renders nothing here — exactly
 * today's behaviour.
 */
import { useSimulationPolicy } from '../hooks/useSimulationPolicy';
import { LockedByItBadge } from './LockedByItBadge';
import { ObTypeLine } from './ObjectCard';

export function SimulationLockCard() {
  const { simulation, locked } = useSimulationPolicy();

  if (!locked) return null;

  return (
    <article className="ob-card su-card">
      <ObTypeLine
        parts={[
          'Simulation mode',
          simulation !== null ? <span className={`ob-st${simulation ? '' : ' is-off'}`}>{simulation ? 'On' : 'Off'}</span> : null,
          <LockedByItBadge />,
        ]}
      />
      <h3 className="ob-title">Simulation mode</h3>
      <p className="ob-one">
        Blocks every real connector without a manifest "simulation" marker.
        {simulation !== null && (
          <>
            {' '}Currently <strong>{simulation ? 'ON' : 'OFF'}</strong>
            {simulation ? ' — real systems are not reachable from this gateway.' : '.'}
          </>
        )}
      </p>
      <p className="ob-one">
        Simulation mode is set by your organization's IT policy
        {simulation !== null ? ` (currently ${simulation ? 'on' : 'off'})` : ''} and cannot be
        changed from this computer — not even from the command line.
      </p>
    </article>
  );
}
