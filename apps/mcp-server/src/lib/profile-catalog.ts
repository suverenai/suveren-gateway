/**
 * The gateway's own profile catalog, as the control plane (and through it the
 * UI) reads it: `GET /internal/profiles` and `GET /internal/profiles/:id`.
 *
 * Enforcement already runs on the profiles this gateway ships (profile-loader.ts
 * registers them; hap-core `verify` refuses a profile_hash mismatch). The
 * screens that CREATE and SHOW a mandate must read the same copy: if they took
 * labels, limits and versions from the Authority Server, a compromised one could
 * offer an older genuine version (e.g. email without a newer scope field) or
 * show words that differ from what is enforced. The Authority Server stays the
 * source only for what this gateway cannot know (which profiles a team enabled).
 *
 * Pure functions over the registry, so the answer is testable without HTTP.
 */

import { getProfile, listProfiles } from '@hap/core';
import type { AgentProfile } from '@hap/core';

/** What the picker and the version logic need: the same fields the Authority Server's list gave. */
export interface ProfileSummaryWire {
  id: string;
  name?: string;
  version: string;
  description: string;
  whatsNew?: string;
}

export interface CatalogAnswer<T> { status: number; body: T | { error: string; message: string } }

/** A full id ("host/path/name@version"); the registry also holds short-name aliases, which are not catalog entries. */
function isFullId(id: string): boolean {
  return id.includes('/') && id.includes('@');
}

/** Every shipped profile once (all versions), newest-agnostic: ordering is the caller's. */
export function localProfileSummaries(): ProfileSummaryWire[] {
  const out: ProfileSummaryWire[] = [];
  for (const id of listProfiles()) {
    if (!isFullId(id)) continue;
    const p = getProfile(id) as (AgentProfile & { name?: string; version?: string; description?: string; whatsNew?: string }) | undefined;
    if (!p) continue;
    out.push({
      id,
      name: p.name,
      version: p.version ?? id.split('@')[1] ?? '',
      description: p.description ?? '',
      ...(p.whatsNew ? { whatsNew: p.whatsNew } : {}),
    });
  }
  return out;
}

/** One shipped profile, byte-for-byte as loaded (its hash is the one `verify` checks). */
export function localProfile(id: string): CatalogAnswer<AgentProfile> {
  if (isFullId(id)) {
    const p = getProfile(id);
    if (p) return { status: 200, body: p };
  }
  return {
    status: 404,
    body: {
      error: 'profile_not_shipped',
      message: `This gateway does not include the area "${id}". Update the gateway to use it.`,
    },
  };
}
