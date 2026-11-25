/**
 * The ONE give driver on a gateway with a device chain (maintainer, 2026-11-20): the give page and the approval card both use it, so a
 * mandate the person gives and one the AI proposed are given the same way — prepare (what the gateway checked), then Touch ID on this
 * computer or, where it has no check key, the phone (DEC-90); the progress the gateway reports; the result. Only the screens around it
 * differ (the page's form, the card's sealed view of the proposal).
 *
 * `fromProposal`: the AI proposal this give is for. Once the mandate is live it is closed with outcome `replaced` (the AI uses the
 * mandate, it is never run as a second one), after a give here and after a give on the phone alike.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { spClient, MandateSignError, type PreparedMandate } from './sp-client';
import { afterProgress, giveErrorText, givePhoneRefusalText, S13, type GiveTouchView } from '@suveren/approval-card/mandate-screens';
import { phoneGiveOffered, afterPoll, afterRefusal, phoneGiveBusy, waitExpired, GIVE_PHONE_POLL_MS, type GivePhoneState } from './give-on-phone-flow';
import { replacedOutcomeArgs, replacedWithdrawRoute } from '@suveren/approval-card/lib/reject-outcome';
import { replacedRevokeProblem } from './mandate-replace';

export interface GiveRequest {
  team: string;
  profile: string;
  limits: Record<string, string | number>;
  scope: Record<string, string | number>;
  contextLabels?: Record<string, Record<string, string>>;
  intent: string;
  mode: 'review' | 'automatic';
  ttlSeconds: number;
  title: string;
  discloseIdentity: boolean;
  replaces?: string;
}

export interface GiveDriver {
  prepared: PreparedMandate | null;
  prepareError: string;
  /** Look at the plan again (an approver confirmed, the plan changed). */
  recheck: () => void;
  touchView: GiveTouchView;
  phoneGive: GivePhoneState;
  /** This computer cannot give it, a phone of the chain can. */
  phoneOffered: boolean;
  /** The mandate is live: its id. */
  givenId: string | null;
  error: string;
  busy: boolean;
  give: () => Promise<void>;
  giveOnPhone: () => Promise<void>;
  stopPhone: () => void;
  /** Back from a stopped or refused phone give to the offer. */
  resetPhone: () => void;
}

/** Close the AI proposal a give was for: outcome `replaced`; the route depends on who decides it. Returns a problem, or ''. */
export async function closeReplacedProposal(proposalId: string, userId: string): Promise<string> {
  try {
    const proposal = await spClient.getProposal(proposalId);
    if (proposal.status !== 'pending') return '';
    const route = replacedWithdrawRoute(proposal, userId);
    if (!route) return 'you are not one of the people who may decide it';
    if (route.route === 'approver') await spClient.rejectProposal(proposalId, replacedOutcomeArgs());
    else await spClient.resolveProposal(proposalId, 'reject', route.domain, replacedOutcomeArgs());
    return '';
  } catch (e) {
    // Closed meanwhile by this gateway's own completion (a give taken in from the phone closes its request at once): nothing to do.
    const now = await spClient.getProposal(proposalId).catch(() => null);
    if (now && now.status !== 'pending') return '';
    return e instanceof Error ? e.message : 'unknown error';
  }
}

const closeProblemText = (problem: string) => `Your mandate is given and active. The AI's proposal could not be withdrawn (${problem}) — reject it under Approvals.`;

