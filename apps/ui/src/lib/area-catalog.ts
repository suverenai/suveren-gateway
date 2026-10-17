/**
 * The full profile catalog, fetched once per page load and shared by every
 * surface that resolves an area's name (UI spec §13.1 — "the newest version
 * of that profile the gateway knows"). Same per-load-cache shape as
 * lib/profile-cache.ts's `loadProfile`/`useProfile`, kept separate because
 * that module caches ONE profile per ref; this one caches the WHOLE catalog
 * (every version of every profile `/api/profiles` returns) so
 * `resolveAreaName` can compare versions within a family.
 */
import { useEffect, useState } from 'react';
import { spClient, type ProfileSummary } from './sp-client';
import { resolveAreaName, type AreaCatalogEntry } from './area';

let cache: Promise<ProfileSummary[]> | null = null;

/** Fetches `/api/profiles` once per page load; failure resolves to an empty
 *  catalog, never rejects — callers fall back to `resolveAreaName`'s own
 *  no-catalog behaviour (today's capitalised-short-id display). */
export function loadAreaCatalog(): Promise<ProfileSummary[]> {
  if (!cache) {
    cache = spClient.listProfiles().catch(() => []);
  }
  return cache;
}

/** The catalog, or `[]` while loading / on failure. */
export function useAreaCatalog(): AreaCatalogEntry[] {
  const [catalog, setCatalog] = useState<AreaCatalogEntry[]>([]);
  useEffect(() => {
    let live = true;
    loadAreaCatalog().then(c => { if (live) setCatalog(c); });
    return () => { live = false; };
  }, []);
  return catalog;
}

/** Convenience: the area name for a profile id, using the shared catalog. */
export function useAreaName(profileId: string): string {
  const catalog = useAreaCatalog();
  return resolveAreaName(profileId, catalog);
}
