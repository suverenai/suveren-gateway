import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceClient } from '../../lib/device-client';
import { DRAFT, T } from '../../lib/device-texts';
import { PT } from '../../lib/pairing-texts';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Settings: this computer's device keys. With the switch on there is always a way to the next step:
 * no unlock password yet → set it; password but this computer not set up → set it up; set up → recovery code and devices.
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
      </div>
    );
  }
  return (
    <div className="card">
      <h3 className="card-title">{DRAFT.deviceCardTitle}</h3>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{DRAFT.deviceCardBody}</p>
      <Link className="btn btn-secondary" to="/device-recovery-code" style={{ textDecoration: 'none' }}>{DRAFT.rotateTitle}</Link>
      <h3 className="card-title" style={{ marginTop: '1.5rem' }}>{PT.devicesTitle}</h3>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{PT.devSettingsBody}</p>
      <Link className="btn btn-secondary" to="/devices" style={{ textDecoration: 'none' }}>{PT.devSettingsLink}</Link>
    </div>
  );
}
