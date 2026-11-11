/**
 * The dashboard's line for an active mandate under an older version of its area
 * that sets none of a group's fields, while the area's newest version declares
 * that group (`scopeSchema.atLeastOne`, @hap/core/scope-rules). Such a mandate is
 * not refused — its own version declares nothing — so the person is told, with
 * the way to replace it (Edit moves it to the newest version, whose form needs
 * one of the fields).
 *
 * Generic: read from the profiles and the mandate's own local scope (the gateway's
 * gate store, never the Authority Server). No profile or field name here.
 */
import { useEffect, useState } from 'react';
import { atLeastOneGroups, unmetUnderNewerVersion, atLeastOneOlderVersionLine, type AtLeastOneProfileLike } from '@hap/core/scope-rules';
import { newestProfileOf, profileShortName } from './profile-upgrade';
import type { PendingItem, ProfileSummary } from './sp-client';

export interface OlderVersionItem {
  authorizationId: string;
  label: string;
  detail: string;
}

export const OLDER_VERSION_LABEL = 'Older version';

/** Pure: the lines for the mandates, given what was read. */
export function olderVersionItems(
  active: Array<Pick<PendingItem, 'authorization_id' | 'profile_id' | 'title' | 'frame'>>,
  newestOf: (profileId: string) => (AtLeastOneProfileLike & { version?: string }) | undefined,
  profileOf: (profileId: string) => AtLeastOneProfileLike | undefined,
  scopeOf: (authorizationId: string) => Record<string, unknown> | undefined,
): OlderVersionItem[] {
  const out: OlderVersionItem[] = [];
  for (const a of active) {
    const newer = newestOf(a.profile_id);
    const unmet = unmetUnderNewerVersion(profileOf(a.profile_id), newer, scopeOf(a.authorization_id), a.frame);
    if (!newer || unmet.length === 0) continue;
    const name = a.title ?? profileShortName(a.profile_id);
    out.push({ authorizationId: a.authorization_id, label: OLDER_VERSION_LABEL, detail: `${name} ${atLeastOneOlderVersionLine(newer, unmet[0])}` });
  }
  return out;
}

interface Reader {
  listProfiles: () => Promise<ProfileSummary[]>;
  getProfile: (id: string) => Promise<unknown>;
  getGateContent: (authorizationId: string) => Promise<{ context?: Record<string, string | number> } | null>;
}

/** Reads only what the check needs: profiles of areas whose newest version declares a group, and those mandates' scope. */
export async function loadOlderVersionItems(active: PendingItem[], reader: Reader): Promise<OlderVersionItem[]> {
  const catalog = await reader.listProfiles();
  const profiles = new Map<string, AtLeastOneProfileLike & { version?: string }>();
  const load = async (id: string) => {
    if (!profiles.has(id)) profiles.set(id, (await reader.getProfile(id)) as AtLeastOneProfileLike);
    return profiles.get(id)!;
  };
  const candidates: PendingItem[] = [];
  for (const a of active) {
    const newest = newestProfileOf(a.profile_id, catalog);
    if (!newest || newest.id === a.profile_id) continue;
    if (atLeastOneGroups(await load(newest.id)).length === 0) continue;
    await load(a.profile_id);
    candidates.push(a);
  }
  // A mandate whose scope this gateway does not hold is not pointed out: the line must be true.
  const scopes = new Map<string, Record<string, unknown>>();
  for (const a of candidates) {
    const entry = await reader.getGateContent(a.authorization_id);
    if (entry) scopes.set(a.authorization_id, entry.context ?? {});
  }
  return olderVersionItems(
    candidates.filter(a => scopes.has(a.authorization_id)),
    (id) => { const n = newestProfileOf(id, catalog); return n ? profiles.get(n.id) : undefined; },
    (id) => profiles.get(id),
    (id) => scopes.get(id),
  );
}

/** The dashboard's lines, re-read when the active mandates change. A failed read shows none and is logged. */
export function useOlderVersionItems(active: PendingItem[], reader: Reader): OlderVersionItem[] {
  const [items, setItems] = useState<OlderVersionItem[]>([]);
  const key = active.map(a => a.authorization_id).sort().join(',');
  useEffect(() => {
    let live = true;
    loadOlderVersionItems(active, reader).then(v => { if (live) setItems(v); }).catch((err) => { console.error('[dashboard] older-version check failed:', err); if (live) setItems([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return items;
}
