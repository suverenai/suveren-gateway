/**
 * "Keep Suveren running" — autostart as a switch instead of a terminal command.
 *
 * The mechanism has existed in the CLI for a while, but a feature that requires
 * someone to open a terminal is a feature most people never get — and on
 * Windows and Linux it did not exist at all until recently.
 *
 * Two things this component must not do:
 *
 *  1. Show optimistic state. It renders what the backend reports, re-reading
 *     after every change, so the switch cannot claim autostart is on when the
 *     install actually failed.
 *
 *  2. Overpromise. Autostart keeps the PROCESS alive; it cannot unlock the
 *     vault. After a reboot the gateway comes back LOCKED and the agent has no
 *     authority until someone enters their API key. If the switch does not say
 *     that plainly it becomes a promise the product does not keep — worse than
 *     not offering it.
 */
import { useCallback, useEffect, useState } from 'react';
import { spClient } from '../lib/sp-client';

interface AutostartState {
  supported: boolean;
  installed: boolean;
  platform: string;
  reason?: string;
  detail?: string;
}

const PLATFORM_MECHANISM: Record<string, string> = {
  darwin: 'a macOS login item',
  win32: 'a Windows scheduled task',
  linux: 'a systemd user service',
};

export function AutostartToggle() {
  const [state, setState] = useState<AutostartState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await spClient.getAutostart());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read autostart state');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async () => {
    if (!state?.supported || busy) return;
    setBusy(true);
    setError(null);
    try {
      await spClient.setAutostart(!state.installed);
    } catch (err) {
      // EXPECTED on install: the CLI stops the running gateway so the login
      // service can take it over, which kills the very connection serving this
      // request. The browser reports "Failed to fetch" — not a failure, a
      // handover. Anything else is a real error.
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!/failed to fetch|networkerror|load failed/i.test(msg)) setError(msg);
    } finally {
      // Wait for the gateway to come back, then read the REAL state. Never
      // assume the toggle succeeded — that is the whole point of re-reading.
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          setState(await spClient.getAutostart());
          setError(null);
          break;
        } catch {
          if (Date.now() > deadline) {
            setError('The gateway did not come back within 30s. Check it is running.');
            break;
          }
          await new Promise(r => setTimeout(r, 1_000));
        }
      }
      setBusy(false);
    }
  }, [state, busy, load]);

  // Never render nothing. An earlier version returned null whenever the state
  // could not be read, which hid the card AND the error explaining why — so a
  // failing endpoint looked identical to a feature that does not exist.
  if (!state) {
    return (
      <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Keep Suveren running</h2>
        <p role={error ? 'alert' : undefined} style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {error ? `Could not read autostart state: ${error}` : 'Checking…'}
        </p>
      </div>
    );
  }

  const mechanism = PLATFORM_MECHANISM[state.platform] ?? 'a login service';

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Keep Suveren running</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
            {state.supported
              ? <>Starts automatically when you log in, and restarts if it crashes. Uses {mechanism} — no admin rights needed.</>
              : state.reason}
          </p>
        </div>

        {state.supported && (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            aria-pressed={state.installed}
            className={state.installed ? 'btn btn-secondary' : 'btn btn-primary'}
            style={{ whiteSpace: 'nowrap' }}
          >
            {busy ? 'Restarting…' : state.installed ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      {state.supported && (
        <p style={{ margin: '1rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
          Status: <strong>{state.installed ? 'Active — starts at login' : 'Off'}</strong>
        </p>
      )}

      {state.supported && (
        // The honesty line. Autostart restores the process, never the
        // credentials — saying so here is what stops "keep running" from
        // reading as "keep working".
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
          After a restart Suveren comes back <strong>locked</strong>. You still enter your API key
          once to unlock it — your key is never stored, so nothing on this machine can unlock it for you.
        </p>
      )}

      {error && (
        <p role="alert" style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
