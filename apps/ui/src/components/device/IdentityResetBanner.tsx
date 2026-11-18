import { useEffect, useMemo, useState } from 'react';
import { T, DRAFT, identityResetText } from '../../lib/device-texts';
import { DeviceClient, deviceClient } from '../../lib/device-client';
import { ResetDriver, type ResetState } from '../../lib/reset-driver';
import { useAuth } from '../../contexts/AuthContext';
import { useSSEEvent } from '../../contexts/EventSourceContext';
import { Notice, useDriver } from './DeviceScreen';

export function IdentityResetNotice({ state, nowSeconds, onCancel }: { state: ResetState; nowSeconds: number; onCancel: () => void }) {
  if (state.cancelled && !state.pending) return <Notice kind="success">{T.identityResetCancelled}</Notice>;
  if (!state.pending) return null;
  return (
    <div className="alert alert-error identity-reset-banner" role="alert">
      <span>{identityResetText(state.pending.effectiveAt, nowSeconds)}</span>
      {state.error && <span>{state.error}</span>}
      <button className="btn btn-primary btn-sm" onClick={onCancel} disabled={state.busy}>
        {state.busy ? DRAFT.cancelling : T.identityResetCancel}
      </button>
    </div>
  );
}

/** The alarm for a pending request for a new identity, above every page. Reads the status; the event is only the doorbell. */
export function IdentityResetBanner({ client = deviceClient }: { client?: DeviceClient }) {
  const { access, user } = useAuth();
  const driver = useMemo(() => new ResetDriver(client), [client]);
  const state = useDriver(driver);
  const active = access === 'password' && Boolean(user);
  // The hours left tick: the banner is re-read against the clock every minute.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => { if (active) void driver.refresh(); }, [active, driver]);
  useSSEEvent('identity-reset-pending', () => { if (active) void driver.refresh(); });
  useSSEEvent('identity-reset-cleared', () => { if (active) void driver.refresh(); });

  if (!active) return null;
  return <IdentityResetNotice state={state} nowSeconds={now} onCancel={() => void driver.cancel()} />;
}
