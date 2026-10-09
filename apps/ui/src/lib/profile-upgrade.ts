import type { AgentProfile } from '@hap/core';
import type { ProfileSummary } from './sp-client';

/**
 * Re-approve/edit must move a mandate to the newest version of its profile —
 * the v0.7 Authority Server refuses to sign a NEW mandate under an old
 * profile version (`PROFILE_INVALID`; old versions stay listable for
 * history, never issuable again). Before this module, Copy/Edit carried the
 * grant's ORIGINAL `profile_id` forward unchanged, so re-approving a mandate
 * on an old version could never succeed (suveren-gateway v0.20.0 bug).
 *
 * There is no "still conformant, stay put" case distinct from "upgrade": a
 * version the AS still accepts is also the one Copy/Edit would resolve to
 * when it is the newest, so always resolving to the newest version is the
 * simplest rule that is also correct for every case the AS allows.
 */

/** `.../delegation@0.3` -> `delegation` — the short name before `@version`. */
export function profileShortName(id: string): string {
  return id.replace(/@.*$/, '').split('/').pop() ?? id;
}

/** `.../delegation@0.3` -> `0.3`; `''` when `id` carries no version. */
export function profileVersion(id: string): string {
  return id.split('@')[1] ?? '';
}

/** True when `a`'s version sorts newer than `b`'s (numeric: "0.10" > "0.9"). */
export function isNewerVersion(a: string, b: string): boolean {
  return profileVersion(a).localeCompare(profileVersion(b), undefined, { numeric: true }) > 0;
}

/**
 * The newest profile in `catalog` sharing `profileId`'s short name —
 * regardless of whether it is newer than, equal to, or (should not happen)
 * older than `profileId` itself. `undefined` only when the catalog has no
 * entry with that short name at all (e.g. the catalog fetch failed/is
 * empty) — callers fall back to `profileId` unchanged in that case.
 */
export function newestProfileOf(profileId: string, catalog: ProfileSummary[]): ProfileSummary | undefined {
  const short = profileShortName(profileId);
  let best: ProfileSummary | undefined;
  for (const p of catalog) {
    if (profileShortName(p.id) !== short) continue;
    if (!best || isNewerVersion(p.id, best.id)) best = p;
  }
  return best;
}

/**
 * Minimal shape `carryParamsForward` needs — `boundsSchema`/`scopeSchema`
 * both match it. `fields` is typed loosely because `default` is not yet in
 * hap-core's published `ProfileBoundsField`/`ProfileScopeField` types,
 * exactly as `bound-defaults.ts`'s `seedForBound` already casts around —
 * the profile JSON carries it; the npm package's `.d.ts` hasn't caught up.
 */
interface FieldSchema {
  keyOrder: string[];
  fields: Record<string, unknown>;
}

/**
 * Carry old bounds/scope values onto a newer profile version's schema:
 *   - a field the new schema still declares keeps its old value
 *   - a field the new schema no longer declares is dropped (e.g. email@0.8
 *     removed `read_daily_max`)
 *   - a field new in this version starts from the schema's own `default`
 *     (the same seed BoundsEditor/seedForBound apply at ceremony time —
 *     applied here too so a re-approve/edit shows the resolved value before
 *     the wizard ever runs)
 *
 * Driven entirely by the new schema — never a hardcoded per-field or
 * per-profile list, so this keeps working for every future profile version
 * without a code change.
 */
export function carryParamsForward(
  oldValues: Record<string, string | number>,
  schema: FieldSchema | undefined,
): Record<string, string | number> {
  if (!schema) return {};
  const result: Record<string, string | number> = {};
  for (const key of schema.keyOrder) {
    if (key === 'profile' || key === 'path') continue;
    if (oldValues[key] !== undefined) {
      result[key] = oldValues[key];
      continue;
    }
    const def = (schema.fields[key] as { default?: unknown } | undefined)?.default;
    if (typeof def === 'string' || (typeof def === 'number' && Number.isFinite(def))) {
      result[key] = def;
    }
  }
  return result;
}

/** {@link carryParamsForward} over `newProfile.boundsSchema`. */
export function carryBoundsForward(
  oldBounds: Record<string, string | number>,
  newProfile: AgentProfile,
): Record<string, string | number> {
  return carryParamsForward(oldBounds, newProfile.boundsSchema);
}

/** {@link carryParamsForward} over `newProfile.scopeSchema`. */
export function carryContextForward(
  oldContext: Record<string, string | number>,
  newProfile: AgentProfile,
): Record<string, string | number> {
  return carryParamsForward(oldContext, newProfile.scopeSchema);
}
