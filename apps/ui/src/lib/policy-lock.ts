/**
 * Shared predicate for "is this setting locked by IT policy" across Settings
 * components (AuthorityServerCard, SimulationLockCard, …).
 *
 * Backend truth, never optimistic: a locked flag is only ever `true` when the
 * control-plane actually read it from `lib/policy.ts` (registry or policy
 * file — see docs/managed-settings.md). An OLDER control-plane that doesn't
 * know about this field yet omits it entirely, and `undefined` must behave
 * exactly like "not locked" — never throw, never guess.
 */
export function isPolicyLocked(flag: boolean | null | undefined): boolean {
  return flag === true;
}
