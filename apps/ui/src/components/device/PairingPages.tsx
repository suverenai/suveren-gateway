/**
 * The pairing pages of the gateway (device-keys plan 4.3, step 11): the Devices page and "Add a phone" inside the app shell, and
 * "Add this computer" on the screen of a computer that is not set up yet. They connect the screens (PairingScreens.tsx) to the
 * control plane through the driver; the words are lib/pairing-texts.ts. Everything is behind the device-keys switch.
 */
import { LoadGate, Gated, SkelBlock, SkelButton, SkelLine, SkelTitle, SkelArea, useNetworkSettled } from '@suveren/approval-card/components/LoadGate';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { DeviceClient, deviceClient, type DevicesAnswer } from '../../lib/device-client';
import { PairingDriver, isWaiting, type PairingFlow } from '../../lib/pairing-driver';
import { textForCode } from '../../lib/device-texts';
import { pairingErrorText } from '../../lib/pairing-texts';
import { spClient } from '../../lib/sp-client';
import { useAuth } from '../../contexts/AuthContext';
import { TopNav } from '../TopNav';
import { UpdateBanner } from '../UpdateBanner';
import { useDriver } from './DeviceScreen';
import { AddComputerScreen, AddPhoneScreen, DevicesScreen } from './PairingScreens';
import { DashboardPasskeyRow, DashboardPasskeyScreen, useDashboardPasskeys } from './DashboardPasskeyHost';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** While a step waits on the other device, look at it every two seconds. */
function usePairingDriver(client: DeviceClient, flow: PairingFlow) {
  const driver = useMemo(() => new PairingDriver({ client, flow }), [client, flow]);
  const state = useDriver(driver);
  useEffect(() => { void driver.resume(); }, [driver]);
  // A pairing is left behind when the page is: nothing is cancelled here (the control plane forgets it at its own end), so a reload resumes it.
  const waiting = isWaiting(state.view);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { void driver.poll(); }, 2000);
    return () => clearInterval(t);
  }, [waiting, driver]);
  return { driver, state };
}

/** The Devices page: this account's devices from the chain this computer verified, and "Add a phone". */
export function DevicesPage({ client = deviceClient }: { client?: DeviceClient }) {
  const { deviceKeysSwitch } = useAuth();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DevicesAnswer | null>(null);
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(async () => {
    const r = await client.devices();
    if (r.ok) { setDevices(r.data); setError(undefined); } else { setDevices(null); setError(pairingErrorText(r.code) === textForCode(undefined) ? textForCode(r.code) : pairingErrorText(r.code)); }
  }, [client]);
  useEffect(() => { if (deviceKeysSwitch) void load(); }, [deviceKeysSwitch, load]);
  // A passkey for the dashboard that waits for one of this person's devices (AS step 17): a row here, the shared card full screen.
  const passkeys = useDashboardPasskeys(client);
  const [passkeyOpen, setPasskeyOpen] = useState(false);
  if (!deviceKeysSwitch) return <Navigate to="/" replace />;
  if (passkeyOpen && passkeys.answer && passkeys.answer.pending.length > 0) {
    return <DashboardPasskeyScreen answer={passkeys.answer} client={client} onDone={() => { setPasskeyOpen(false); void passkeys.reload(); }} />;
  }
  return (
    <LoadGate parts={['devices']}>
      <DevicesGated ready={devices !== null || error !== undefined}>
        <div style={{ maxWidth: '28rem', margin: '1rem auto 0', padding: '0 1rem' }}>
          <DashboardPasskeyRow count={passkeys.answer?.pending.length ?? 0} onOpen={() => setPasskeyOpen(true)} />
        </div>
        <DevicesScreen devices={devices} nowSeconds={nowSeconds()} error={error}
          onAddPhone={() => navigate('/devices/add-phone')} onRefresh={() => { void load(); void passkeys.reload(); }} onBack={() => navigate('/settings')} />
      </DevicesGated>
    </LoadGate>
  );
}

/** DEC-98: the device list and the passkey row appear together, once the list and every other load of the page are in. */
function DevicesGated({ ready, children }: { ready: boolean; children: ReactNode }) {
  const settled = useNetworkSettled();
  return <Gated part="devices" ready={ready && settled} skeleton={<DevicesSkeleton />}>{children}</Gated>;
}

function DevicesSkeleton() {
  return (
    <div className="device-page"><div className="device-screen" data-testid="devices-skeleton">
      <SkelArea>
        <SkelTitle w="55%" />
        {[0, 1].map(i => (
          <div key={i} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.9rem' }}>
            <SkelBlock w="2.25rem" h="2.25rem" radius="50%" />
            <div style={{ flex: 1 }}><SkelLine w="45%" style={{ marginBottom: '0.4rem' }} /><SkelLine w="70%" h="0.7rem" /></div>
          </div>
        ))}
        <SkelLine w="35%" style={{ margin: '1rem 0 0.5rem' }} />
        <SkelBlock h="1.6rem" style={{ marginBottom: '1.25rem' }} />
        <SkelButton full large />
      </SkelArea>
    </div></div>
  );
}

/** "Add a phone": this computer admits the phone app. */
export function AddPhonePage({ client = deviceClient }: { client?: DeviceClient }) {
  const { deviceKeysSwitch } = useAuth();
  const navigate = useNavigate();
  const { driver, state } = usePairingDriver(client, 'admit');
  if (!deviceKeysSwitch) return <Navigate to="/" replace />;
  const leave = () => { void driver.cancel().then(() => navigate('/devices')); };
  return (
    <AddPhoneScreen state={state} nowSeconds={nowSeconds()}
      onStart={() => void driver.start()} onChoose={c => void driver.choose(c)}
      onCancel={() => void driver.cancel()}
      onDone={() => (state.view.flow === 'admit' && state.view.step === 'done' ? navigate('/devices') : leave())} />
  );
}

/** The frame of a screen outside the app shell (a computer that is not signed in): the top bar, then the screen. */
function Standalone({ children }: { children: ReactNode }) {
  return <><TopNav /><UpdateBanner />{children}</>;
}

/**
 * "Add this computer": on the screen of a computer that has no account yet (after the unlock), the phone admits it. When it is added
 * and signed in, the page takes the signed-in user and goes to the start.
 */
export function AddThisComputer({ client = deviceClient, onBack }: { client?: DeviceClient; onBack: () => void }) {
  const { adoptSessionUser } = useAuth();
  const navigate = useNavigate();
  const { driver, state } = usePairingDriver(client, 'join');
  // The person leaves in the middle of a ceremony: the control plane is told, so the phone stops too.
  const live = useRef(state.view);
  live.current = state.view;
  return (
    <Standalone>
      <AddComputerScreen state={state} nowSeconds={nowSeconds()}
        onStart={() => void driver.start()} onConfirm={l => void driver.confirm(l)}
        onCancel={() => void driver.cancel()}
        onBack={() => { if (live.current.flow !== 'none') void driver.cancel(); onBack(); }}
        onRetrySignIn={() => void driver.retrySignIn()}
        onDone={() => { void spClient.detectDeviceDecisions(); void adoptSessionUser(); navigate('/', { replace: true }); }} />
    </Standalone>
  );
}
