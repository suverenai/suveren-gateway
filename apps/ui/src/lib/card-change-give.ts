/**
 * The approval card's give for an AI-proposed CHANGE (`setup__change_mandate`) on a gateway with a device chain: the changed mandate is
 * given with the person's touch, exactly as on the Mandates page's Change screen (ChangeMandateHost), never by executing the proposal
 * (the gateway refuses that: a chain gateway's mandates are given, not created from an approval). Run IN PLACE on the card, from the
 * arguments the card opened and shows; the diff signed is the one sealed into the proposal (`change`), so a change that would now differ
 * from what the card shows is refused (changed_since_proposal), never signed.
 *
 * With Touch ID here, or on the person's phone where this computer has no check key. Given: the proposal is closed as `replaced`, as
 * after a give from the card (lib/use-give.ts). The phone may already hold this give (offered when the proposal arrived): the gateway
 * then waits for that one instead of preparing a second (`fromProposal`).
 */
import { createElement, useEffect, useRef, useState } from 'react';
import type { MandateGive } from '@suveren/approval-card/host';
import { GivePhoneFooter, GiveTouchFooter, S13, changeErrorText, givePhoneRefusalText, type GiveTouchView } from '@suveren/approval-card/mandate-screens';
import { ResultFoot } from '@suveren/approval-card/components/ApprovalResult';
import { spClient, MandateSignError } from './sp-client';
import { deviceClient } from './device-client';
import { useAuth } from '../contexts/AuthContext';
import { useDeviceChain } from './use-device-chain';
import { closeReplacedProposal } from './use-give';
import { afterPoll, afterRefusal, waitExpired, GIVE_PHONE_POLL_MS, type GivePhoneState } from './give-on-phone-flow';

/** The change a proposal's arguments ask for, in the shape the Change screen sends (limits, scope, mode, durationHours, intent). */
export function changesFromProposal(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.limits && typeof args.limits === 'object') out.limits = args.limits;
  if (args.scope && typeof args.scope === 'object') out.scope = args.scope;
  if (typeof args.mode === 'string') out.mode = args.mode;
  if (typeof args.duration_hours === 'number') out.durationHours = args.duration_hours;
  if (typeof args.intent === 'string') out.intent = args.intent;
  return out;
}

export function useCardChangeGive(proposal: { id: string; tool: string }, args: Record<string, unknown> | null, o: { onClose: () => void; onGiven: () => void }): MandateGive | null {
  const chain = useDeviceChain();
  const { user } = useAuth();
  const [touchHere, setTouchHere] = useState<boolean | null>(null);
  const [started, setStarted] = useState(false);
  const [touch, setTouch] = useState<GiveTouchView>({ s: 'offered' });
  const [phone, setPhone] = useState<GivePhoneState>({ s: 'offered' });
  const [onPhone, setOnPhone] = useState(false);
  const [givenId, setGivenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const mandateId = args && typeof args.mandate_id === 'string' ? args.mandate_id : '';
  const sealedDiff = args?.change;
  const changes = args ? changesFromProposal(args) : null;

  useEffect(() => {
    if (!chain) return;
    let live = true;
    void deviceClient.platformCapabilities().then(r => { if (live) setTouchHere(r.ok ? r.data.checkKey === true : false); }, () => { if (live) setTouchHere(false); });
    return () => { live = false; };
  }, [chain]);

  const given = (authorizationId: string) => {
    setGivenId(authorizationId);
    o.onGiven();
    void closeReplacedProposal(proposal.id, user?.id ?? '').then(p => { if (p) setError(`Your mandate is changed. The AI's proposal could not be withdrawn (${p}) — reject it under Approvals.`); });
  };

  const sendToPhone = async () => {
    if (!changes || !mandateId || !sealedDiff) return;
    setOnPhone(true);
    setPhone({ s: 'sending' });
    try {
      const g = await spClient.changeOnPhone(mandateId, changes, sealedDiff, proposal.id);
      setPhone({ s: 'waiting', mandateId: g.mandateId, expiresAt: g.expiresAt });
    } catch (e) {
      const code = e instanceof MandateSignError ? e.code : undefined;
      setPhone(cur => afterRefusal(cur, code, givePhoneRefusalText(code, e instanceof Error ? e.message : S13.giveErrNotAccepted)));
    }
  };

  const giveHere = async () => {
    if (!changes || !mandateId || !sealedDiff || busy.current) return;
    busy.current = true;
    setError('');
    setTouch({ s: 'touch' });
    try {
      const r = await spClient.changeMandate(mandateId, changes, sealedDiff, proposal.id);
      if (r.ok) { setTouch({ s: 'given' }); given(mandateId); return; }
      setTouch({ s: 'offered' });
      // No check key on this computer after all: the person's phone gives it (DEC-90), as on the Change screen.
      if (r.code === 'no_check_key') { void sendToPhone(); return; }
      setError(changeErrorText(r.code === 'cancelled' ? 'cancelled' : r.code));
    } finally {
      busy.current = false;
    }
  };

  const fired = useRef(false);
  useEffect(() => {
    if (!started || fired.current || touchHere === null) return;
    fired.current = true;
    if (touchHere) void giveHere(); else void sendToPhone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, touchHere]);

  const waitingId = phone.s === 'waiting' ? phone.mandateId : '';
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  useEffect(() => {
    if (!waitingId) return;
    let live = true;
    const t = setInterval(() => {
      if (!live) return;
      if (waitExpired(phoneRef.current, Date.now())) { setPhone({ s: 'stopped' }); return; }
      void spClient.pollGiveOnPhone(waitingId).then(
        a => { if (live) setPhone(st => afterPoll(st, a)); },
        e => { const code = e instanceof MandateSignError ? e.code : undefined; if (live) setPhone(st => afterRefusal(st, code, givePhoneRefusalText(code, S13.giveErrNotAccepted))); },
      );
    }, GIVE_PHONE_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [waitingId]);
  useEffect(() => {
    if (phone.s === 'given') given(phone.authorizationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.s]);

  if (!chain || !args || !mandateId || !sealedDiff) return null;

  const back = () => { fired.current = false; setStarted(false); setOnPhone(false); setPhone({ s: 'offered' }); setTouch({ s: 'offered' }); setError(''); };
  const problem = givenId ? null
    : phone.s === 'refused' ? phone.message || S13.giveErrNotAccepted
    : phone.s === 'stopped' ? S13.givePhoneStopped
    : !onPhone && error ? error
    : null;
  const footer = givenId
    ? createElement(GiveTouchFooter, { view: { s: 'given' }, onGive: () => {}, onBack: () => {}, onClose: o.onClose })
    : problem !== null
    ? createElement(ResultFoot, { dismiss: { label: S13.givePhoneClose, onDismiss: back } })
    : onPhone
    ? createElement(GivePhoneFooter, {
        view: { s: phone.s === 'refused' || phone.s === 'stopped' ? 'offered' : phone.s } as never,
        onGive: () => { void sendToPhone(); },
        onStop: () => { if (phone.s === 'waiting') void spClient.cancelGiveOnPhone(phone.mandateId); setPhone({ s: 'stopped' }); },
        onClose: back,
      })
    : createElement(GiveTouchFooter, { view: touch, disabled: touchHere === null, onGive: () => { void giveHere(); }, onBack: back, onClose: o.onClose });
  return {
    start: () => { fired.current = false; setStarted(true); },
    active: started,
    footer,
    problem,
    via: touchHere === null ? null : touchHere ? 'touch' : 'phone',
  };
}
