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
import { ObTypeLine, ObFold } from './ObjectCard';

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
      <article className="ob-card su-card">
        <ObTypeLine parts={['Autostart']} />
        <h3 className="ob-title">Keep Suveren running</h3>
        <p role={error ? 'alert' : undefined} className="ob-one">
          {error ? `Could not read autostart state: ${error}` : 'Checking…'}
        </p>
      </article>
    );
  }

  const mechanism = PLATFORM_MECHANISM[state.platform] ?? 'a login service';

  return (
    <article className="ob-card su-card">
      <div className="su-row">
        <div>
          <ObTypeLine
            parts={['Autostart', state.supported ? <span className={`ob-st${state.installed ? '' : ' is-off'}`}>{state.installed ? 'On' : 'Off'}</span> : 'Not available']}
          />
          <h3 className="ob-title">Keep Suveren running</h3>
          <p className="ob-one">
            {state.supported
              ? <>Starts automatically when you log in, and restarts if it crashes. Uses {mechanism} — no admin rights needed.</>
              : state.reason}
          </p>
        </div>

        {state.supported && (
          <div className="ob-btns">
            <button
              type="button"
              onClick={() => void toggle()}
              disabled={busy}
              aria-pressed={state.installed}
              className={`ob-btn${state.installed ? '' : ' is-solid'}`}
            >
              {busy ? 'Working…' : state.installed ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        )}
      </div>

      {state.supported && (
        // The honesty line. Autostart restores the process, never the
        // credentials — saying so here is what stops "keep running" from
        // reading as "keep working".
        <ObFold title="What happens after a restart" summary="takes effect at your next login">
          <p>
            Turning this on doesn't interrupt the gateway you're using — it takes effect at your
            next login. After any restart Suveren comes back <strong>locked</strong>: you enter your
            API key once to unlock it, because nothing stored on this machine can unlock it for you.
          </p>
        </ObFold>
      )}

      {error && (
        <p role="alert" className="ob-one ob-bold msg-error">
          {error}
        </p>
      )}
    </article>
  );
}
