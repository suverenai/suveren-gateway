import { useEffect, useMemo, useState } from 'react';
import { T, changeSentence, changeButton } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { ConfirmDriver, type ConfirmAsk, type ConfirmState } from '../../lib/confirm-driver';
import { spClient } from '../../lib/sp-client';
import { useAuth } from '../../contexts/AuthContext';
import { Notice, useDriver } from './DeviceScreen';

export interface ConfirmChangeProps {
  state: ConfirmState;
  onPassword: (password: string) => void;
  onTouch: () => void;
  onCancel: () => void;
}

/** Screen 5: confirm ONE change to a connector login, with Touch ID (computers that have a check key) or the password. */
export function ConfirmChange({ state, onPassword, onTouch, onCancel }: ConfirmChangeProps) {
  const [password, setPassword] = useState('');
  const busy = state.phase === 'busy' || state.phase === 'starting';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-change-title"
      style={{ position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--bg-main) 70%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
      <div className="card" style={{ maxWidth: 440, width: '100%', margin: 0 }}>
        <h3 id="confirm-change-title" className="card-title" style={{ marginBottom: '0.75rem' }}>{T.confirmTitle}</h3>
        <div className="card" style={{ marginBottom: '1rem' }}>
          <strong>{changeSentence(state.kind, state.name)}</strong>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>{T.confirmScope}</div>
        </div>
        {state.error && <Notice kind="error">{state.error}</Notice>}
        {state.mode === 'touch' ? (
          <>
            <button className="btn btn-primary btn-full btn-lg" onClick={onTouch} disabled={busy}>{T.confirmWithTouch}</button>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', marginTop: '0.75rem' }}>{T.confirmReadTouch}</p>
          </>
        ) : (
          <>
            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label className="form-label" htmlFor="confirm-password">{T.passwordLabel}</label>
              <input id="confirm-password" className="form-input" type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)} disabled={busy} style={{ padding: '0.75rem' }}
                onKeyDown={e => e.key === 'Enter' && onPassword(password)} />
            </div>
            <button className="btn btn-primary btn-full btn-lg" onClick={() => onPassword(password)} disabled={busy || !password}>
              {changeButton(state.kind)}
            </button>
          </>
        )}
        <button className="btn btn-ghost btn-full" onClick={onCancel} style={{ marginTop: '0.75rem' }}>{T.connectCancel}</button>
      </div>
    </div>
  );
}

function ConfirmRun({ ask, settle, client }: { ask: ConfirmAsk; settle: (id: string | null) => void; client: DeviceClient }) {
  const driver = useMemo(() => new ConfirmDriver({ client, ask, settle }), [client, ask, settle]);
  const state = useDriver(driver);
  useEffect(() => { void driver.begin(); }, [driver]);
  return <ConfirmChange state={state} onPassword={p => void driver.withPassword(p)} onTouch={() => void driver.withTouch()} onCancel={() => driver.cancel()} />;
}

/**
 * Registers the screen as the page's confirmer: a change to a stored login that the gateway wants confirmed opens it,
 * and the same call goes on with the confirmed request (lib/sp-client.ts). Only on a gateway with a page session.
 */
export function ConfirmationHost({ client = deviceClient }: { client?: DeviceClient }) {
  const { access } = useAuth();
  const [current, setCurrent] = useState<{ ask: ConfirmAsk; settle: (id: string | null) => void } | null>(null);

  useEffect(() => {
    if (access !== 'password') return;
    spClient.setConfirmer(ask => new Promise<string | null>(resolve => {
      setCurrent({ ask, settle: id => { setCurrent(null); resolve(id); } });
    }));
    return () => spClient.setConfirmer(null);
  }, [access]);

  return current ? <ConfirmRun ask={current.ask} settle={current.settle} client={client} /> : null;
}
