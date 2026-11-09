/**
 * The team-wide running count of a mandate's cumulative limits, as the
 * Authority Server reports it (`cumulative_usage` on GET /api/authorizations/:id,
 * only to an active member of the mandate's group). This is the one source for
 * "(3 of 5 used)" in a team; the account's own tickets are never a substitute.
 */
import { useEffect, useState } from 'react';
import { spClient, type CumulativeUsageEntry } from './sp-client';

/**
 * The entry for one bound. A bound without `appliesTo` has one entry per
 * action type: with the action type known, take that one; without it, take the
 * entry only if every candidate says the same (otherwise it is ambiguous and
 * nothing is shown rather than a guess).
 */
export function usageEntryFor(
  entries: readonly CumulativeUsageEntry[] | null | undefined,
  field: string,
  actionType?: string,
): CumulativeUsageEntry | undefined {
  const mine = (entries ?? []).filter((e) => e.field === field);
  if (mine.length === 0) return undefined;
  if (actionType !== undefined) return mine.find((e) => e.action_type === actionType);
  const first = mine[0];
  return mine.every((e) => e.used === first.used && e.limit === first.limit) ? first : undefined;
}

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; p: Promise<CumulativeUsageEntry[] | null> }>();

function load(id: string): Promise<CumulativeUsageEntry[] | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const entry = { at: Date.now(), p: spClient.getAuthorizationUsage(id).catch(() => null) };
  cache.set(id, entry);
  return entry.p;
}

/** The team-wide usage of one mandate, or null while loading / not given by the server. */
export function useCumulativeUsage(authorizationId: string | undefined): CumulativeUsageEntry[] | null {
  const [entries, setEntries] = useState<CumulativeUsageEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    setEntries(null);
    if (authorizationId) void load(authorizationId).then((e) => { if (live) setEntries(e); });
    return () => { live = false; };
  }, [authorizationId]);
  return entries;
}
