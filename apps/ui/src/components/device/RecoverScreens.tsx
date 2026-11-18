import { useEffect, useMemo, useState } from 'react';
import { DRAFT, T } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { RecoverDriver, type RecoverState } from '../../lib/recover-driver';
import { useAuth } from '../../contexts/AuthContext';
import { DeviceScreen, Notice, useDriver } from './DeviceScreen';

export interface RecoverScreenProps {
  state: RecoverState;
  /** The new code of a replacement, shown once. */
  newCode?: string | null;
  onStart: (code: string) => void;
  onCancel: () => void;
  onRotateStart: () => void;
  onRotateSubmit: (oldCode: string, newCode: string) => void;
  onBack?: () => void;
  onDone: () => void;
}

/** Recovery with the recovery code, and replacing the recovery code. */
export function RecoverScreen(p: RecoverScreenProps) {
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const st = p.state;

  if (st.kind === 'reset') {
    switch (st.step) {
      case 'form':
        return (
          <DeviceScreen title={DRAFT.recoverTitle}>
            <p>{DRAFT.recoverWhy}</p>
            {st.error && <Notice kind="error">{st.error}</Notice>}
            <div className="form-group" style={{ marginBottom: '1.5rem' }}>
              <label className="form-label" htmlFor="recover-code">{DRAFT.recoverCodeLabel}</label>
              <input id="recover-code" className="form-input" type="password" autoComplete="off" spellCheck={false}
                value={code} onChange={e => setCode(e.target.value)} disabled={st.busy} style={{ padding: '0.75rem' }} />
              <div className="form-hint">{T.codeNever}</div>
            </div>
            <button className="btn btn-primary btn-full btn-lg" onClick={() => p.onStart(code)} disabled={st.busy || !code.trim()}>{DRAFT.recoverButton}</button>
            {p.onBack && <button className="btn btn-ghost btn-full" onClick={p.onBack}>{DRAFT.recoverBack}</button>}
          </DeviceScreen>
        );
      case 'waiting':
        return (
          <DeviceScreen title={DRAFT.recoverTitle}>
            <Notice kind="info">{DRAFT.recoverWaiting}</Notice>
            <p>{DRAFT.recoverMail}</p>
            <p>{DRAFT.recoverCompare} <strong>{st.confirmCode}</strong></p>
            {st.removes.length > 0 && (
              <>
                <p>{DRAFT.recoverRemoves}</p>
                <ul>{st.removes.map((r, i) => <li key={i}>{r.label}</li>)}</ul>
              </>
            )}
            {st.hadPendingReset && <Notice kind="info">{DRAFT.recoverPendingClosed}</Notice>}
            {st.error && <Notice kind="error">{st.error}</Notice>}
            <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
          </DeviceScreen>
        );
      case 'finishing':
        return <DeviceScreen title={DRAFT.recoverTitle}><Notice kind="info">{DRAFT.recoverFinishing}</Notice></DeviceScreen>;
      case 'done':
        return (
          <DeviceScreen title={DRAFT.recoverTitle}>
            {st.signedIn ? <Notice kind="success">{DRAFT.recoverDone}</Notice> : <Notice kind="error">{st.error ?? DRAFT.recoverDoneNoSignin}</Notice>}
            <button className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{T.connectedContinue}</button>
          </DeviceScreen>
        );
    }
  }

  switch (st.step) {
    case 'intro':
      return (
        <DeviceScreen title={DRAFT.rotateTitle}>
          <p>{DRAFT.rotateWhy}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onRotateStart} disabled={st.busy}>{DRAFT.rotateStart}</button>
          {p.onBack && <button className="btn btn-ghost btn-full" onClick={p.onBack}>{DRAFT.recoverBack}</button>}
        </DeviceScreen>
      );
    case 'show':
      return (
        <DeviceScreen title={DRAFT.rotateNewTitle}>
          <p>{T.codeWhy}</p>
          <div className="recovery-code-print"><div className="recovery-code" data-testid="new-recovery-code">{p.newCode ?? ''}</div></div>
          <p><strong>{T.codeOnce}</strong></p>
          <p>{T.codePaper}</p>
          <button className="btn btn-secondary btn-full" onClick={() => window.print()}>{T.codePrint}</button>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <div className="form-group">
            <label className="form-label" htmlFor="rotate-old">{DRAFT.rotateOldLabel}</label>
            <input id="rotate-old" className="form-input" type="password" autoComplete="off" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} disabled={st.busy} style={{ padding: '0.75rem' }} />
          </div>
          <div className="form-group" style={{ marginBottom: '1.5rem' }}>
            <label className="form-label" htmlFor="rotate-new">{DRAFT.rotateNewLabel}</label>
            <input id="rotate-new" className="form-input" type="password" autoComplete="off" spellCheck={false} value={typed} onChange={e => setTyped(e.target.value)} disabled={st.busy} style={{ padding: '0.75rem' }} />
          </div>
          <button className="btn btn-primary btn-full btn-lg" onClick={() => p.onRotateSubmit(code, typed)} disabled={st.busy || !code.trim() || !typed.trim()}>{DRAFT.rotateSubmit}</button>
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
        </DeviceScreen>
      );
    case 'waiting':
      return (
        <DeviceScreen title={DRAFT.rotateTitle}>
          <Notice kind="info">{DRAFT.recoverWaiting}</Notice>
          <p>{DRAFT.recoverMail}</p>
          <p>{DRAFT.recoverCompare} <strong>{st.confirmCode}</strong></p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
        </DeviceScreen>
      );
    case 'finishing':
      return <DeviceScreen title={DRAFT.rotateTitle}><Notice kind="info">{DRAFT.recoverFinishing}</Notice></DeviceScreen>;
    case 'done':
      return (
        <DeviceScreen title={DRAFT.rotateTitle}>
          <Notice kind="success">{DRAFT.rotateDone}</Notice>
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{T.connectedContinue}</button>
        </DeviceScreen>
      );
  }
}

export function RecoverPage({ kind, onBack, client = deviceClient }: { kind: 'reset' | 'rotate'; onBack?: () => void; client?: DeviceClient }) {
  const { adoptSessionUser } = useAuth();
  const driver = useMemo(() => new RecoverDriver({
    client,
    open: url => { window.open(url, '_blank', 'noopener'); },
    onSignedIn: adoptSessionUser,
  }, kind), [client, kind, adoptSessionUser]);
  const state = useDriver(driver);

  useEffect(() => () => driver.dispose(), [driver]);
  useEffect(() => {
    if (state.step !== 'waiting') return;
    const t = setInterval(() => { void driver.poll(); }, 2000);
    return () => clearInterval(t);
  }, [state.step, driver]);

  return (
    <RecoverScreen
      state={state}
      newCode={driver.newRecoveryCode()}
      onStart={c => void driver.start(c)}
      onCancel={() => void driver.cancel()}
      onRotateStart={() => void driver.rotateStart()}
      onRotateSubmit={(o, n) => void driver.rotateSubmit(o, n)}
      onBack={onBack}
      onDone={() => { window.location.assign('/'); }}
    />
  );
}
