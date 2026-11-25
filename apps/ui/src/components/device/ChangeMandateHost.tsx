import { useEffect, useState } from 'react';
import type { MandateDiff } from '@hap/core/mandate-change';
import { ChangeMandate, S13, teamDiff, changeErrorText, GivePhoneFooter, givePhoneRefusalText, type ChangeState, type TeamTerms } from '@suveren/approval-card/mandate-screens';
import { spClient, MandateSignError } from '../../lib/sp-client';
import { afterPoll, afterRefusal, waitExpired, GIVE_PHONE_POLL_MS, type GivePhoneState } from '../../lib/give-on-phone-flow';

/**
 * Screen 5 on the gateway page: loads the gateway's prepared change (diff and team terms, computed from the signed mandate),
 * shows only the differences, and on "Change" asks the gateway to sign it with this computer's check (Touch ID). The diff shown is
 * sent back with the call: the gateway refuses a change that would differ from it.
 */
export function ChangeMandateHost({ authorizationId, changes, onChanged, onClose }: {
  authorizationId: string; changes: Record<string, unknown>; onChanged: () => void; onClose: () => void;
}) {
  const [prepared, setPrepared] = useState<{ profileName: string; diff: MandateDiff; before: TeamTerms | null; after: TeamTerms | null } | null>(null);
  const [state, setState] = useState<ChangeState>({ phase: 'review' });
  useEffect(() => {
    let live = true;
    void spClient.previewMandateChange(authorizationId, changes).then(r => {
      if (!live) return;
      if (r.ok) setPrepared({ profileName: r.profileName, diff: r.diff, before: r.before, after: r.after });
      else setState({ phase: 'error', code: r.code });
    });
    return () => { live = false; };
  }, [authorizationId, changes]);

  // DEC-90: a computer without Touch ID cannot sign the change; the person's phone can. The same footer as the give page.
  const [phone, setPhone] = useState<GivePhoneState | null>(null);
  const change = async () => {
    if (!prepared) return;
    setState({ phase: 'busy' });
    const r = await spClient.changeMandate(authorizationId, changes, prepared.diff);
    if (r.ok) { setState({ phase: 'done' }); onChanged(); return; }
    if (r.code === 'no_check_key') { setState({ phase: 'review' }); setPhone({ s: 'offered' }); return; }
    setState({ phase: 'error', code: r.code });
  };
  const sendToPhone = async () => {
    if (!prepared) return;
    setPhone({ s: 'sending' });
    try {
      const g = await spClient.changeOnPhone(authorizationId, changes, prepared.diff);
      setPhone({ s: 'waiting', mandateId: g.mandateId, expiresAt: g.expiresAt });
    } catch (e) {
      setPhone((cur) => afterRefusal(cur ?? { s: 'sending' }, e instanceof MandateSignError ? e.code : undefined, givePhoneRefusalText(e instanceof MandateSignError ? e.code : undefined, e instanceof Error ? e.message : String(e))));
    }
  };
  useEffect(() => {
    if (!phone || phone.s !== 'waiting') return undefined;
    const id = phone.mandateId;
    const t = window.setInterval(() => {
      if (waitExpired(phone, Date.now())) { setPhone({ s: 'stopped' }); return; }
      void spClient.pollGiveOnPhone(id).then(
        (a) => setPhone((cur) => (cur ? afterPoll(cur, a) : cur)),
        (e) => setPhone((cur) => (cur ? afterRefusal(cur, e instanceof MandateSignError ? e.code : undefined, givePhoneRefusalText(e instanceof MandateSignError ? e.code : undefined, e instanceof Error ? e.message : String(e))) : cur)),
      );
    }, GIVE_PHONE_POLL_MS);
    return () => window.clearInterval(t);
  }, [phone]);
  useEffect(() => { if (phone?.s === 'given') onChanged(); }, [phone?.s]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--bg-main) 70%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem', overflowY: 'auto' }}>
      <div style={{ maxWidth: 560, width: '100%' }}>
        {phone?.s === 'given' ? null : prepared
          ? <ChangeMandate profileName={prepared.profileName} diff={prepared.diff} team={teamDiff(prepared.before, prepared.after)} state={state} onChange={() => void change()} onCancel={onClose} />
          : state.phase === 'error'
            ? <div className="card"><p role="alert" className="msg-error">{changeErrorText(state.code)}</p><button type="button" className="btn btn-ghost" onClick={onClose}>{S13.changeCancel}</button></div>
            : <p>…</p>}
        {phone && (
          // Given on the phone: the shared result stamp alone in its card, centred above its Close (UI spec §17), as after a give.
          <div className={phone.s === 'given' ? 'card av3-card av3-given-alone' : 'card'} data-testid="change-on-phone">
            <GivePhoneFooter
              view={phone.s === 'waiting' ? { s: 'waiting' } : phone.s === 'refused' ? { s: 'refused', message: phone.message } : phone.s === 'given' ? { s: 'given' } : { s: phone.s }}
              onGive={() => void sendToPhone()}
              onStop={() => { if (phone.s === 'waiting') { void spClient.cancelGiveOnPhone(phone.mandateId); setPhone({ s: 'stopped' }); } }}
              onClose={onClose}
            />
          </div>
        )}
        {state.phase === 'done' && phone?.s !== 'given' && <button type="button" className="btn btn-ghost btn-full" onClick={onClose}>{S13.endClose}</button>}
      </div>
    </div>
  );
}
