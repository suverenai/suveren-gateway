import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { T, DRAFT } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { SetupDriver, type SetupState } from '../../lib/setup-driver';
import { spClient } from '../../lib/sp-client';
import { useAuth } from '../../contexts/AuthContext';
import { LoginPage } from '../../pages/LoginPage';
import { RecoveryCodeBox } from '@suveren/approval-card/components/DeviceFrame';
import { ConnectWaiting } from './ConnectWaiting';
import { DeviceScreen, Notice, PrintScope, useDriver } from './DeviceScreen';
import { RecoverPage } from './RecoverScreens';
import { AddThisComputer } from './PairingPages';
import { PT } from '../../lib/pairing-texts';
import { PageLoading } from './StartScreens';

export interface SetupScreenProps {
  state: SetupState;
  /** The recovery code, for the one screen that shows it. */
  code: string | null;
  /** Begin the set-up again (after a cancel or a failed start). */
  onBegin: () => void;
  onConnect: () => void;
  onCancel: () => void;
  onKept: (checked: boolean) => void;
  onFinish: () => void;
  onRetrySignIn: () => void;
  onDone: () => void;
  onRecover?: () => void;
  /** This computer makes its check key at the start (one touch): say what the touch is for before the Mac asks. */
  touchForCheckKey?: boolean;
}

/** DEC-91: Connect, the recovery code with its tick and the one condition on one screen, Connected. No name screen. */
export function SetupScreen(p: SetupScreenProps) {
  const st = p.state;

  switch (st.step) {
    case 'start':
      return (
        <DeviceScreen title={T.nameTitle}>
          {st.busy && p.touchForCheckKey && <Notice kind="info">{DRAFT.touchCheckKeyWaiting}</Notice>}
          {st.error && <Notice kind="error">{st.error}</Notice>}
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onBegin} disabled={st.busy}>{T.nameTitle}</button>
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
      // Start again = cancel this set-up (its code is dropped) and begin anew from the start button.
      return (
        <ConnectWaiting error={st.error} onStartAgain={p.onCancel}>
          <button className="btn btn-ghost btn-full" onClick={p.onCancel}>{T.connectCancel}</button>
        </ConnectWaiting>
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
          <p>{T.conditionBody}</p>
          <label className="device-check">
            <input type="checkbox" checked={st.checked} disabled={st.busy} onChange={e => p.onKept(e.target.checked)} />
            <span>{T.codeKeptBox}</span>
          </label>
          <button className="btn btn-primary btn-full btn-lg" onClick={p.onFinish} disabled={!st.checked || st.busy}>{T.codeKeptButton}</button>
          <button className="btn btn-ghost btn-full" onClick={p.onCancel} disabled={st.busy}>{T.codeCancel}</button>
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
  /** After Continue on the done screen: the turning mark until the signed-in person is adopted, never a sign-in flash. */
  const [leaving, setLeaving] = useState(false);
  // Read when the set-up begins: the driver is built once, so a started set-up is never dropped when this resolves.
  const wantCheckKey = useRef(false);
  const driver = useMemo(() => new SetupDriver({ client, open: url => { window.open(url, '_blank', 'noopener'); }, wantCheckKey: () => wantCheckKey.current }), [client]);
  const state = useDriver(driver);

  // The set-up begins by itself (DEC-91), but only once the gateway has said whether this computer can make a
  // check key (one touch): it is asked first, never guessed, so a Touch ID Mac is never set up without one.
  useEffect(() => {
    let live = true;
    void (async () => {
      // Yield once first: React's development double mount runs this effect and its clean-up back to back, and
      // only the second run may begin the set-up (the first one's clean-up would drop the code it was shown).
      await Promise.resolve();
      if (!live) return;
      if (pageSessionOpen) {
        const r = await client.platformCapabilities();
        wantCheckKey.current = r.ok && (r.data as { available?: boolean }).available === true;
      }
      if (live) await driver.resume();
    })();
    return () => { live = false; driver.dispose(); };
    // Once per page: re-running would see the set-up this effect just began as "unfinished" and drop its code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, client]);
  // While the browser step is open, look at it every two seconds.
  useEffect(() => {
    if (state.step !== 'waiting') return;
    const t = setInterval(() => { void driver.poll(); }, 2000);
    return () => clearInterval(t);
  }, [state.step, driver]);

  if (recover) return <RecoverPage kind="reset" onBack={() => setRecover(false)} />;
  if (leaving) return <PageLoading />;
  return (
    <SetupScreen
      state={state}
      code={driver.recoveryCode()}
      onBegin={() => void driver.begin()}
      onConnect={() => void driver.connect()}
      onCancel={() => void driver.cancel()}
      onKept={c => driver.toggleKept(c)}
      onFinish={() => void driver.finish()}
      onRetrySignIn={() => void driver.retrySignIn()}
      onDone={() => {
        // Wait for the person to be adopted BEFORE leaving: navigating first let the guard of '/' see nobody signed in
        // and show the unlock screen for a moment (the flash after set-up).
        setLeaving(true);
        void (async () => {
          await spClient.detectDeviceDecisions();
          await adoptSessionUser();
          navigate('/', { replace: true });
        })();
      }}
      onRecover={() => setRecover(true)}
      touchForCheckKey={wantCheckKey.current}
    />
  );
}

/**
 * A password gateway whose computer has no device key yet, after the unlock: the person signs in with the account
 * key (today's sign-in, inside the page session) or, on a computer that is not set up, uses the recovery code.
 */
export function NotSetUpScreen() {
  const [view, setView] = useState<'choose' | 'key' | 'recover' | 'add'>('choose');
  if (view === 'key') return <LoginPage />;
  if (view === 'recover') return <RecoverPage kind="reset" onBack={() => setView('choose')} />;
  if (view === 'add') return <AddThisComputer onBack={() => setView('choose')} />;
  return (
    <DeviceScreen title={T.unlockTitle}>
      <Notice kind="info">{T.deviceNotSetUp}</Notice>
      <button className="btn btn-primary btn-full btn-lg" onClick={() => setView('key')}>Sign In</button>
      <button className="btn btn-secondary btn-full" onClick={() => setView('add')}>{PT.addComputerLink}</button>
      <button className="btn btn-ghost btn-full" onClick={() => setView('recover')}>{DRAFT.recoverLink}</button>
    </DeviceScreen>
  );
}
