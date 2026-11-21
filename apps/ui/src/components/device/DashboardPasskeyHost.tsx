/**
 * The gateway page's side of a dashboard passkey (AS step 17, the device side): a row on the Devices page when one waits, and the
 * shared full-screen card (packages/approval-card DashboardPasskeyCard, the same the phone shows) to approve it with Touch ID.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardPasskeyCard, PASSKEY_TEXT, passkeyRefusalText, type PasskeyCardView } from '@suveren/approval-card/components/DashboardPasskeyCard';
import { DeviceClient, deviceClient, type DashboardPasskeysAnswer } from '../../lib/device-client';
import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';

/** The waiting passkeys, read when the page opens and again on demand. */
export function useDashboardPasskeys(client: DeviceClient = deviceClient) {
  const [answer, setAnswer] = useState<DashboardPasskeysAnswer | null>(null);
  const load = useCallback(async () => {
    const r = await client.dashboardPasskeys();
    setAnswer(r.ok ? r.data : null);
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  return { answer, reload: load };
}

/** The row that leads to the card. Nothing when none waits. */
export function DashboardPasskeyRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <div className="alert alert-info" role="status" data-testid="passkey-waiting-row" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', justifyContent: 'space-between' }}>
      <span>{PASSKEY_TEXT.waitingRow}</span>
      <button type="button" className="btn btn-primary" style={{ minHeight: 44 }} onClick={onOpen} data-testid="passkey-open">{PASSKEY_TEXT.open}</button>
    </div>
  );
}

/** The card, full screen, for the first waiting passkey; drives the approval with this computer's Touch ID. */
export function DashboardPasskeyScreen({ answer, client = deviceClient, onDone }: { answer: DashboardPasskeysAnswer; client?: DeviceClient; onDone: () => void }) {
  const item = answer.pending[0];
  const [view, setView] = useState<PasskeyCardView>({ s: 'offered' });
  const gen = useRef(0);
  if (!item) return null;
  const approve = async () => {
    const g = ++gen.current;
    setView({ s: 'touch' });
    const r = await client.approveDashboardPasskey(item.requestId);
    if (g !== gen.current) return;
    setView(r.ok ? { s: 'added' } : { s: 'offered', error: passkeyRefusalText(r.code ?? '') });
  };
  return (
    <DeviceFrame>
      <DashboardPasskeyCard
        request={{ code: item.code, email: item.account.email, credentialAt: item.credentialAt, expiresAt: item.expiresAt }}
        view={view} canApprove={answer.canApprove}
        onApprove={() => void approve()}
        onCancel={() => { gen.current++; setView({ s: 'offered' }); }}
        onClose={onDone} />
    </DeviceFrame>
  );
}
