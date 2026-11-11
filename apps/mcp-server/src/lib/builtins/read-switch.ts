/**
 * The read gate of a built-in's read tools, taken from the built-in's own
 * profile — never a field name in code. A connector's manifest names its read
 * switch (`boundField`/`requiredValue`); a built-in has no manifest file, so it
 * reads the switch from the profile that governs it: the one enum bound whose
 * values are exactly {"unlimited", "none"} (read-gate.ts `classifyEnumSwitches`,
 * the same rule the manifest lint applies), required at the value that is not
 * "none".
 *
 * Every version of that profile this gateway knows must name the same switch:
 * a mandate under any version is checked against one gate.
 *
 * Resolved when the group is registered (bin/http.ts loads the profiles first).
 * Fail-closed: a profile the gateway does not know, or versions that declare no
 * read switch, several, or different ones, throw — the group is then not
 * registered and the reason is logged (builtins/index.ts), instead of read
 * tools that would run with a gate no mandate could meet, or none.
 */
import { getProfile, listProfiles } from '@hap/core';
import { classifyEnumSwitches, type BoundsSchemaLike } from '../read-gate';

export interface ReadGate {
  category: 'read';
  boundField: string;
  requiredValue: string;
}

interface ProfileCatalog {
  ids: () => string[];
  get: (id: string) => { id?: string; boundsSchema?: unknown } | undefined;
}

const defaultCatalog: ProfileCatalog = {
  ids: () => listProfiles(),
  get: (id) => getProfile(id) as { id?: string; boundsSchema?: unknown } | undefined,
};

const shortOf = (id: string): string => (id.replace(/@.*$/, '').split('/').pop() ?? id).toLowerCase();

/** The read gate for the built-in governed by `profile` (its short name, as the built-in declares it). */
export function readSwitchGate(profile: string, catalog: ProfileCatalog = defaultCatalog): ReadGate {
  const short = shortOf(profile);
  const gates = new Map<string, ReadGate>();
  let versions = 0;
  for (const key of catalog.ids()) {
    if (shortOf(key) !== short) continue;
    const def = catalog.get(key);
    if (!def) continue;
    versions++;
    const schema = def.boundsSchema as BoundsSchemaLike | undefined;
    const { readSide } = classifyEnumSwitches(schema);
    if (readSide.length !== 1) {
      throw new Error(`profile "${key}" declares ${readSide.length} read switches (an enum bound of "unlimited"/"none"); its read tools need exactly one`);
    }
    const field = readSide[0];
    const requiredValue = (schema?.fields?.[field]?.boundType?.values ?? []).find(v => v !== 'none');
    if (!requiredValue) throw new Error(`profile "${key}": read switch "${field}" has no value other than "none"`);
    gates.set(`${field}=${requiredValue}`, { category: 'read', boundField: field, requiredValue });
  }
  if (versions === 0) throw new Error(`profile "${profile}" is not in this gateway's profile catalog — its read tools cannot be gated`);
  if (gates.size !== 1) throw new Error(`the versions of profile "${profile}" name different read switches (${[...gates.keys()].join(', ')})`);
  return [...gates.values()][0];
}
