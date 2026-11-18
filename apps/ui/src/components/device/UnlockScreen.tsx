import { useEffect, useMemo, useState } from 'react';
import { T } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { UnlockDriver, type UnlockState } from '../../lib/unlock-driver';
import { sessionEndText } from '../../lib/access';
import { useAuth } from '../../contexts/AuthContext';
import { DeviceScreen, Notice, useDriver } from './DeviceScreen';
import { NotSetUpScreen } from './SetupScreens';

export interface UnlockScreenProps {
  state: UnlockState;
  onPassword: (password: string) => void;
  onTouch: () => void;
  onRetry: () => void;
}

/** Screen 4 (and 6a, 6b): unlock the gateway, with Touch ID where it is on, with the password everywhere. */
export function UnlockScreen({ state, onPassword, onTouch, onRetry }: UnlockScreenProps) {
  const [password, setPassword] = useState('');
  const signingIn = state.phase === 'signing-in';
  const failed = state.phase === 'sign-in-failed';

  if (signingIn) {
    return <DeviceScreen title={T.unlockTitle}><Notice kind="info">{T.unlockSigningIn}</Notice></DeviceScreen>;
  }
  if (failed) {
    return (
      <DeviceScreen title={T.unlockTitle}>
        {state.error && <Notice kind="error">{state.error}</Notice>}
        <button className="btn btn-primary btn-full btn-lg" onClick={onRetry}>{T.unlockButton}</button>
      </DeviceScreen>
    );
  }
  const showTouch = state.touchAvailable && !state.passwordOnly;
  return (
    <DeviceScreen title={T.unlockTitle}>
      {state.notice ? <Notice kind="info">{state.notice}</Notice> : <p>{T.unlockWhy}</p>}
      {state.error && <Notice kind="error">{state.error}</Notice>}
      {showTouch && (
        <>
          <button className="btn btn-primary btn-full btn-lg" onClick={onTouch} disabled={state.touchBusy || state.busy}>
            {T.unlockTouchButton}
          </button>
          <div className="login-divider">{T.unlockOr}</div>
        </>
      )}
      <div className="form-group" style={{ marginBottom: '1.5rem' }}>
        <label className="form-label" htmlFor="unlock-password">{T.passwordLabel}</label>
        <input id="unlock-password" className="form-input" type="password" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} disabled={state.busy} style={{ padding: '0.75rem' }}
          onKeyDown={e => e.key === 'Enter' && onPassword(password)} />
      </div>
      <button className={showTouch ? 'btn btn-secondary btn-full' : 'btn btn-primary btn-full btn-lg'}
        onClick={() => onPassword(password)} disabled={state.busy || !password}>
        {T.unlockButton}
      </button>
    </DeviceScreen>
  );
}

/**
 * The page of a gateway with an unlock password, until the person is in: unlock, then sign in to the account by the
 * device key, or (no device key on this computer yet) by the account key inside the page session.
 */
export function UnlockPage({ client = deviceClient }: { client?: DeviceClient }) {
  const { openPageSession, adoptSessionUser, sessionEnd, clearSessionEnd, pageSessionOpen } = useAuth();
  const [accountKey, setAccountKey] = useState(false);
  const driver = useMemo(() => new UnlockDriver({
    client,
    onSession: openPageSession,
    onIn: adoptSessionUser,
    onAccountKey: () => setAccountKey(true),
  }, sessionEndText(sessionEnd) ?? undefined), [client, openPageSession, adoptSessionUser, sessionEnd]);
  const state = useDriver(driver);

  useEffect(() => { void driver.init(); }, [driver]);
  useEffect(() => { if (state.phase === 'done') clearSessionEnd(); }, [state.phase, clearSessionEnd]);
  // A page session that is still open (a reload cannot keep it, but a sign-in that failed can): offer the sign-in again.
  useEffect(() => { if (pageSessionOpen && state.phase === 'form') void driver.afterSession(); }, [pageSessionOpen, driver, state.phase]);

  if (accountKey) return <NotSetUpScreen />;
  return <UnlockScreen state={state} onPassword={p => void driver.withPassword(p)} onTouch={() => void driver.withTouch()} onRetry={() => void driver.retry()} />;
}
