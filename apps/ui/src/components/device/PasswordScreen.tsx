import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { T, DRAFT, textForCode } from '../../lib/device-texts';
import { turnOnTouchUnlock } from '../../lib/touch-unlock';
import { MIN_PASSWORD_LENGTH, checkNewPassword } from '../../lib/password-form';
import { deviceClient } from '../../lib/device-client';
import { spClient } from '../../lib/sp-client';
import { useAuth } from '../../contexts/AuthContext';
import { DeviceScreen, Notice } from './DeviceScreen';

export interface PasswordScreenProps {
  busy: boolean;
  error?: string;
  /** Shown once the password is set (items 10, 11). */
  success?: string;
  onSubmit: (password: string, again: string) => void;
}

/** Screen 1: set an unlock password. */
export function PasswordScreen({ busy, error, success, onSubmit }: PasswordScreenProps) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  return (
    <DeviceScreen title={T.passwordTitle}>
      <p>{T.passwordWhy}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {success && <Notice kind="success">{success}</Notice>}
      <div className="form-group">
        <label className="form-label" htmlFor="device-password">{T.passwordLabel}</label>
        <input id="device-password" className="form-input" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH}
          value={password} onChange={e => setPassword(e.target.value)} disabled={busy || Boolean(success)} style={{ padding: '0.75rem' }} />
        <div className="form-hint">{T.passwordHint}</div>
      </div>
      <div className="form-group" style={{ marginBottom: '1.5rem' }}>
        <label className="form-label" htmlFor="device-password-again">{T.passwordAgainLabel}</label>
        <input id="device-password-again" className="form-input" type="password" autoComplete="new-password"
          value={again} onChange={e => setAgain(e.target.value)} disabled={busy || Boolean(success)} style={{ padding: '0.75rem' }}
          onKeyDown={e => e.key === 'Enter' && onSubmit(password, again)} />
      </div>
      <button className="btn btn-primary btn-full btn-lg" onClick={() => onSubmit(password, again)} disabled={busy || Boolean(success)}>
        {T.passwordButton}
      </button>
    </DeviceScreen>
  );
}

/** Screen 1 on the gateway: needs the account-key sign-in that opened the page (the account key proves who sets it). */
export function SetPasswordPage() {
  const { refreshAccess, openPageSession, user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  const submit = async (password: string, again: string) => {
    const local = checkNewPassword(password, again);
    if (local) { setError(local); return; }
    const apiKey = spClient.getApiKey();
    if (!apiKey || !user) { setError(T.passwordNotSignedIn); return; }
    setBusy(true);
    setError(undefined);
    const r = await deviceClient.setPassword(apiKey, password);
    setBusy(false);
    if (!r.ok) { setError(textForCode(r.code, { screen: 'password', retryAfterSeconds: r.retryAfterSeconds })); return; }
    // 202: set, with a step still finishing in the background (item 11).
    setSuccess(r.status === 202 || r.data.rekeyPending ? T.passwordSetPending : T.passwordSet);
    openPageSession(r.data.sessionToken);
    await refreshAccess();
    // DEC-92: where this computer has Touch ID, turn unlock by Touch ID on now, with the password just set. Never
    // blocks: a cancelled touch leaves the password as the way in (Settings offers Touch ID later).
    if (!(r.status === 202 || r.data.rekeyPending)) {
      setSuccess(DRAFT.touchSetupWaiting);
      setBusy(true);
      await turnOnTouchUnlock(deviceClient, password);
      setBusy(false);
    }
    navigate('/device-setup', { replace: true });
  };

  return <PasswordScreen busy={busy} error={error} success={success} onSubmit={submit} />;
}
