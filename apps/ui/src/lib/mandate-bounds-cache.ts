/**
 * The mandate's own bound VALUES for "Within your limits" (AU5) — fetched
 * once per page load and indexed by authorizationId, the same fetch-once
 * pattern as lib/profile-cache.ts. Local only: `getEnrichedAuthorizations`
 * never touches the Authority Server (see its own doc comment in
 * lib/sp-client.ts) — this stays privacy-blind the same way.
 */
import { useEffect, useState } from 'react';
import { spClient } from './sp-client';

let allPromise: Promise<Map<string, Record<string, string | number>>> | null = null;

function loadAll(): Promise<Map<string, Record<string, string | number>>> {
  if (!allPromise) {
    allPromise = spClient.getEnrichedAuthorizations()
      .then((list) => new Map(list.map((a) => [a.authorizationId, a.bounds])))
      .catch(() => new Map());
  }
  return allPromise;
}

/** The mandate's bound values for one authorization, or undefined while
 *  loading / when it cannot be found (old grant, unknown id) — callers fall
 *  back to showing nothing rather than a guess (see limitChecks). */
export function useMandateBounds(authorizationId: string | undefined): Record<string, string | number> | undefined {
  const [bounds, setBounds] = useState<Record<string, string | number> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!authorizationId) return;
    void loadAll().then((map) => { if (live) setBounds(map.get(authorizationId)); });
    return () => { live = false; };
  }, [authorizationId]);
  return bounds;
}
