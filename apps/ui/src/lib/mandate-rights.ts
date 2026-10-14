/**
 * Whether the signed-in person can give a mandate for a profile in the active
 * workspace — the Authority Server's rule (mandate/route.ts, team authority
 * gate), checked on the mandate screen BEFORE the person fills anything in:
 *
 * - personal workspace: always (the sole member is the authority);
 * - team: the profile must have GRANTORS configured (else
 *   PROFILE_NOT_ENABLED_FOR_GROUP), and the person must be one of them (else
 *   OWNER_NOT_APPROVER — the wire code name is unchanged by TR5; see
 *   suveren-as's mandate/route.ts doc comment on why).
 *
 * TR5 (work-plan "Added 2026-10-14 — Team: permissions, above-cap approval,
 * read limits"): who may GRANT (sign) a mandate is `grantors`, a role
 * distinct from `approvers` (who may clear an above-cap proposal) — being an
 * approver no longer implies being allowed to grant, and vice versa. Callers
 * pass `effectiveGrantors(config)` (sp-client.ts) — grantors, falling back
 * to approvers for a config saved before TR5 existed, same fallback the AS
 * itself applies.
 *
 * `isPersonal` is the AS's own discriminator — the personal workspace has a
 * groupId like any team. A snapshot without the flag is treated as a team: that
 * can only block a ceremony the AS would refuse anyway. While the config is still
 * loading the answer is "can", so nothing flickers to blocked; the AS still decides.
 */
export type MandateRight =
  | { can: true }
  | { can: false; code: 'PROFILE_NOT_ENABLED_FOR_GROUP' | 'OWNER_NOT_APPROVER'; reason: string; fix: string };

export interface MandateRightInput {
  isPersonal?: boolean;
  configLoaded: boolean;
  /** `effectiveGrantors(config)` — `'all'` (every member), an explicit
   *  userId list, or undefined when there is no config at all. */
  grantors: readonly string[] | 'all' | undefined;
  userId: string | undefined;
  profileName: string;
  teamName?: string | null;
}

export function mandateRight(i: MandateRightInput): MandateRight {
  if (i.isPersonal) return { can: true };
  if (!i.configLoaded) return { can: true };
  const team = i.teamName ? `"${i.teamName}"` : 'this team';
  const grantorsEmpty = i.grantors !== 'all' && (i.grantors?.length ?? 0) === 0;
  if (grantorsEmpty) {
    return {
      can: false,
      code: 'PROFILE_NOT_ENABLED_FOR_GROUP',
      reason: `Not enabled in ${team}.`,
      fix: `Ask an admin of ${team} to enable ${i.profileName} and name who may give its mandates.`,
    };
  }
  const isGrantor = i.grantors === 'all' || (!!i.userId && i.grantors!.includes(i.userId));
  if (!isGrantor) {
    return {
      can: false,
      code: 'OWNER_NOT_APPROVER',
      reason: `Only ${i.profileName}'s grantors in ${team} can give this — you are not one of them.`,
      fix: `Ask one of them, or a team admin to add you.`,
    };
  }
  return { can: true };
}
