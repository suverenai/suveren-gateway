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
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      // Nothing restarts any more — installing only REGISTERS autostart for the
      // next login — so the state is readable immediately and there is no
      // handover to ride out.
      try {
        setState(await spClient.getAutostart());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not re-read state');
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
            {busy ? 'Working…' : state.installed ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      {state.supported && (
        <p style={{ margin: '1rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
          Status: <strong>{state.installed ? 'On — starts from your next login' : 'Off'}</strong>
        </p>
      )}

      {state.supported && (
        // The honesty line. Autostart restores the process, never the
        // credentials — saying so here is what stops "keep running" from
        // reading as "keep working".
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
          Turning this on doesn't interrupt the gateway you're using — it takes effect at your
          next login. After any restart Suveren comes back <strong>locked</strong>: you enter your
          API key once to unlock it, because nothing stored on this machine can unlock it for you.
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
