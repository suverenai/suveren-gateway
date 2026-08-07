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
      <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Desktop notifications</h2>
        <p role={error ? 'alert' : undefined} style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {error ? `Could not read the setting: ${error}` : 'Checking…'}
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Desktop notifications</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
            Tells you something is waiting for review — never what it is, and never
            with an approve button. Open Suveren to see and decide. At most one
            notification a minute; the browser tab always shows the count.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-pressed={enabled}
          className={enabled ? 'btn btn-secondary' : 'btn btn-primary'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {busy ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
