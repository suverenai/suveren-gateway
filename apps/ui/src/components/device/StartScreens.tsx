import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { T, DRAFT, textForCode } from '../../lib/device-texts';
import { deviceClient, type ConnectAccount } from '../../lib/device-client';
import { checkNewPassword } from '../../lib/password-form';
import { turnOnTouchUnlock } from '../../lib/touch-unlock';
import { useAuth } from '../../contexts/AuthContext';
import { DeviceScreen, Notice } from './DeviceScreen';
import { PasswordScreen } from './PasswordScreen';

type Step =
  | { step: 'connect'; busy: boolean; error?: string }
  | { step: 'waiting' }
  | { step: 'password'; account: ConnectAccount; busy: boolean; error?: string; success?: string };

/**
 * DEC-93 + DEC-91: the set-up of a gateway nobody has used, without an account key. Connect first (the one-time
 * start session), then the unlock password (the vault is created bound to the connected account; Touch ID is turned
 * on where this computer has it, DEC-92), then set-up continues with the recovery code. The start token lives only in
 * this component's memory.
 */
export function StartPage() {
  const navigate = useNavigate();
  const { openPageSession, refreshAccess } = useAuth();
  const [st, setSt] = useState<Step>({ step: 'connect', busy: false });
  const token = useRef<string | null>(null);

  // Only a gateway that may still start this way shows it; any other goes to the ordinary sign-in.
  useEffect(() => {
    void deviceClient.startStatus().then(r => { if (!r.ok || !r.data.available) navigate('/login', { replace: true }); });
  }, [navigate]);

  const connect = async () => {
    if (st.step !== 'connect' || st.busy) return;
    setSt({ step: 'connect', busy: true });
    if (!token.current) {
      const o = await deviceClient.startOpen();
      if (!o.ok) { setSt({ step: 'connect', busy: false, error: textForCode(o.code, { screen: 'connect' }) }); return; }
      token.current = o.data.startToken;
    }
    const c = await deviceClient.startConnect(token.current);
    if (!c.ok) { setSt({ step: 'connect', busy: false, error: textForCode(c.code, { screen: 'connect' }) }); return; }
    window.open(c.data.authorizeUrl, '_blank', 'noopener');
    setSt({ step: 'waiting' });
  };

  // While the browser step runs: look every 2 seconds.
  useEffect(() => {
    if (st.step !== 'waiting' || !token.current) return;
    const t = token.current;
    const id = window.setInterval(() => {
      void deviceClient.startConnectStatus(t).then(r => {
        if (!r.ok) { setSt({ step: 'connect', busy: false, error: textForCode(r.code, { screen: 'connect' }) }); return; }
        if (r.data.state === 'waiting') return;
        if (r.data.state === 'ready' && r.data.account) { setSt({ step: 'password', account: r.data.account, busy: false }); return; }
        const code = r.data.state === 'expired' ? 'connect_timeout' : (r.data.code ?? 'connect_failed');
        setSt({ step: 'connect', busy: false, error: textForCode(code, { screen: 'connect' }) });
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, [st.step]);

  const setPassword = async (password: string, again: string) => {
    if (st.step !== 'password' || st.busy || !token.current) return;
    const local = checkNewPassword(password, again);
    if (local) { setSt({ ...st, error: local }); return; }
    setSt({ ...st, busy: true, error: undefined });
    const r = await deviceClient.startPassword(token.current, password);
    if (!r.ok) { setSt({ ...st, busy: false, error: textForCode(r.code, { screen: 'password', retryAfterSeconds: r.retryAfterSeconds }) }); return; }
    token.current = null;
    openPageSession(r.data.sessionToken);
    await refreshAccess();
    // DEC-92: Touch ID on where this computer has it, in the same step. Never blocks.
    setSt({ ...st, busy: true, success: DRAFT.touchSetupWaiting });
    await turnOnTouchUnlock(deviceClient, password);
    navigate('/device-setup', { replace: true });
  };

  if (st.step === 'password') {
    return (
      <>
        <PasswordScreen busy={st.busy} error={st.error} success={st.success} onSubmit={(p, a) => void setPassword(p, a)} />
        <p className="text-muted" style={{ textAlign: 'center' }}>{T.startConnectedAs(st.account.name, st.account.email)}</p>
      </>
    );
  }
  if (st.step === 'waiting') {
    return (
      <DeviceScreen title={T.connectTitle}>
        <Notice kind="info">{T.connectWaiting}</Notice>
      </DeviceScreen>
    );
  }
  return (
    <DeviceScreen title={DRAFT.startTitle}>
      <p>{DRAFT.startWhy}</p>
      <p>{T.connectHow}</p>
      {st.error && <Notice kind="error">{st.error}</Notice>}
      <button className="btn btn-primary btn-full btn-lg" onClick={() => void connect()} disabled={st.busy}>{T.connectButton}</button>
    </DeviceScreen>
  );
}

/**
 * The ordinary sign-in, unless this gateway may still start without an account key (DEC-93): then the start page.
 * The sign-in renders at once (the page never waits on the answer); a new gateway moves on to /start when it comes.
 */
export function LoginOrStart({ switchOn, children }: { switchOn: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!switchOn) return;
    let live = true;
    void deviceClient.startStatus().then(r => { if (live && r.ok && r.data.available) navigate('/start', { replace: true }); });
    return () => { live = false; };
  }, [switchOn, navigate]);
  return <>{children}</>;
}
