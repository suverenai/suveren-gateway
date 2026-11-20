import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DRAFT, T } from '../../lib/device-texts';
import { deviceClient, type DeviceClient } from '../../lib/device-client';
import { CheckKeyDriver, type CheckKeyState } from '../../lib/check-key-driver';
import { CodeInput, DeviceScreen, Notice, useDriver } from './DeviceScreen';
import { PageLoading } from './StartScreens';

export interface CheckKeyScreenProps {
  state: CheckKeyState;
  onSubmit: (code: string, password: string) => void;
  onCancel: () => void;
  onBack: () => void;
  onDone: () => void;
}

/** Turn on Touch ID for approvals on a computer set up without it: recovery code + unlock password, touch, email link, touch. */
export function CheckKeyScreen(p: CheckKeyScreenProps) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const st = p.state;
  switch (st.step) {
    case 'form':
      return (
        <DeviceScreen title={DRAFT.addCheckTitle}>
          <p>{DRAFT.addCheckWhy}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <div className="form-group">
            <label className="form-label" htmlFor="addcheck-code">{DRAFT.recoverCodeLabel}</label>
            <CodeInput id="addcheck-code" value={code} onChange={setCode} disabled={st.busy} />
            <div className="form-hint">{T.codeNever}</div>
          </div>
          <div className="form-group" style={{ marginBottom: '1.5rem' }}>
            <label className="form-label" htmlFor="addcheck-password">{T.passwordLabel}</label>
            <input id="addcheck-password" className="form-input" type="password" autoComplete="current-password"
              value={password} onChange={e => setPassword(e.target.value)} disabled={st.busy} />
            <div className="form-hint">{DRAFT.addCheckPasswordHint}</div>
          </div>
          <button className="btn btn-primary btn-full btn-lg" data-testid="addcheck-submit"
            onClick={() => p.onSubmit(code, password)} disabled={st.busy || !code.trim() || !password}>{DRAFT.addCheckButton}</button>
          <button className="btn btn-ghost btn-full" onClick={p.onBack}>{DRAFT.recoverBack}</button>
        </DeviceScreen>
      );
    case 'touch-key':
      return <DeviceScreen title={DRAFT.addCheckTitle}><Notice kind="info">{DRAFT.touchCheckKeyWaiting}</Notice></DeviceScreen>;
    case 'waiting':
      return (
        <DeviceScreen title={DRAFT.addCheckTitle}>
          <Notice kind="info">{DRAFT.recoverWaiting}</Notice>
          <p>{DRAFT.recoverMail}</p>
          <p>{DRAFT.recoverCompare} <strong data-testid="addcheck-confirm-code">{st.confirmCode}</strong></p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
        </DeviceScreen>
      );
    case 'finishing':
      return <PageLoading />;
    case 'touch-unlock':
      return <DeviceScreen title={DRAFT.addCheckTitle}><Notice kind="info">{DRAFT.touchSetupWaiting}</Notice></DeviceScreen>;
    case 'done':
      return (
        <DeviceScreen title={DRAFT.addCheckTitle}>
          <Notice kind="success">{st.unlockOn ? DRAFT.addCheckDone : DRAFT.addCheckDoneNoUnlock}</Notice>
          <button className="btn btn-primary btn-full btn-lg" data-testid="addcheck-done" onClick={p.onDone}>{T.connectedContinue}</button>
        </DeviceScreen>
      );
  }
}

export function CheckKeyPage({ client = deviceClient }: { client?: DeviceClient }) {
  const navigate = useNavigate();
  const driver = useMemo(() => new CheckKeyDriver({ client, open: url => { window.open(url, '_blank', 'noopener'); } }), [client]);
  const state = useDriver(driver);
  useEffect(() => () => driver.dispose(), [driver]);
  useEffect(() => {
    if (state.step !== 'waiting') return;
    const t = setInterval(() => { void driver.poll(); }, 2000);
    return () => clearInterval(t);
  }, [state.step, driver]);
  return (
    <CheckKeyScreen
      state={state}
      onSubmit={(c, pw) => void driver.submit(c, pw)}
      onCancel={() => void driver.cancel()}
      // In the app, not a page load: a load would drop the page session held in memory.
      onBack={() => navigate('/settings', { replace: true })}
      onDone={() => navigate('/settings', { replace: true })}
    />
  );
}
