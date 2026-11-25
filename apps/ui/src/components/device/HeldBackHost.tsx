import { useMemo } from 'react';
import { HeldBackList, heldReason, type HeldBackMandate, type HeldReason } from '@suveren/approval-card/mandate-screens';
import type { spClient } from '../../lib/sp-client';

/** One verdict of this gateway, as GET /api/mandate/held-back sends it. */
export type HeldRaw = NonNullable<Awaited<ReturnType<typeof spClient.getHeldBack>>>[number];

/** The reasons the page shows as a card or in "Waiting for someone else" — and therefore never as Active in the list. */
export function isHeldShown(r: HeldReason): boolean {
  return r !== 'not_received' && r !== 'ended';
}

/**
 * Screen 3 on the gateway page (approved On-hold mockup v2): the mandates this gateway holds back, as the gateway itself judged them.
 * Nothing at all when none. `held` is the page's own load of the gateway's verdicts (the list uses the same one); `titles` are the
 * mandates' own titles from the page's list (the card's name; the area only as fallback); `onGiveAgain` and `onEnd` are the page's flows.
 */
export function HeldBackHost({ held, titles, onGiveAgain, onEnd }: {
  held: HeldRaw[];
  titles?: Map<string, string>;
  onGiveAgain?: (m: HeldBackMandate) => void;
  onEnd?: (m: HeldBackMandate) => void;
}) {
  const mandates = useMemo<HeldBackMandate[]>(() => held.map(h => ({
    mandateId: h.authorizationId, profileName: h.profileName, title: titles?.get(h.authorizationId) ?? h.title ?? null,
    ownerName: h.ownerName, ownerIsYou: h.ownerIsYou, reason: heldReason(h.code), adminName: h.adminName, workspace: h.workspace,
  })), [held, titles]);
  return <HeldBackList mandates={mandates} host="gateway" onGiveAgain={onGiveAgain} onEnd={onEnd} />;
}
