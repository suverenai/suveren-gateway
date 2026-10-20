/**
 * Choices for a scope field whose values are profile short names — a field
 * that declares `valuesFrom: "profiles"` instead of a fixed `enum`
 * (delegation 0.6 `allowed_profiles`: "the areas the AI may propose mandates
 * for"). Read at runtime, never a list in code:
 *
 *   - the profile catalog the gateway serves (`/api/profiles`), one entry per
 *     short name (its newest version);
 *   - narrowed to the areas available in the workspace — in a team, those the
 *     team has enabled (a team profile config exists); in the personal
 *     workspace, every catalog area;
 *   - minus every profile that itself governs an action this field constrains
 *     (`constraint.requiredFor`, e.g. `mandate`): a profile that grants
 *     mandate creation can never be proposed. The gateway refuses such a
 *     proposal on its own (setup.ts) — this only keeps it off the list.
 *
 * Same look as an enum subset field: the options are short names in a
 * checkbox group (BoundsEditor's CheckboxGroup).
 */
import { useEffect, useState } from 'react';
import type { AgentProfile } from '@hap/core';
import { spClient } from './sp-client';
import { loadAreaCatalog } from './area-catalog';
import { loadProfile } from './profile-cache';

/** The profile-declared marker. */
export function valuesFromProfiles(field: unknown): boolean {
  return (field as { valuesFrom?: unknown } | null)?.valuesFrom === 'profiles';
}

const shortOf = (id: string): string => (id.replace(/@.*$/, '').split('/').pop() ?? id).toLowerCase();
const versionOf = (id: string): string => id.split('@')[1] ?? '';

/** The newest catalog id per short name. */
export function newestPerShortName(catalog: Array<{ id: string }>): string[] {
  const best = new Map<string, string>();
  for (const { id } of catalog) {
    const s = shortOf(id);
    const cur = best.get(s);
    if (!cur || versionOf(id).localeCompare(versionOf(cur), undefined, { numeric: true }) > 0) best.set(s, id);
  }
  return [...best.values()];
}

/**
 * Pure: the short names to offer. `profiles` = the newest version of each
 * catalog area (full definitions); `enabled` = whether the workspace has that
 * area available.
 */
export function profileValuedOptions(
  field: { constraint?: { requiredFor?: string[] } },
  profiles: Array<Pick<AgentProfile, 'id' | 'boundsSchema'>>,
  enabled: (profileId: string) => boolean,
): string[] {
  const constrained = field.constraint?.requiredFor ?? [];
  return profiles
    .filter(p => enabled(p.id))
    .filter(p => !(p.boundsSchema?.actionTypes ?? []).some(a => constrained.includes(a)))
    .map(p => shortOf(p.id))
    .sort((a, b) => a.localeCompare(b));
}

export interface Workspace { groupId?: string; isPersonal?: boolean }

/**
 * Options per `valuesFrom: "profiles"` field of `profile`, keyed by field
 * name; a field is absent while loading. Empty object when the profile has
 * no such field (no requests made).
 */
export function useProfileValuedOptions(profile: AgentProfile, workspace: Workspace | undefined): Record<string, string[]> {
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const fields = Object.entries(profile.scopeSchema?.fields ?? {}).filter(([, f]) => valuesFromProfiles(f));
  const wanted = fields.length > 0;
  const groupId = workspace?.groupId;
  const isPersonal = !!workspace?.isPersonal;

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    (async () => {
      const ids = newestPerShortName(await loadAreaCatalog());
      const defs = (await Promise.all(ids.map(id => loadProfile(id)))).filter((p): p is AgentProfile => !!p);
      let enabled: (id: string) => boolean;
      if (isPersonal) {
        enabled = () => true;
      } else if (groupId) {
        const configs = await Promise.all(defs.map(p => spClient.getTeamProfileConfig(groupId, p.id).catch(() => null)));
        const on = new Set(defs.filter((_, i) => configs[i]).map(p => p.id));
        enabled = id => on.has(id);
      } else {
        enabled = () => false; // no workspace known — offer nothing rather than guess
      }
      const out: Record<string, string[]> = {};
      for (const [key, f] of fields) out[key] = profileValuedOptions(f as { constraint?: { requiredFor?: string[] } }, defs, enabled);
      if (live) setOptions(out);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, wanted, groupId, isPersonal]);

  return options;
}
