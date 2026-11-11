/**
 * The names a person knows, for values the gateway stores as codes: a
 * connector by its manifest's `name`, a document source (`connector:kind`) by
 * its manifest title, an area (a profile short name) by the profile's name.
 * Only the gateway's own data — the manifests it ships and the profile catalog
 * it serves — never a list in code and never a lookup into another system. A
 * code nothing names stays as it is, never a guess.
 *
 * Which kind of value a scope field holds comes from its profile declaration:
 * `format: "connector:kind"` for document sources, `valuesFrom: "profiles"` for
 * areas. Any other field shows its values as stored (addresses, domains, ids).
 */
import { useEffect, useState } from 'react';
import { spClient } from './sp-client';
import { attachmentSourceLabel, isAttachmentSourceField, parseSources, type SourceManifestLike } from './attachment-sources';
import { resolveAreaName, type AreaCatalogEntry } from './area';
import { valuesFromProfiles } from './profile-valued-options';

/** What the names come from; either part may still be loading (undefined/empty). */
export interface NameSources {
  /** Connector manifests plus the built-in groups' names (`getLabelManifests`). */
  manifests?: SourceManifestLike[];
  /** The profile catalog (`useAreaCatalog`). */
  catalog?: readonly AreaCatalogEntry[];
}

/** A connector (or built-in group) by its manifest name; the id when none names it. */
export function connectorName(id: string, manifests: SourceManifestLike[] | undefined): string {
  return manifests?.find((m) => m.id === id)?.name?.trim() || id;
}

/** One stored value of a scope field, by the name a person knows. */
export function scopeValueName(def: unknown, value: string, src: NameSources): string {
  if (isAttachmentSourceField(def as { format?: string } | undefined)) return attachmentSourceLabel(src.manifests, value);
  // An area name only when the catalog knows it: an unknown code stays as it is.
  if (valuesFromProfiles(def) && src.catalog?.length) return resolveAreaName(value, src.catalog);
  return value;
}

/** A stored comma-separated value of a scope field, each part by its name. */
export function scopeValueNames(def: unknown, value: string, src: NameSources): string {
  return parseSources(value).map((v) => scopeValueName(def, v, src)).join(', ');
}

let shared: Promise<SourceManifestLike[]> | null = null;

/** Connector manifests plus built-in group names — one fetch shared by every surface; a failure is not remembered. */
export function loadLabelManifests(): Promise<SourceManifestLike[]> {
  if (!shared) {
    shared = spClient.getLabelManifests()
      .then((m) => m as SourceManifestLike[])
      .catch(() => { shared = null; return []; });
  }
  return shared;
}

/** The label manifests, or undefined while loading. */
export function useLabelManifests(): SourceManifestLike[] | undefined {
  const [manifests, setManifests] = useState<SourceManifestLike[] | undefined>();
  useEffect(() => {
    let live = true;
    loadLabelManifests().then((m) => { if (live) setManifests(m); });
    return () => { live = false; };
  }, []);
  return manifests;
}
