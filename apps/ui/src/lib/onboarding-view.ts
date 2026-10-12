/**
 * OnboardingPage's view logic, pulled out as pure functions so the three
 * ways `pendingRequest`/`mode` can change are testable without rendering —
 * work-plan "Added 2026-10-11 — an account is Personal OR in one team".
 * UI shows backend truth only: every one of these reacts to AuthContext's
 * own `pendingRequest`/`mode` (from `GET /api/groups/me`), never to
 * anything OnboardingPage decided on its own.
 */

export type OnboardingScreen = 'choose' | 'join-preview' | 'join-waiting' | 'join-declined' | 'create';

/** Reloading the page restores the waiting state from backend truth, once —
 *  never re-triggers after the person has moved past it locally (e.g. by
 *  withdrawing, which clears `pendingRequest` on the SAME render as the
 *  local state change, and must not be mistaken for a fresh restore). */
export function shouldRestoreWaitingState(
  pendingRequest: unknown,
  alreadyRestored: boolean,
): boolean {
  return !alreadyRestored && pendingRequest != null;
}

/** The account moved into the team while this page was showing the waiting
 *  screen — leave onboarding. Only fires from THAT screen: arriving at
 *  `/onboarding` already in a team (e.g. a stale bookmark) is a different
 *  case this function does not decide. */
export function shouldLeaveOnboardingForTeam(screen: OnboardingScreen, mode: 'personal' | 'team'): boolean {
  return screen === 'join-waiting' && mode === 'team';
}

/**
 * `pendingRequest` just disappeared WITHOUT the account moving into a team
 * — the admin declined it, or it was withdrawn from elsewhere (another
 * device, or directly on the Authority Server). Returns the group name to
 * show "declined" for, or null when this isn't that case (including: no
 * previous pending request to have lost, or the account DID move into a
 * team — that's {@link shouldLeaveOnboardingForTeam}'s case, not this one).
 */
export function declinedGroupName(
  screen: OnboardingScreen,
  mode: 'personal' | 'team',
  pendingRequest: unknown,
  previousGroupName: string | null,
): string | null {
  if (pendingRequest != null) return null; // still pending — nothing lost yet
  if (screen !== 'join-waiting') return null; // not watching for this
  if (mode === 'team') return null; // moved — not a decline
  return previousGroupName;
}
