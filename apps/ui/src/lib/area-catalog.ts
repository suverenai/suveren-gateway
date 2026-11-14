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
import { resolveAreaName, registerConnectorAreaIcons, type AreaCatalogEntry } from './area';

let cache: Promise<ProfileSummary[]> | null = null;

/** Fetches `/api/profiles` once per page load; failure resolves to an empty
 *  catalog, never rejects — callers fall back to `resolveAreaName`'s own
 *  no-catalog behaviour (today's capitalised-short-id display). */
export function loadAreaCatalog(): Promise<ProfileSummary[]> {
  if (!cache) {
    // The connector manifests come with it: each area's icon is the one its
    // connector declares (lib/area.ts `registerConnectorAreaIcons`). They are
    // registered BEFORE the catalog resolves, so every surface that re-renders
    // on the catalog draws the connector's icon. A failed manifest fetch
    // leaves the fallback icons; it never fails the catalog.
    cache = Promise.all([
      spClient.listProfiles().catch(() => [] as ProfileSummary[]),
      spClient.getIntegrationManifests()
        .then(r => registerConnectorAreaIcons(r.manifests))
        .catch(() => undefined),
    ]).then(([profiles]) => profiles);
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
