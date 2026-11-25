import { useEffect, useState } from 'react';
import { spClient } from './sp-client';

/**
 * The approved toolArgs of a proposal THIS gateway executed, from its own
 * evidence archive (`GET /api/evidence/proposal/:id`). The Authority Server
 * deletes a proposal's content once its ticket is issued (DEC-22 retention),
 * so a decided proposal's arguments live on only here. `null` while loading,
 * when this device never executed it, or when the archive cannot be read —
 * the caller then uses the Authority Server's copy as before. Pass `null` to
 * skip (a pending proposal: its content is still on the AS).
 */
export function useArchivedProposalArgs(proposalId: string | null): Record<string, unknown> | null {
  const [args, setArgs] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let live = true;
    setArgs(null);
    if (!proposalId) return;
    spClient.getArchivedProposalArgs(proposalId)
      .then(a => { if (live) setArgs(a); })
      .catch(() => { /* archive unreadable: keep null, the AS copy stands */ });
    return () => { live = false; };
  }, [proposalId]);
  return args;
}
