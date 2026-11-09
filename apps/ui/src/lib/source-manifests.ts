/**
 * The connector manifests, for reading `documents` labels on display
 * surfaces. One fetch shared by every card on a page; a failed fetch is not
 * remembered (the next mount asks again) and yields no labels — the stored
 * `connector:kind` text is then shown as it is, never a guess.
 */
import { useEffect, useState } from 'react';
import { spClient } from './sp-client';
import type { SourceManifestLike } from './attachment-sources';

let shared: Promise<SourceManifestLike[]> | null = null;

function loadSourceManifests(): Promise<SourceManifestLike[]> {
  if (!shared) {
    shared = spClient.getIntegrationManifests()
      .then((r) => r.manifests ?? [])
      .catch(() => { shared = null; return []; });
  }
  return shared;
}

export function useSourceManifests(): SourceManifestLike[] | undefined {
  const [manifests, setManifests] = useState<SourceManifestLike[] | undefined>();
  useEffect(() => {
    let live = true;
    loadSourceManifests().then((m) => { if (live) setManifests(m); });
    return () => { live = false; };
  }, []);
  return manifests;
}
