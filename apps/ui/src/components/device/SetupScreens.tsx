import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { T, DRAFT } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { SetupDriver, type SetupState } from '../../lib/setup-driver';
import { spClient } from '../../lib/sp-client';
import { useAuth } from '../../contexts/AuthContext';
import { LoginPage } from '../../pages/LoginPage';
import { RecoveryCodeBox } from '@suveren/approval-card/components/DeviceFrame';
import { DeviceScreen, Notice, PrintScope, useDriver } from './DeviceScreen';
import { RecoverPage } from './RecoverScreens';

export interface SetupScreenProps {
  state: SetupState;
  /** The recovery code, for the one screen that shows it. */
  code: string | null;
  onName: (label: string) => void;
  onConnect: () => void;
  onCancel: () => void;
  onCodeSeen: () => void;
  onKept: (checked: boolean) => void;
  onContinue: () => void;
  onUnderstand: () => void;
  onRetrySignIn: () => void;
  onDone: () => void;
  onRecover?: () => void;
}

/** Screens 2 and 3: name this computer, Connect, the recovery code, did you keep it, the one condition, Connected. */
export function SetupScreen(p: SetupScreenProps) {
  const [label, setLabel] = useState('');
  const st = p.state;

  switch (st.step) {
    case 'name':
      return (
        <DeviceScreen title={T.nameTitle}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <div className="form-group" style={{ marginBottom: '1.5rem' }}>
            <label className="form-label" htmlFor="device-name">{T.nameLabel}</label>
            <input id="device-name" className="form-input" value={label} maxLength={64} onChange={e => setLabel(e.target.value)}
              disabled={st.busy} style={{ padding: '0.75rem' }} onKeyDown={e => e.key === 'Enter' && label.trim() && p.onName(label)} />
            <div className="form-hint">{T.nameHint}</div>
          </div>
          <button className="btn btn-primary btn-full btn-lg" onClick={() => p.onName(label)} disabled={st.busy || !label.trim()}>{T.nameButton}</button>
          {p.onRecover && <button className="btn btn-ghost btn-full" onClick={p.onRecover}>{DRAFT.recoverLink}</button>}
        </DeviceScreen>
      );
    case 'stuck':
      return (
        <DeviceScreen title={T.nameTitle}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onCancel} disabled={st.busy}>{T.connectCancel}</button>
        </DeviceScreen>
      );
    case 'connect':
      return (
        <DeviceScreen title={T.connectTitle}>
          <p>{T.connectWhy}</p>
          <p>{T.connectHow}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onConnect} disabled={st.busy}>{T.connectButton}</button>
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
        </DeviceScreen>
      );
    case 'waiting':
      return (
        <DeviceScreen title={T.connectTitle}>
          <Notice kind="info">{T.connectWaiting}</Notice>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
        </DeviceScreen>
      );
    case 'code':
      return (
        <DeviceScreen title={T.codeTitle}>
          <PrintScope />
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <p>{T.codeWhy}</p>
          <RecoveryCodeBox code={p.code ?? ''} />
          <p><strong>{T.codeOnce}</strong></p>
          <p>{T.codePaper}</p>
          <p style={{ fontSize: '0.875rem' }}>{T.codeNever}</p>
          <button className="btn btn-secondary btn-full" onClick={() => window.print()}>{T.codePrint}</button>
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onCodeSeen}>{T.codeKeptButton}</button>
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.codeCancel}</button>
        </DeviceScreen>
      );
    case 'kept':
      return (
        <DeviceScreen title={T.codeKeptTitle}>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <label className="device-check">
            <input type="checkbox" checked={st.checked} onChange={e => p.onKept(e.target.checked)} />
            <span>{T.codeKeptBox}</span>
          </label>
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onContinue} disabled={!st.checked}>{T.codeKeptButton}</button>
        </DeviceScreen>
      );
    case 'condition':
      return (
        <DeviceScreen title={T.conditionTitle}>
          <p>{T.conditionBody}</p>
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onUnderstand} disabled={st.busy}>{T.conditionButton}</button>
        </DeviceScreen>
      );
    case 'connected':
      return (
        <DeviceScreen title={T.connectedTitle}>
          {st.account && st.signedIn && <Notice kind="success">{T.connectedAs(st.account.name, st.account.email)}</Notice>}
          {st.error && <Notice kind="error">{st.error}</Notice>}
          {st.signedIn
            ? <button className="btn btn-primary btn-full btn-lg" onClick={p.onDone}>{T.connectedContinue}</button>
            : <button className="btn btn-primary btn-full btn-lg" onClick={p.onRetrySignIn} disabled={st.busy}>{DRAFT.tryAgain}</button>}
        </DeviceScreen>
      );
  }
}

/** The set-up of this computer, on the gateway page (signed in, with a page session). */
export function SetupPage({ client = deviceClient }: { client?: DeviceClient }) {
  const { adoptSessionUser, pageSessionOpen } = useAuth();
  const navigate = useNavigate();
  const [recover, setRecover] = useState(false);
  // Read when Continue is pressed: the driver is built once, so a started set-up is never dropped when this resolves.
  const wantCheckKey = useRef(false);
  const driver = useMemo(() => new SetupDriver({ client, open: url => { window.open(url, '_blank', 'noopener'); }, wantCheckKey: () => wantCheckKey.current }), [client]);
  const state = useDriver(driver);

  useEffect(() => { void driver.resume(); return () => driver.dispose(); }, [driver]);
  // This computer makes a check key (one touch) only where it can: the gateway says so, we never guess.
  useEffect(() => {
    if (!pageSessionOpen) return;
    void client.platformCapabilities().then(r => { wantCheckKey.current = r.ok && (r.data as { available?: boolean }).available === true; });
  }, [client, pageSessionOpen]);
  // While the browser step is open, look at it every two seconds.
  useEffect(() => {
    if (state.step !== 'waiting') return;
    const t = setInterval(() => { void driver.poll(); }, 2000);
    return () => clearInterval(t);
  }, [state.step, driver]);

  if (recover) return <RecoverPage kind="reset" onBack={() => setRecover(false)} />;
  return (
    <SetupScreen
      state={state}
      code={driver.recoveryCode()}
      onName={l => void driver.continueWithName(l)}
      onConnect={() => void driver.connect()}
      onCancel={() => void driver.cancel()}
      onCodeSeen={() => driver.codeSeen()}
      onKept={c => driver.toggleKept(c)}
      onContinue={() => driver.kept()}
      onUnderstand={() => void driver.understand()}
      onRetrySignIn={() => void driver.retrySignIn()}
      onDone={() => { void spClient.detectDeviceDecisions(); void adoptSessionUser(); navigate('/', { replace: true }); }}
      onRecover={() => setRecover(true)}
    />
  );
}

/**
 * A password gateway whose computer has no device key yet, after the unlock: the person signs in with the account
 * key (today's sign-in, inside the page session) or, on a computer that is not set up, uses the recovery code.
 */
export function NotSetUpScreen() {
  const [view, setView] = useState<'choose' | 'key' | 'recover'>('choose');
  if (view === 'key') return <LoginPage />;
  if (view === 'recover') return <RecoverPage kind="reset" onBack={() => setView('choose')} />;
  return (
    <DeviceScreen title={T.unlockTitle}>
      <Notice kind="info">{T.deviceNotSetUp}</Notice>
      <button className="btn btn-primary btn-full btn-lg" onClick={() => setView('key')}>Sign In</button>
      <button className="btn btn-ghost btn-full" onClick={() => setView('recover')}>{DRAFT.recoverLink}</button>
    </DeviceScreen>
  );
}
