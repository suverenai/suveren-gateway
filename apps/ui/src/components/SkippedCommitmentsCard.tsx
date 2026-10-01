/**
 * A committed (fully approved) proposal this gateway has no local record of
 * submitting will NOT execute here — see tools/commitments.ts's skip path.
 * Without this card, the human sees an approval with nothing appearing to
 * happen and no reason why: this is that reason, surfaced the same way
 * check-pending-commitments surfaces it to an agent.
 *
 * Renders NOTHING when the list is empty — the common case — so this never
 * adds visual weight for someone who never hits the multi-device / lost-data
 * gap it explains.
 */
import { useState } from 'react';
import { spClient } from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';

interface SkippedCommitment {
  id: string;
  tool: string;
  note: string;
}

export function SkippedCommitmentsCard() {
  const [skipped, setSkipped] = useState<SkippedCommitment[]>([]);

  const refresh = async () => {
    try {
      const { skipped: list } = await spClient.getSkippedCommitments();
      setSkipped(list);
    } catch {
      // Best-effort — a failed background check must not show a false
      // "nothing skipped" or interrupt the rest of the dashboard.
    }
  };

  useVisiblePolling(refresh, 30_000);

  if (skipped.length === 0) return null;

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '1.5rem', borderLeft: '3px solid var(--warn, #b58900)' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
        Approved, but not run here ({skipped.length})
      </h2>
      <p style={{ margin: '0.5rem 0 1rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
        These were approved, but this gateway has no local record of asking for them — usually
        because a different device/installation of yours submitted them, or its local record is
        gone. Re-run the same request on this gateway to execute it here.
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.9rem' }}>
        {skipped.map(s => (
          <li key={s.id} style={{ marginBottom: '0.35rem' }}>
            <code>{s.tool}</code> <span style={{ color: 'var(--text-tertiary)' }}>({s.id})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
