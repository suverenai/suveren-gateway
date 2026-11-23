import { useEffect, useRef, useState } from 'react';
import { T } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { UnlockDriver, type UnlockState } from '../../lib/unlock-driver';
import { sessionEndText } from '../../lib/access';
import { useAuth } from '../../contexts/AuthContext';
import { DeviceScreen, Notice, useDriver } from './DeviceScreen';
import { NotSetUpScreen } from './SetupScreens';
import { ShellSkeleton } from './NextPageSkeleton';
import { SkelBlock, SkelButton, SkelLine, SkelArea } from '@suveren/approval-card/components/LoadGate';

export interface UnlockScreenProps {
  state: UnlockState;
  onPassword: (password: string) => void;
  onTouch: () => void;
  onRetry: () => void;
}

const TOUCH_HINT = 'suveren.unlock.touch';
function readTouchHint(): boolean {
  try { return globalThis.localStorage?.getItem(TOUCH_HINT) === '1'; } catch { return false; }
}
function writeTouchHint(on: boolean): void {
  try { globalThis.localStorage?.setItem(TOUCH_HINT, on ? '1' : '0'); } catch { /* the hint is a convenience */ }
}

/** Screen 4 (and 6a, 6b): unlock the gateway, with Touch ID where it is on, with the password everywhere. */
export function UnlockScreen({ state, onPassword, onTouch, onRetry }: UnlockScreenProps) {
  const [password, setPassword] = useState('');
  const signingIn = state.phase === 'signing-in';
  const failed = state.phase === 'sign-in-failed';

  if (signingIn) {
    // DEC-100: after the touch or the password, the dashboard greyed out until it is there; no text that flashes.
    return <ShellSkeleton page="dashboard" />;
  }
  if (failed) {
    return (
      <DeviceScreen title={T.unlockTitle}>
        {state.error && <Notice kind="error">{state.error}</Notice>}
        <button className="btn btn-primary btn-full btn-lg" onClick={onRetry}>{T.unlockButton}</button>
      </DeviceScreen>
    );
  }
  if (!state.ready) {
    // DEC-98: the screen's own layout greyed out until it knows whether Touch ID is on — the real screen then appears
    // in one go, with the Touch ID button there from its first paint. Same blocks, same sizes: nothing moves. Whether
    // this browser saw Touch ID last time decides if the skeleton holds its place (a hint for the layout only; the
    // real button waits for the gateway's answer). A reason already known is shown at once, it does not change.
    return <UnlockSkeleton notice={state.notice} />;
  }
  const showTouch = state.touchAvailable && !state.passwordOnly;
  writeTouchHint(showTouch);
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
 * DEC-98/DEC-100: the unlock screen greyed out — its own layout until it knows whether Touch ID is on, and (with
 * `pageUnknown`) while the gateway decides which page to open. A reason already known is shown at once.
 */
export function UnlockSkeleton({ notice, pageUnknown }: { notice?: string; pageUnknown?: boolean }) {
  const touchHint = readTouchHint();
  // While it is not known yet which page opens (unlock, account-key sign-in or start), its title is greyed out too:
  // never the title of a page that may not come.
  return (
    <DeviceScreen title={pageUnknown ? undefined : T.unlockTitle}>
      {pageUnknown && <SkelArea><SkelLine w="45%" h="1.6rem" style={{ marginBottom: '1rem' }} /></SkelArea>}
      {notice && <Notice kind="info">{notice}</Notice>}
      <SkelArea>
        {!notice && <><SkelLine w="92%" style={{ marginBottom: '0.5rem' }} /><SkelLine w="70%" style={{ marginBottom: '1rem' }} /></>}
        {touchHint && <>
          <SkelButton full large />
          <div className="login-divider" style={{ visibility: 'hidden' }}>{T.unlockOr}</div>
        </>}
        <SkelLine w="30%" h="0.8rem" style={{ marginBottom: '0.5rem' }} />
        <SkelBlock h="2.9rem" style={{ marginBottom: '1.5rem' }} />
        <SkelButton full large={!touchHint} />
      </SkelArea>
    </DeviceScreen>
  );
}

/**
 * The page of a gateway with an unlock password, until the person is in: unlock, then sign in to the account by the
 * device key, or (no device key on this computer yet) by the account key inside the page session.
 */
export function UnlockPage({ client = deviceClient }: { client?: DeviceClient }) {
  const auth = useAuth();
  const [accountKey, setAccountKey] = useState(false);
  // Built ONCE per screen: opening the session changes the auth context, and a driver rebuilt then would start the
  // sign-in a second time. The callbacks are read at call time.
  const latest = useRef(auth);
  latest.current = auth;
  const driverRef = useRef<UnlockDriver | null>(null);
  if (!driverRef.current) {
    driverRef.current = new UnlockDriver({
      client,
      onSession: token => latest.current.openPageSession(token),
      onIn: () => latest.current.adoptSessionUser(),
      onAccountKey: () => setAccountKey(true),
    }, sessionEndText(auth.sessionEnd) ?? undefined);
  }
  const driver = driverRef.current;
  const state = useDriver(driver);

  useEffect(() => { void driver.init(); }, [driver]);
  useEffect(() => { if (state.phase === 'done') latest.current.clearSessionEnd(); }, [state.phase]);

  if (accountKey) return <NotSetUpScreen />;
  return <UnlockScreen state={state} onPassword={p => void driver.withPassword(p)} onTouch={() => void driver.withTouch()} onRetry={() => void driver.retry()} />;
}
