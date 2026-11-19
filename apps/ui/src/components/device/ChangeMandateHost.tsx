import { useEffect, useState } from 'react';
import type { MandateDiff } from '@hap/core/mandate-change';
import { ChangeMandate, S13, teamDiff, changeErrorText, type ChangeState, type TeamTerms } from '@suveren/approval-card/mandate-screens';
import { spClient } from '../../lib/sp-client';

/**
 * Screen 5 on the gateway page: loads the gateway's prepared change (diff and team terms, computed from the signed mandate),
 * shows only the differences, and on "Change" asks the gateway to sign it with this computer's check (Touch ID). The diff shown is
 * sent back with the call: the gateway refuses a change that would differ from it.
 */
export function ChangeMandateHost({ authorizationId, changes, onChanged, onClose }: {
  authorizationId: string; changes: Record<string, unknown>; onChanged: () => void; onClose: () => void;
}) {
  const [prepared, setPrepared] = useState<{ profileName: string; diff: MandateDiff; before: TeamTerms | null; after: TeamTerms | null } | null>(null);
  const [state, setState] = useState<ChangeState>({ phase: 'review' });
  useEffect(() => {
    let live = true;
    void spClient.previewMandateChange(authorizationId, changes).then(r => {
      if (!live) return;
      if (r.ok) setPrepared({ profileName: r.profileName, diff: r.diff, before: r.before, after: r.after });
      else setState({ phase: 'error', code: r.code });
    });
    return () => { live = false; };
  }, [authorizationId, changes]);

  const change = async () => {
    if (!prepared) return;
    setState({ phase: 'busy' });
    const r = await spClient.changeMandate(authorizationId, changes, prepared.diff);
    if (r.ok) { setState({ phase: 'done' }); onChanged(); } else setState({ phase: 'error', code: r.code });
  };
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--bg-main) 70%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem', overflowY: 'auto' }}>
      <div style={{ maxWidth: 560, width: '100%' }}>
        {prepared
          ? <ChangeMandate profileName={prepared.profileName} diff={prepared.diff} team={teamDiff(prepared.before, prepared.after)} state={state} onChange={() => void change()} onCancel={onClose} />
          : state.phase === 'error'
            ? <div className="card"><p role="alert" className="msg-error">{changeErrorText(state.code)}</p><button type="button" className="btn btn-ghost" onClick={onClose}>{S13.changeCancel}</button></div>
            : <p>…</p>}
        {state.phase === 'done' && <button type="button" className="btn btn-ghost btn-full" onClick={onClose}>{S13.endClose}</button>}
      </div>
    </div>
  );
}
