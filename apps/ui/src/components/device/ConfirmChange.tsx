import { useEffect, useMemo, useRef, useState } from 'react';
import { T, changeSentence, changeButton } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { ConfirmDriver, type ConfirmAsk, type ConfirmState } from '../../lib/confirm-driver';
import { spClient } from '../../lib/sp-client';
import { useAuth } from '../../contexts/AuthContext';
import { Notice, useDriver } from './DeviceScreen';

export interface ConfirmChangeProps {
  state: ConfirmState;
  /** The connector's name as the person knows it (the request names it by id). */
  displayName?: string;
  onPassword: (password: string) => void;
  onTouch: () => void;
  onCancel: () => void;
}

/** Screen 5: confirm ONE change to a connector login, with Touch ID (computers that have a check key) or the password. */
export function ConfirmChange({ state, displayName, onPassword, onTouch, onCancel }: ConfirmChangeProps) {
  const [password, setPassword] = useState('');
  const busy = state.phase === 'busy' || state.phase === 'starting';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-change-title"
      style={{ position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--bg-main) 70%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
      <div className="card" style={{ maxWidth: 440, width: '100%', margin: 0 }}>
        <h3 id="confirm-change-title" className="card-title" style={{ marginBottom: '0.75rem' }}>{T.confirmTitle}</h3>
        <div className="card" style={{ marginBottom: '1rem' }}>
          <strong>{changeSentence(state.kind, displayName ?? state.name)}</strong>
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

function ConfirmRun({ ask, settle, client, names }: { ask: ConfirmAsk; settle: (id: string | null) => void; client: DeviceClient; names: Record<string, string> }) {
  const driver = useMemo(() => new ConfirmDriver({ client, ask, settle }), [client, ask, settle]);
  const state = useDriver(driver);
  useEffect(() => { void driver.begin(); }, [driver]);
  return <ConfirmChange state={state} displayName={names[ask.name]} onPassword={p => void driver.withPassword(p)} onTouch={() => void driver.withTouch()} onCancel={() => driver.cancel()} />;
}

/**
 * Registers the screen as the page's confirmer: a change to a stored login that the gateway wants confirmed opens it,
 * and the same call goes on with the confirmed request (lib/sp-client.ts). Only on a gateway with a page session.
 */
export function ConfirmationHost({ client = deviceClient }: { client?: DeviceClient }) {
  const { access } = useAuth();
  // A second confirmation waits its turn: it never replaces the one on screen.
  const [queue, setQueue] = useState<Array<{ key: number; ask: ConfirmAsk; settle: (id: string | null) => void }>>([]);
  const nextKey = useRef(0);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (access !== 'password') return;
    spClient.setConfirmer(ask => new Promise<string | null>(resolve => {
      const item = { key: ++nextKey.current, ask, settle: (id: string | null) => { setQueue(q => q.filter(x => x !== item)); resolve(id); } };
      setQueue(q => [...q, item]);
    }));
    return () => spClient.setConfirmer(null);
  }, [access]);

  // The connector is named by its display name, read once from the manifests; the id is the fallback.
  const wanted = queue.length > 0;
  useEffect(() => {
    if (!wanted || Object.keys(names).length > 0) return;
    void spClient.getIntegrationManifests().then(r => setNames(Object.fromEntries(r.manifests.map(m => [m.id, m.name])))).catch(() => {});
  }, [wanted, names]);

  const current = queue[0];
  return current ? <ConfirmRun key={current.key} ask={current.ask} settle={current.settle} client={client} names={names} /> : null;
}
