import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceClient } from '../../lib/device-client';
import { DRAFT } from '../../lib/device-texts';
import { useAuth } from '../../contexts/AuthContext';

/** Settings: replace the recovery code. Only on a gateway with an unlock password, where this computer is set up. */
export function DeviceKeysCard() {
  const { access } = useAuth();
  const [setUp, setSetUp] = useState(false);
  useEffect(() => {
    if (access !== 'password') return;
    void deviceClient.status().then(r => setSetUp(r.ok && r.data.setUp === true));
  }, [access]);
  if (access !== 'password' || !setUp) return null;
  return (
    <div className="card">
      <h3 className="card-title">{DRAFT.deviceCardTitle}</h3>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{DRAFT.deviceCardBody}</p>
      <Link className="btn btn-secondary" to="/device-recovery-code" style={{ textDecoration: 'none' }}>{DRAFT.rotateTitle}</Link>
    </div>
  );
}
