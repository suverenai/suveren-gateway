import { useEffect, useState } from 'react';

/**
 * WS4 (work-plan "Added 2026-10-11 — an account is Personal OR in one
 * team"): whether THIS gateway is locked to one team by IT policy
 * (`policyLocked` includes `"team"` — see lib/policy.ts and
 * docs/managed-settings.md). Same `/health` shape + derivation pattern as
 * `useSimulationPolicy` — used by TopNav to show "· set by your IT" next
 * to the workspace pill instead of implying a control that doesn't exist.
 */
export interface WorkspacePolicyHealth {
  policyLocked?: string[];
}

export interface WorkspacePolicy {
  /** Always `false` for an older control-plane that omits `policyLocked`. */
  managed: boolean;
}

/** Pure derivation — exported for testing without a DOM / fetch mock. */
export function deriveWorkspacePolicy(
  data: WorkspacePolicyHealth | null | undefined,
): WorkspacePolicy {
  if (!data || typeof data !== 'object') return { managed: false };
  return { managed: Array.isArray(data.policyLocked) && data.policyLocked.includes('team') };
}

export function useWorkspacePolicy(): WorkspacePolicy {
  const [state, setState] = useState<WorkspacePolicy>({ managed: false });

  useEffect(() => {
    let cancelled = false;
    fetch('/health')
      .then(r => r.json())
      .then((data: WorkspacePolicyHealth) => { if (!cancelled) setState(deriveWorkspacePolicy(data)); })
      .catch(() => { /* server may be momentarily unreachable — keep last value */ });
    return () => { cancelled = true; };
  }, []);

  return state;
}
