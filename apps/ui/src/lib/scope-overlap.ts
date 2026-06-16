/**
 * Structural scope-overlap detection between two grants on the SAME profile.
 *
 * Principle (profile-agnostic — no hardcoded field names):
 *   A grant authorizes a set of actions = everything matching its bounds AND
 *   its context (scope). Bounds are MAGNITUDES (how much) — they don't decide
 *   *which* actions are covered. Context fields are ALLOWLISTS that PARTITION
 *   the action space (which recipients / domains / calendars / …). So two
 *   grants overlap iff their context scopes intersect — a pure context question.
 *
 * Per context field (driven by the profile's contextSchema.keyOrder):
 *   - parse each side into a token set (comma-separated allowlist)
 *   - empty field = no constraint on that dimension = matches all (wildcard)
 *   - if both sides are non-empty and their sets are DISJOINT, that field
 *     separates the grants → scopes cannot intersect → no overlap
 *   - an unparseable / wildcard field is non-separating (it can't establish
 *     disjointness; let the other fields decide)
 * If no field separates them → the scopes overlap.
 *
 * Degrades correctly: a profile with no context schema (no keys) yields
 * overlap=true for any two grants — correct, since without scope they cover
 * the same actions and differ only in bounds.
 *
 * Known limitation: cross-field implications are not modelled (e.g. one grant
 * scoped by `allowed_recipients` and another by `allowed_domains`). When a
 * dimension is specified on only one side it is treated as non-separating, so
 * such mixed-scoping cases lean toward reporting overlap (the safe direction).
 */

export type ScopeValues = Record<string, string | number | undefined>;

/** Split a context value into a normalized token set. */
export function tokenSet(value: string | number | undefined | null): Set<string> {
  if (value === undefined || value === null) return new Set();
  return new Set(
    String(value)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * True when two grants' context scopes intersect (i.e. some action falls under
 * both), evaluated only over the profile's declared context fields.
 */
export function scopesOverlap(
  contextKeys: string[],
  a: ScopeValues,
  b: ScopeValues,
): boolean {
  for (const key of contextKeys) {
    const sa = tokenSet(a[key]);
    const sb = tokenSet(b[key]);
    // A wildcard (empty) on either side does not separate the grants.
    if (sa.size === 0 || sb.size === 0) continue;
    // Both constrained but disjoint on this dimension → scopes cannot meet.
    if (!intersects(sa, sb)) return false;
  }
  return true;
}