export function useGive(request: GiveRequest | null, o: { chain: boolean; fromProposal?: string; userId: string; onGiven?: () => void }): GiveDriver {
  const [prepared, setPrepared] = useState<PreparedMandate | null>(null);
  const [prepareError, setPrepareError] = useState('');
  const [tick, setTick] = useState(0);
  const [touchView, setTouchView] = useState<GiveTouchView>({ s: 'offered' });
  const [phoneGive, setPhoneGive] = useState<GivePhoneState>({ s: 'offered' });
  const [givenId, setGivenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onProgress = useCallback((payload: unknown) => {
    setTouchView(v => afterProgress(v, (payload as { stage?: unknown } | null)?.stage));
  }, []);
  useSSEEvent('give-progress', onProgress);

  const key = request ? JSON.stringify(request) : '';
  useEffect(() => {
    if (!o.chain || !request) { setPrepared(null); return; }
    let live = true;
    const t = setTimeout(() => {
      void spClient.prepareMandate(request as unknown as Record<string, unknown>).then(r => {
        if (!live) return;
        if (r.ok) { setPrepared(r.prepared); setPrepareError(''); } else { setPrepared(null); setPrepareError(r.message); }
      });
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.chain, key, tick]);
  const recheck = useCallback(() => setTick(t => t + 1), []);

  const give = async () => {
    if (!request || !prepared || busy) return;
    setBusy(true);
    setError('');
    setTouchView({ s: 'touch' });
    try {
      const { authorizationId, revokeError } = await spClient.signMandate({ ...request, planHash: prepared.planHash, ...(o.fromProposal ? { fromProposal: o.fromProposal } : {}) });
      const revokeProblem = replacedRevokeProblem(revokeError);
      // The mandate is live: say so first (the card stays on screen with the stamp), then close the proposal it was for.
      setGivenId(authorizationId);
      setTouchView({ s: 'given' });
      o.onGiven?.();
      const closeProblem = o.fromProposal ? await closeReplacedProposal(o.fromProposal, o.userId) : '';
      if (revokeProblem) setError(revokeProblem);
      else if (closeProblem) setError(closeProblemText(closeProblem));
    } catch (e) {
      setTouchView({ s: 'offered' });
      if (e instanceof MandateSignError) {
        if (e.code === 'approver_identity_unconfirmed' || e.code === 'changed_since_prepare' || e.code === 'prepare_required') recheck();
        if (e.code !== 'approver_identity_unconfirmed') setError(giveErrorText({ code: e.code, reason: e.reason }));
      } else {
        setError(e instanceof Error ? e.message : S13.giveErrNotAccepted);
      }
    } finally {
      setBusy(false);
    }
  };

  const phoneOffered = o.chain && phoneGiveOffered(prepared);
  const giveOnPhone = async () => {
    if (!request || !prepared || phoneGiveBusy(phoneGive)) return;
    setError('');
    setPhoneGive({ s: 'sending' });
    try {
      const r = await spClient.giveOnPhone({ ...request, planHash: prepared.planHash, ...(o.fromProposal ? { fromProposal: o.fromProposal } : {}) });
      setPhoneGive({ s: 'waiting', mandateId: r.mandateId, expiresAt: r.expiresAt });
    } catch (e) {
      const code = e instanceof MandateSignError ? e.code : undefined;
      if (code === 'changed_since_prepare' || code === 'prepare_required') recheck();
      setPhoneGive(st => afterRefusal(st, code, givePhoneRefusalText(code, e instanceof MandateSignError ? giveErrorText({ code: e.code, reason: e.reason }) : S13.giveErrNotAccepted)));
    }
  };
  const stopPhone = () => {
    if (phoneGive.s === 'waiting') void spClient.cancelGiveOnPhone(phoneGive.mandateId);
    setPhoneGive({ s: 'stopped' });
  };
  const resetPhone = () => setPhoneGive({ s: 'offered' });

  const phoneRef = useRef(phoneGive);
  phoneRef.current = phoneGive;
  const waitingId = phoneGive.s === 'waiting' ? phoneGive.mandateId : '';
  useEffect(() => {
    if (!waitingId) return;
    let live = true;
    const t = setInterval(() => {
      if (!live) return;
      if (waitExpired(phoneRef.current, Date.now())) { setPhoneGive({ s: 'stopped' }); return; }
      void spClient.pollGiveOnPhone(waitingId).then(
        a => { if (live) setPhoneGive(st => afterPoll(st, a)); },
        e => {
          const code = e instanceof MandateSignError ? e.code : undefined;
          if (live) setPhoneGive(st => afterRefusal(st, code, givePhoneRefusalText(code, e instanceof MandateSignError ? giveErrorText({ code: e.code, reason: e.reason }) : S13.giveErrNotAccepted)));
        },
      );
    }, GIVE_PHONE_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [waitingId]);
  useEffect(() => {
    if (phoneGive.s !== 'given') return;
    setGivenId(phoneGive.authorizationId);
    o.onGiven?.();
    if (phoneGive.revokeError) setError(replacedRevokeProblem(phoneGive.revokeError) || phoneGive.revokeError);
    if (o.fromProposal) void closeReplacedProposal(o.fromProposal, o.userId).then(p => { if (p) setError(closeProblemText(p)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneGive.s]);

  return { prepared, prepareError, recheck, touchView, phoneGive, phoneOffered, givenId, error, busy, give, giveOnPhone, stopPhone, resetPhone };
}
