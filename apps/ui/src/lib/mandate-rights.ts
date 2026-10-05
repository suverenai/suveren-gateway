/**
 * Whether the signed-in person can give a mandate for a profile in the active
 * workspace — the Authority Server's rule (attest/route.ts, team authority gate),
 * checked on the mandate screen BEFORE the person fills anything in:
 *
 * - personal workspace: always (the sole member is the authority);
 * - team: the profile must have approvers configured (else
 *   PROFILE_NOT_ENABLED_FOR_GROUP), and the person must be one of them (else
 *   OWNER_NOT_APPROVER).
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
  /** userIds of the profile's approvers in this team; undefined = no config. */
  approvers: readonly string[] | undefined;
  userId: string | undefined;
  profileName: string;
  teamName?: string | null;
}

export function mandateRight(i: MandateRightInput): MandateRight {
  if (i.isPersonal) return { can: true };
  if (!i.configLoaded) return { can: true };
  const team = i.teamName ? `"${i.teamName}"` : 'this team';
  if ((i.approvers?.length ?? 0) === 0) {
    return {
      can: false,
      code: 'PROFILE_NOT_ENABLED_FOR_GROUP',
      reason: `${i.profileName} is not enabled for ${team}: no one has been named who may give ${i.profileName} mandates here.`,
      fix: `A team admin names the approvers for ${i.profileName} on the Authority Server.`,
    };
  }
  if (!i.userId || !i.approvers!.includes(i.userId)) {
    return {
      can: false,
      code: 'OWNER_NOT_APPROVER',
      reason: `Only the approvers of ${i.profileName} in ${team} may give ${i.profileName} mandates — you are not one of them.`,
      fix: `Ask one of them to give it, or ask a team admin to add you as an approver.`,
    };
  }
  return { can: true };
}
