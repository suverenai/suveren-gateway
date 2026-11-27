import { lockedNotice, type LockedReason } from './locked-notice';
import { deviceKeysEnabled, controlPlaneHasPassword } from './device-decisions';

/**
 * The locked notice for the agent, as it is true right now: with device keys on AND an unlock password set, the person unlocks with the
 * password or Touch ID (asked of the control plane); in every other case the account key, as before.
 */
export async function lockedNoticeNow(action: string | undefined, reason: LockedReason = 'restart'): Promise<string> {
  const hasPassword = reason === 'restart' && deviceKeysEnabled() ? await controlPlaneHasPassword() : false;
  return lockedNotice(action, reason, process.env, hasPassword);
}
