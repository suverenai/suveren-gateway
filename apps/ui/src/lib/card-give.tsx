/**
 * The approval card's "Give this mandate" on a gateway with a device chain: the ONE give driver (lib/use-give.ts, the same as the give
 * page) run IN PLACE on the card, from exactly the arguments the card opened and shows. No navigation, no edit step: "Edit before
 * signing" stays the separate, explicit way to change what the AI proposed (Andreas, 2026-11-20).
 *
 * The request is built from the proposal as the give page builds it from its form: the newest version of the proposed area with the
 * limits and scope carried onto it (the same helpers as Copy/Edit), the active workspace, the proposal's mode, duration and title.
 */
import { createElement, useEffect, useRef, useState } from 'react';
import type { MandateGive } from '@suveren/approval-card/host';
import { GivePhoneFooter, GiveTouchFooter } from '@suveren/approval-card/mandate-screens';
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

export function useCardMandateGive(proposal: { id: string; tool: string }, args: Record<string, unknown> | null, o: { onClose: () => void }): MandateGive | null {
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
  const driver = useGive(request, { chain, fromProposal: proposal.id, userId: user?.id ?? '' });
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
  const errorLine = driver.error ? createElement('p', { className: 'msg-error av3-error', role: 'alert', 'data-testid': 'card-give-error' }, driver.error) : null;
  const footer = onPhone
    ? createElement('div', null, errorLine, createElement(GivePhoneFooter, {
        view: driver.phoneGive.s === 'refused' ? { s: 'refused', message: driver.phoneGive.message } : { s: driver.phoneGive.s },
        disabled: !driver.prepared,
        onGive: () => { void driver.giveOnPhone(); },
        onStop: driver.stopPhone,
        onClose: () => { if (driver.phoneGive.s === 'given') o.onClose(); else back(); },
      }))
    : createElement('div', null, errorLine, createElement(GiveTouchFooter, {
        view: driver.givenId ? { s: 'given' } : !driver.prepared ? { s: 'touch' } : driver.touchView,
        disabled: !driver.prepared || !!driver.prepared.blocked || driver.busy,
        onGive: () => { void driver.give(); },
        onBack: back,
        onClose: o.onClose,
      }));
  return { start, active, footer };
}
