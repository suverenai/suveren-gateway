import { useCallback, useEffect, useState } from 'react';
import { HeldBackList, heldReason, type HeldBackMandate } from '@suveren/approval-card/mandate-screens';
import { spClient } from '../../lib/sp-client';

/**
 * Screen 3 on the gateway page (approved On-hold mockup v2): the mandates this gateway holds back, as the gateway itself judged them.
 * Nothing at all when none. `titles` are the person's own mandate titles from the page's list (the card's name); `onGiveAgain` and
 * `onEnd` are the page's own flows.
 */
export function HeldBackHost({ titles, onGiveAgain, onEnd }: {
  titles?: Map<string, string>;
  onGiveAgain?: (m: HeldBackMandate) => void;
  onEnd?: (m: HeldBackMandate) => void;
}) {
  const [held, setHeld] = useState<HeldBackMandate[]>([]);
  const load = useCallback(async () => {
    const r = await spClient.getHeldBack();
    setHeld((r ?? []).map(h => ({
      mandateId: h.authorizationId, profileName: h.profileName, title: titles?.get(h.authorizationId) ?? null,
      ownerName: h.ownerName, ownerIsYou: h.ownerIsYou, reason: heldReason(h.code), adminName: h.adminName, workspace: h.workspace,
    })));
  }, [titles]);
  useEffect(() => { void load(); }, [load]);
  return <HeldBackList mandates={held} host="gateway" onGiveAgain={onGiveAgain} onEnd={onEnd} />;
}
