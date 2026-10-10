/**
 * Fetch + HPKE-decrypt a mandate's intent for display on a pending-approval
 * card. One hook, used by components/ApprovalBody.tsx — the single renderer
 * shared by ApproverProposalCard (above-cap) and ActionCard (review-mode),
 * so "how intent is loaded" cannot drift between them again.
 *
 * AU5: loads eagerly (not lazy-on-click, as Phase 6 had it) — the mockup
 * always shows the intent's first two lines. The approver already has
 * standing to see it on this card.
 */
import { useEffect, useState } from 'react';
import { spClient } from './sp-client';

export interface ProposalIntentState {
  intent: string | null;
  loading: boolean;
  error: string | null;
}

export function useProposalIntent(authorizationId: string, currentUserId: string): ProposalIntentState {
  const [intent, setIntent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setIntent(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const intentData = await spClient.getAttestationIntent(authorizationId);
        if (!intentData) {
          if (live) setError('Intent not available or you are not an authorized approver.');
          return;
        }
        const decrypted = await spClient.decryptIntent({
          intentCiphertext: intentData.intentCiphertext,
          encryptedKey: intentData.encryptedKey,
          approverId: currentUserId,
        });
        if (live) setIntent(decrypted);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Failed to decrypt intent');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [authorizationId, currentUserId]);

  return { intent, loading, error };
}
