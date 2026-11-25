import { useCallback, useEffect, useState } from 'react';
import { HeldBackList, heldReason, type HeldBackMandate } from '@suveren/approval-card/mandate-screens';
import { spClient } from '../../lib/sp-client';

/** Screen 3 on the gateway page: the mandates this gateway holds back, as the gateway itself judged them. Nothing at all when none. */
export function HeldBackHost({ onGiveAgain }: { onGiveAgain?: (mandateId: string) => void }) {
  const [held, setHeld] = useState<HeldBackMandate[]>([]);
  const load = useCallback(async () => {
    const r = await spClient.getHeldBack();
    setHeld((r ?? []).map(h => ({ mandateId: h.authorizationId, profileName: h.profileName, ownerName: h.ownerName, ownerIsYou: h.ownerIsYou, reason: heldReason(h.code), adminName: h.adminName })));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <HeldBackList mandates={held} onCheckAgain={() => { void spClient.resyncGates().catch(() => {}).then(load); }} onGiveAgain={onGiveAgain} />;
}
