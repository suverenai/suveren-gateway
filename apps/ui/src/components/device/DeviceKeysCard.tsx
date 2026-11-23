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
      <article className="ob-card su-card">
        <div className="su-row">
          <div><h3 className="ob-title">{T.passwordTitle}</h3></div>
          <div className="ob-btns"><Link className="ob-btn is-solid" to="/device-password">{T.passwordTitle}</Link></div>
        </div>
      </article>
    );
  }
  if (access !== 'password' || setUp === null) return null;
  if (!setUp) {
    return (
      <article className="ob-card su-card">
        <div className="su-row">
          <div><h3 className="ob-title">{T.nameTitle}</h3></div>
          <div className="ob-btns"><Link className="ob-btn is-solid" to="/device-setup">{T.nameTitle}</Link></div>
        </div>
        <TouchUnlockSection />
      </article>
    );
  }
  // The same card as its siblings on Settings (ob-card su-card: title, one muted line, grey buttons at the side).
  return (
    <article className="ob-card su-card" data-testid="device-keys-card">
      {/* DEC-96: the card is about devices first (it was titled only "Recovery code"); Devices also has its own menu entry. */}
      <AddCheckKeySection />
      <div className="ob-part su-row">
        <div>
          <h3 className="ob-title">{DRAFT.deviceKeysCardTitle}</h3>
          <p className="ob-one">{PT.devSettingsBody}</p>
        </div>
        <div className="ob-btns"><Link className="ob-btn" to="/devices">{PT.devSettingsLink}</Link></div>
      </div>
      <div className="ob-part su-row">
        <div>
          <h3 className="ob-title">{DRAFT.deviceCardTitle}</h3>
          <p className="ob-one">{DRAFT.deviceCardBody}</p>
          <p className="ob-one">{DRAFT.rotateWhy}</p>
        </div>
        <div className="ob-btns"><Link className="ob-btn" to="/device-recovery-code">{DRAFT.rotateTitle}</Link></div>
      </div>
      <TouchUnlockSection />
    </article>
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
      <div className="ob-part">
        <h3 className="ob-title">{DRAFT.touchCardTitle}</h3>
        <p className="ob-one">{done ? DRAFT.touchCardDone : DRAFT.touchCardOn}</p>
      </div>
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
    <div className="ob-part">
      <h3 className="ob-title">{DRAFT.touchCardTitle}</h3>
      <p className="ob-one">{DRAFT.touchCardBody}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {busy && <Notice kind="info">{DRAFT.touchSetupWaiting}</Notice>}
      <div className="form-group" style={{ margin: '0.75rem 0' }}>
        <label className="form-label" htmlFor="touch-unlock-password">{T.passwordLabel}</label>
        <input id="touch-unlock-password" className="form-input" type="password" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} disabled={busy}
          onKeyDown={e => e.key === 'Enter' && void turnOn()} />
      </div>
      <div className="ob-btns" style={{ marginTop: 0 }}>
        <button type="button" className="ob-btn is-solid" onClick={() => void turnOn()} disabled={busy || !password}>{DRAFT.touchCardButton}</button>
      </div>
    </div>
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
    <div className="ob-part su-row" data-testid="addcheck-section">
      <div>
        <h3 className="ob-title">{DRAFT.addCheckTitle}</h3>
        <p className="ob-one">{DRAFT.addCheckCardBody}</p>
      </div>
      <div className="ob-btns"><Link className="ob-btn is-solid" to="/device-check-key">{DRAFT.addCheckButton}</Link></div>
    </div>
  );
}
