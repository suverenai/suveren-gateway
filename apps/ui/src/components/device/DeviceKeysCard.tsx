import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceClient } from '../../lib/device-client';
import { DRAFT, T, textForCode } from '../../lib/device-texts';
import { PT } from '../../lib/pairing-texts';
import { useAuth } from '../../contexts/AuthContext';
import { Notice } from '@suveren/approval-card/components/DeviceFrame';

/**
 * Settings: this computer's device keys. With the switch on there is always a way to the next step:
 * no unlock password yet → set it; password but this computer not set up → set it up; set up → recovery code and devices.
 * Touch ID unlock (DEC-92) wherever the computer can do it, once there is an unlock password.
 */
export function DeviceKeysCard() {
  const { access, deviceKeysSwitch, passwordSet } = useAuth();
  const [setUp, setSetUp] = useState<boolean | null>(null);
  useEffect(() => {
    if (access !== 'password') return;
    void deviceClient.status().then(r => setSetUp(r.ok && r.data.setUp === true));
  }, [access]);
  if (!deviceKeysSwitch) return null;

  if (!passwordSet) {
    return (
      <div className="card">
        <h3 className="card-title">{T.passwordTitle}</h3>
        <Link className="btn btn-primary" to="/device-password" style={{ textDecoration: 'none' }}>{T.passwordTitle}</Link>
      </div>
    );
  }
  if (access !== 'password' || setUp === null) return null;
  if (!setUp) {
    return (
      <div className="card">
        <h3 className="card-title">{T.nameTitle}</h3>
        <Link className="btn btn-primary" to="/device-setup" style={{ textDecoration: 'none' }}>{T.nameTitle}</Link>
        <div style={{ marginTop: '1.5rem' }}><TouchUnlockSection /></div>
      </div>
    );
  }
  return (
    <div className="card" data-testid="device-keys-card">
      {/* DEC-96: the card is about devices first (it was titled only "Recovery code"); Devices also has its own menu entry. */}
      <h3 className="card-title">{DRAFT.deviceKeysCardTitle}</h3>
      <AddCheckKeySection />
      {setUp && (
        <>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{PT.devSettingsBody}</p>
          <Link className="btn btn-secondary" to="/devices" style={{ textDecoration: 'none' }}>{PT.devSettingsLink}</Link>
          <h3 className="card-title" style={{ marginTop: '1.5rem' }}>{DRAFT.deviceCardTitle}</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{DRAFT.deviceCardBody}</p>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{DRAFT.rotateWhy}</p>
          <Link className="btn btn-secondary" to="/device-recovery-code" style={{ textDecoration: 'none' }}>{DRAFT.rotateTitle}</Link>
        </>
      )}
      <div style={{ marginTop: '1.5rem' }}><TouchUnlockSection /></div>
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

/** A computer set up without Touch ID cannot give mandates: offer to turn Touch ID on for approvals (recovery code + email link). */
function AddCheckKeySection() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    void deviceClient.platformCapabilities().then(r => setShow(r.ok && r.data.available === true && r.data.checkKey === false));
  }, []);
  if (!show) return null;
  return (
    <div style={{ marginBottom: '1.5rem' }} data-testid="addcheck-section">
      <h3 className="card-title">{DRAFT.addCheckTitle}</h3>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{DRAFT.addCheckCardBody}</p>
      <Link className="btn btn-primary" to="/device-check-key" style={{ textDecoration: 'none' }}>{DRAFT.addCheckButton}</Link>
    </div>
  );
}
