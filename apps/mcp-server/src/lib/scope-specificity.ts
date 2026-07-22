/**
 * Authorization selection — most-specific-wins + fail-safe fallback.
 *
 * When more than one authorization passes verification for a single action, the
 * gateway must choose ONE deterministically and safely — never "first that
 * passes, in cache order" (which let an overlapping grant silently override a
 * stricter one). See doc/read-bounds-enforcement-plan.md §7.
 *
 * Rule:
 *   1. If one passer is STRICTLY more specific than every other (its scope is
 *      contained in theirs), it wins — the deliberate exception.
 *   2. Otherwise (ties / partial overlap / no scope schema at all) fall back to
 *      FAIL-SAFE: require approval if any passer requires it. Ambiguity must
 *      never silently weaken.
 *
 * PROFILE-AGNOSTIC by construction: specificity is pure set-containment over
 * whatever context dimensions the profile declares (`contextKeys` =
 * `contextSchema.keyOrder`). No field names, no profile literals, no
 * commitment-mode branching in the comparison. Mirrors the tokenSet semantics
 * of the UI's tested scope-overlap.ts; the two should converge into hap-core.
 */

export type ScopeValues = Record<string, string | number | undefined>;

export interface Passer<T = unknown> {
  /** Stable id (authorizationId) — used for a deterministic tie-break. */
  id: string;
  auth: T;
  /** Declared scope values for this authorization (contextSchema fields). */
  context: ScopeValues;
  /** True when this authorization routes actions to approval (review mode). */
  requiresApproval: boolean;
}

export interface Selection<T = unknown> {
  chosen: Passer<T>;
  superseded: Passer<T>[];
  reason: 'sole' | 'most-specific' | 'fail-safe-approval' | 'fail-safe-tiebreak';
}

/** Split a context value into a normalized token set (comma-separated allowlist). */
export function tokenSet(value: string | number | undefined | null): Set<string> {
  if (value === undefined || value === null) return new Set();
  return new Set(
    String(value)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** a ⊆ b, treating an empty set as the universal set (an unconstrained/wildcard dimension). */
function subsetOrEqual(a: Set<string>, b: Set<string>): boolean {
  if (b.size === 0) return true; // b unconstrained ⇒ everything is within it
  if (a.size === 0) return false; // a unconstrained (universal), b finite ⇒ a ⊄ b
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** A ⪰ B — A is at least as specific as B on every declared dimension. */
function atLeastAsSpecific(keys: string[], a: ScopeValues, b: ScopeValues): boolean {
  for (const k of keys) {
    if (!subsetOrEqual(tokenSet(a[k]), tokenSet(b[k]))) return false;
  }
  return true;
}

/**
 * A is STRICTLY more specific than B: A ⪰ B and not B ⪰ A. With no context
 * keys (a profile without a contextSchema), this is always false — no grant can
 * be more specific than another, so every overlap falls to the fail-safe path.
 */
export function strictlyMoreSpecific(keys: string[], a: ScopeValues, b: ScopeValues): boolean {
  return atLeastAsSpecific(keys, a, b) && !atLeastAsSpecific(keys, b, a);
}

/**
 * Choose one authorization among those that passed verification.
 * Deterministic: the tie-break is by id, never by input/cache order.
 */
export function selectAuthorization<T>(contextKeys: string[], passers: Passer<T>[]): Selection<T> {
  if (passers.length === 1) {
    return { chosen: passers[0], superseded: [], reason: 'sole' };
  }

  // 1. Unique strictly-most-specific passer wins (the deliberate exception).
  const dominators = passers.filter(a =>
    passers.every(b => b === a || strictlyMoreSpecific(contextKeys, a.context, b.context)),
  );
  if (dominators.length === 1) {
    const chosen = dominators[0];
    return { chosen, superseded: passers.filter(p => p !== chosen), reason: 'most-specific' };
  }

  // 2. Fail-safe: no clear winner ⇒ never silently weaken. Prefer a passer that
  //    requires approval so the action routes to a proposal instead of running.
  const approvers = passers.filter(p => p.requiresApproval);
  const pool = approvers.length > 0 ? approvers : passers;
  const chosen = pool.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
  return {
    chosen,
    superseded: passers.filter(p => p !== chosen),
    reason: approvers.length > 0 ? 'fail-safe-approval' : 'fail-safe-tiebreak',
  };
}
