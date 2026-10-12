/**
 * Fetch + HPKE-decrypt a mandate's intent for display on a pending-approval
 * card. One hook, used by components/ApprovalBody.tsx — the single renderer
 * shared by ApproverProposalCard (above-cap) and ActionCard (review-mode),
 * so "how intent is loaded" cannot drift between them again.
 *
 * AU5: loads eagerly (not lazy-on-click, as Phase 6 had it) — the mockup
 * always shows the intent's first two lines. The approver already has
 * standing to see it on this card.
 *
 * PE1 Finding #1: tries THIS gateway's own local gate store first
 * (GET /gate-content, exactly as AuthorizationsPage's "Mandates" page
 * reads its own intent) before asking the AS at all. A personal mandate's
 * intent is never on the AS (mandate-ceremony.ts only sends it for a team
 * mandate), so asking first always failed for one — the gate store has it
 * whenever THIS device is the one that created the mandate (team or
 * personal), which covers every self-review case; a genuine OTHER-member
 * approval (no local entry) falls back to the AS exactly as before.
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
        // PE1 Finding #1 — this gateway's own local record first (see the
        // module doc comment). A miss here is NOT an error; it just means
        // this device didn't create the mandate, so the AS is asked next.
        try {
          const local = await spClient.getGateContent(authorizationId);
          if (local?.gateContent?.intent) {
            if (live) setIntent(local.gateContent.intent);
            return;
          }
        } catch {
          // Local lookup failed (e.g. not signed in yet) — fall through to the AS.
        }
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
