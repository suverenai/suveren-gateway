/**
 * The approval card's "Give this mandate" on a gateway with a device chain: the ONE give driver (lib/use-give.ts, the same as the give
 * page) run IN PLACE on the card, from exactly the arguments the card opened and shows. No navigation, no edit step: "Edit before
 * signing" stays the separate, explicit way to change what the AI proposed (maintainer, 2026-11-20).
 *
 * The request is built from the proposal as the give page builds it from its form: the newest version of the proposed area with the
 * limits and scope carried onto it (the same helpers as Copy/Edit), the active workspace, the proposal's mode, duration and title.
 */
import { createElement, useEffect, useRef, useState } from 'react';
import type { MandateGive } from '@suveren/approval-card/host';
import { GivePhoneFooter, GiveTouchFooter, S13 } from '@suveren/approval-card/mandate-screens';
import { ResultFoot } from '@suveren/approval-card/components/ApprovalResult';
import { newestProfileOf, carryBoundsForward, carryContextForward } from '@suveren/approval-card/lib/profile-upgrade';
import { mandatePrefillGate, type CreateMandateProposalArgs } from '@suveren/approval-card/lib/create-mandate-prefill';
import { profileDisplayName } from '@suveren/approval-card/lib/profile-display';
import { spClient } from './sp-client';
import { useAuth } from '../contexts/AuthContext';
import { useDeviceChain } from './use-device-chain';
import { useGive, type GiveRequest } from './use-give';

/** The give request for an AI proposal's arguments, as the give page would send it for the same values. Null when it cannot be built. */
export async function giveRequestFromProposal(args: Record<string, unknown>, team: { groupId: string; isPersonal: boolean }): Promise<GiveRequest | null> {
  const a = args as CreateMandateProposalArgs & { title?: unknown };
  const requested = typeof a.profile === 'string' ? a.profile : '';
  const newest = newestProfileOf(requested, await spClient.listProfiles());
  if (!newest) return null;
  const profile = await spClient.getProfile(newest.id);
  const gate = mandatePrefillGate(a);
  const ttlSeconds = gate.templateTtl ?? 0;
  if (!gate.templateMode || ttlSeconds <= 0) return null;
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : profileDisplayName(newest.id);
  return {
    team: team.isPersonal ? 'personal' : team.groupId,
    profile: newest.id,
    limits: carryBoundsForward(gate.bounds, profile) as Record<string, string | number>,
    scope: carryContextForward(gate.context, profile) as Record<string, string | number>,
    intent: gate.gateContent.intent,
    mode: gate.templateMode,
    ttlSeconds,
    title,
    discloseIdentity: true,
  };
}

/** Why a give on the card did not go through, or null while it runs or once it is given. Shown at the top of the card (DEC-88). */
export function giveProblemText(i: { given: boolean; phone: { s: string; message?: string }; onPhone: boolean; error: string; touch: string; tried: boolean }): string | null {
  if (i.given) return null;
  if (i.phone.s === 'refused') return i.phone.message || S13.giveErrNotAccepted;
  if (i.phone.s === 'stopped') return S13.givePhoneStopped;
  if (!i.onPhone && i.tried && i.error && i.touch === 'offered') return i.error;
  return null;
}

export function useCardMandateGive(proposal: { id: string; tool: string }, args: Record<string, unknown> | null, o: { onClose: () => void; onGiven: () => void }): MandateGive | null {
  const chain = useDeviceChain();
  const { user, group, groupId } = useAuth();
  const [request, setRequest] = useState<GiveRequest | null>(null);
  const [started, setStarted] = useState(false);
  const argsKey = args ? JSON.stringify(args) : '';
  useEffect(() => {
    setRequest(null);
    if (!chain || !args || !groupId) return;
    let live = true;
    void giveRequestFromProposal(args, { groupId, isPersonal: !!group?.isPersonal }).then(r => { if (live) setRequest(r); }, () => { if (live) setRequest(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, argsKey, groupId, group?.isPersonal]);
  const driver = useGive(request, { chain, fromProposal: proposal.id, userId: user?.id ?? '', onGiven: o.onGiven });
  // Pressed before the plan was checked: the give starts the moment it is (never a silent click, never a give of an unchecked plan).
  const fired = useRef(false);
  useEffect(() => {
    if (!started || fired.current || !driver.prepared) return;
    fired.current = true;
    if (driver.phoneOffered) void driver.giveOnPhone();
    else void driver.give();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, driver.prepared]);
  if (!chain || !args) return null;

  const onPhone = driver.phoneOffered || driver.phoneGive.s !== 'offered';
  const start = () => { fired.current = false; setStarted(true); };
  const back = () => { fired.current = false; setStarted(false); driver.resetPhone(); };
  // Started: the card shows the give's footer until it is back at the offer (a refusal stays, with its words, never "Signed").
  const active = started;
  // It did not go through: the reason sits at the top of the card (the card renders `problem`), the mandate stays readable, and the
  // footer is ONE full-width pinned button that goes back to the card's buttons (DEC-88, as after a refused decision).
  const problem = giveProblemText({ given: !!driver.givenId, phone: driver.phoneGive, onPhone, error: driver.error, touch: driver.touchView.s, tried: fired.current });
  // One result screen after a give, however it was given (DEC-86/88): the gateway's stamp — check mark, "Signed", "Recorded", Close.
  const footer = driver.givenId
    ? createElement(GiveTouchFooter, { view: { s: 'given' }, onGive: () => {}, onBack: () => {}, onClose: o.onClose })
    : problem !== null
    ? createElement(ResultFoot, { dismiss: { label: S13.givePhoneClose, onDismiss: back } })
    : onPhone
    ? createElement(GivePhoneFooter, {
        view: { s: driver.phoneGive.s === 'refused' || driver.phoneGive.s === 'stopped' ? 'offered' : driver.phoneGive.s } as never,
        disabled: !driver.prepared,
        onGive: () => { void driver.giveOnPhone(); },
        onStop: driver.stopPhone,
        onClose: back,
      })
    : createElement(GiveTouchFooter, {
        view: !driver.prepared ? { s: 'touch' } : driver.touchView,
        disabled: !driver.prepared || !!driver.prepared.blocked || driver.busy,
        onGive: () => { void driver.give(); },
        onBack: back,
        onClose: o.onClose,
      });
  const via = driver.prepared ? (driver.phoneOffered ? 'phone' as const : 'touch' as const) : null;
  return { start, active, footer, problem, via };
}
