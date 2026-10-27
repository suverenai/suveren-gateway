/**
 * "Notify me when something needs review" — the desktop-notification switch.
 *
 * Mirrors AutostartToggle: renders backend truth, re-reading after every change,
 * so the switch can never claim notifications are on when the write failed.
 *
 * The copy states the limits deliberately. A notification that arrives without
 * saying what it will contain invites the assumption that it contains the
 * proposal — which is exactly what it must not do, since OS notifications show
 * on lock screens and persist in system databases.
 */
import { useCallback, useEffect, useState } from 'react';
import { spClient } from '../lib/sp-client';
import { ObTypeLine } from './ObjectCard';

export function NotificationsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await spClient.getGatewaySettings();
      setEnabled(s.desktopNotifications);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read notification setting');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async () => {
    if (enabled === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Render what came back, not what we asked for.
      const saved = await spClient.setGatewaySettings({ desktopNotifications: !enabled });
      setEnabled(saved.desktopNotifications);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      await load();
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, load]);

  // Never render nothing: a failing endpoint must not look like a missing feature.
  if (enabled === null) {
    return (
      <article className="ob-card su-card">
        <ObTypeLine parts={['Notifications']} />
        <h3 className="ob-title">Desktop notifications</h3>
        <p role={error ? 'alert' : undefined} className="ob-one">
          {error ? `Could not read the setting: ${error}` : 'Checking…'}
        </p>
      </article>
    );
  }

  return (
    <article className="ob-card su-card">
      <div className="su-row">
        <div>
          <ObTypeLine parts={['Notifications', <span className={`ob-st${enabled ? '' : ' is-off'}`}>{enabled ? 'On' : 'Off'}</span>]} />
          <h3 className="ob-title">Desktop notifications</h3>
          <p className="ob-one">
            Tells you something is waiting for review — never what it is, and never
            with an approve button. Open Suveren to see and decide. At most one
            notification a minute; the browser tab always shows the count.
          </p>
        </div>

        <div className="ob-btns">
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            aria-pressed={enabled}
            className={`ob-btn${enabled ? '' : ' is-solid'}`}
          >
            {busy ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="ob-one ob-bold msg-error">
          {error}
        </p>
      )}
    </article>
  );
}
