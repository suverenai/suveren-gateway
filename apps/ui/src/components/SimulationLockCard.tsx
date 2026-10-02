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

export function SimulationLockCard() {
  const { simulation, locked } = useSimulationPolicy();

  if (!locked) return null;

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Simulation mode</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
            Blocks every real connector without a manifest "simulation" marker.
            {simulation !== null && (
              <>
                {' '}Currently <strong>{simulation ? 'ON' : 'OFF'}</strong>
                {simulation ? ' — real systems are not reachable from this gateway.' : '.'}
              </>
            )}
          </p>
        </div>
        <LockedByItBadge />
      </div>

      <p style={{ margin: '1rem 0 0', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
        Simulation mode is set by your organization's IT policy
        {simulation !== null ? ` (currently ${simulation ? 'on' : 'off'})` : ''} and cannot be
        changed from this computer — not even from the command line.
      </p>
    </div>
  );
}
