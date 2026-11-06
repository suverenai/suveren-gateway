/**
 * "Open approvals by themselves" — the switch for the approval panel.
 *
 * Renders what the gateway holds (ApprovalQueueContext reads and writes
 * /api/gateway-settings; nothing lives in the browser), same pattern as
 * NotificationsToggle: never optimistic, never silent when the read fails.
 */
import { useState } from 'react';
import { useApprovalQueue } from '../contexts/ApprovalQueueContext';
import { ObTypeLine } from './ObjectCard';

export function OpenApprovalsToggle() {
  const { autoOpen, settingRead, autoOpenError, setAutoOpen } = useApprovalQueue();
  const [busy, setBusy] = useState(false);

  if (autoOpen === null) {
    return (
      <article className="ob-card su-card">
        <ObTypeLine parts={['Approvals']} />
        <h3 className="ob-title">Open approvals by themselves</h3>
        <p role={settingRead ? 'alert' : undefined} className="ob-one">
          {settingRead ? `Could not read the setting: ${autoOpenError ?? 'unknown error'}` : 'Checking…'}
        </p>
      </article>
    );
  }

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try { await setAutoOpen(!autoOpen); } finally { setBusy(false); }
  };

  return (
    <article className="ob-card su-card" data-testid="open-approvals-card">
      <div className="su-row">
        <div>
          <ObTypeLine parts={['Approvals', <span className={`ob-st${autoOpen ? '' : ' is-off'}`} key="st">{autoOpen ? 'On' : 'Off'}</span>]} />
          <h3 className="ob-title">Open approvals by themselves</h3>
          <p className="ob-one">
            {autoOpen
              ? 'When an approval is waiting for you, it opens on its own. Turn off: only a tab at the edge shows the count.'
              : 'Off: new approvals only show as a tab at the edge. Open them from the tab or from Approvals.'}
          </p>
        </div>
        <div className="ob-btns">
          <button type="button" onClick={() => void toggle()} disabled={busy} aria-pressed={autoOpen} className={`ob-btn${autoOpen ? '' : ' is-solid'}`}>
            {busy ? 'Saving…' : autoOpen ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>
      {autoOpenError && <p role="alert" className="ob-one ob-bold msg-error">{autoOpenError}</p>}
    </article>
  );
}
