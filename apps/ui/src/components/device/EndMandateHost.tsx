import { useState } from 'react';
import { EndMandate, S13, type EndState } from '@suveren/approval-card/mandate-screens';
import { spClient } from '../../lib/sp-client';

/** Screen 4 on the gateway page: ends the mandate with the device-signed route and shows what the gateway answered. */
export function EndMandateHost({ authorizationId, profileName, activeUntil, onEnded, onClose }: {
  authorizationId: string; profileName: string; activeUntil: string | null; onEnded: () => void; onClose: () => void;
}) {
  const [state, setState] = useState<EndState>({ phase: 'confirm' });
  const end = async () => {
    setState({ phase: 'busy' });
    const r = await spClient.endMandate(authorizationId);
    if (r.ok) { setState({ phase: 'done' }); onEnded(); } else setState({ phase: 'error', code: r.code });
  };
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--bg-main) 70%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
      <div style={{ maxWidth: 480, width: '100%' }}>
        <EndMandate facts={{ profileName, limits: [], activeUntil }} state={state} onEnd={() => void end()} onKeep={onClose} />
        {state.phase === 'done' && <button type="button" className="btn btn-ghost btn-full" onClick={onClose}>{S13.endClose}</button>}
      </div>
    </div>
  );
}
