/**
 * Whether the review page must block "Authorize" because the Authority Server
 * would refuse the grant with PROFILE_NOT_ENABLED_FOR_GROUP.
 *
 * Mirrors the AS rule (attest/route.ts): only a non-personal group needs at
 * least one approver on the profile. The personal workspace has a group id
 * like any team, so "has a groupId" is not the team signal — `isPersonal` is.
 * A snapshot written before the flag existed lacks it and is treated as a
 * team: that can only block a ceremony the AS would refuse anyway.
 */
export function teamGateBlocked(
  auth: { isPersonal?: boolean },
  profileConfigLoaded: boolean,
  approvers: readonly string[] | undefined,
): boolean {
  if (auth.isPersonal) return false;
  return profileConfigLoaded && (approvers?.length ?? 0) === 0;
}
