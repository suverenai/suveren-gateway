import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceClient } from '../../lib/device-client';
import { DRAFT, T, textForCode } from '../../lib/device-texts';
import { PT } from '../../lib/pairing-texts';
import { useAuth } from '../../contexts/AuthContext';
import { Notice } from '@suveren/approval-card/components/DeviceFrame';

/**
 * Settings: this computer's device keys, on a gateway with an unlock password. Touch ID unlock (DEC-92) wherever the
 * computer can do it; the recovery code and the devices once this computer is set up.
 */
export function DeviceKeysCard() {
  const { access } = useAuth();
  const [setUp, setSetUp] = useState(false);
  useEffect(() => {
    if (access !== 'password') return;
    void deviceClient.status().then(r => setSetUp(r.ok && r.data.setUp === true));
  }, [access]);
  if (access !== 'password') return null;
  return (
    <div className="card">
      <TouchUnlockSection />
      {setUp && (
        <>
          <h3 className="card-title" style={{ marginTop: '1.5rem' }}>{DRAFT.deviceCardTitle}</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{DRAFT.deviceCardBody}</p>
          <Link className="btn btn-secondary" to="/device-recovery-code" style={{ textDecoration: 'none' }}>{DRAFT.rotateTitle}</Link>
          <h3 className="card-title" style={{ marginTop: '1.5rem' }}>{PT.devicesTitle}</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{PT.devSettingsBody}</p>
          <Link className="btn btn-secondary" to="/devices" style={{ textDecoration: 'none' }}>{PT.devSettingsLink}</Link>
        </>
      )}
    </div>
  );
}

/** Turn unlock by Touch ID on for a computer set up before it was on: the unlock password, then the touch. */
function TouchUnlockSection() {
  const [caps, setCaps] = useState<{ available: boolean; on: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  useEffect(() => {
    void deviceClient.platformCapabilities().then(r => setCaps(r.ok ? { available: r.data.available === true, on: r.data.unlockEnabled === true } : null));
  }, []);
  if (!caps || !caps.available) return null;
  if (caps.on || done) {
    return (
      <>
        <h3 className="card-title">{DRAFT.touchCardTitle}</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>{done ? DRAFT.touchCardDone : DRAFT.touchCardOn}</p>
      </>
    );
  }
  const turnOn = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(undefined);
    const r = await deviceClient.enablePlatform(password);
    setBusy(false);
    if (!r.ok) { setError(textForCode(r.code, { screen: 'unlock', retryAfterSeconds: r.retryAfterSeconds })); return; }
    setPassword('');
    setDone(true);
  };
  return (
    <>
      <h3 className="card-title">{DRAFT.touchCardTitle}</h3>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{DRAFT.touchCardBody}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {busy && <Notice kind="info">{DRAFT.touchSetupWaiting}</Notice>}
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label className="form-label" htmlFor="touch-unlock-password">{T.passwordLabel}</label>
        <input id="touch-unlock-password" className="form-input" type="password" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} disabled={busy}
          onKeyDown={e => e.key === 'Enter' && void turnOn()} />
      </div>
      <button className="btn btn-primary" onClick={() => void turnOn()} disabled={busy || !password}>{DRAFT.touchCardButton}</button>
    </>
  );
}
