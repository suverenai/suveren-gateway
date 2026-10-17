/**
 * Which icon and name a profile shows on a mandate/ticket/picker card.
 *
 * No per-profile color anywhere — profiles are told apart by a neutral line
 * icon plus the profile name, never by hue. The icon is the area icon
 * (lib/area.ts `areaIcon`, UI spec §13.1): chosen from the profile's short id,
 * never from a profile field; an unknown profile gets a neutral icon.
 */

import { profileDisplayName } from './profile-display';
import { areaIcon, type AreaIconName } from './area';

/** `.../hap-profiles/charge@0.4` → `charge`; `claims@0.1` → `claims`. */
export function shortProfileId(profileId: string): string {
  const lastSlash = profileId.lastIndexOf('/');
  const segment = lastSlash >= 0 ? profileId.slice(lastSlash + 1) : profileId;
  const atIndex = segment.indexOf('@');
  return (atIndex >= 0 ? segment.slice(0, atIndex) : segment).toLowerCase();
}

export interface ProfileIdentity {
  icon: AreaIconName;
  /** The profile's display name, with the delegation → "Delegation" override applied. */
  name: string;
  /** True for the delegation profile — simulation-only, review-only test tooling. */
  testSetup: boolean;
}

/**
 * Resolve the icon, display name, and test-setup flag for a profile id.
 *
 * @param declared Values the profile itself declares, when the caller has
 *   them on hand (e.g. from `ProfileSummary`). Both are optional and both are
 *   fed through the normal fallback chain below — there is no requirement
 *   that a profile declare either.
 */
export function profileIdentity(
  profileId: string,
  declared?: { name?: string },
): ProfileIdentity {
  const shortId = shortProfileId(profileId);

  // The area icon, from the profile id only (UI spec §13.1) — a profile
  // carries no icon of its own.
  const icon = areaIcon(profileId);

  const name = profileDisplayName(profileId, declared?.name);

  const testSetup = shortId === 'delegation';

  return { icon, name, testSetup };
}

/**
 * Tool names under the delegation profile's "propose a mandate / brief" tool
 * group are namespaced `setup__*` and run only while simulation mode is on —
 * by construction, every ticket for one of them is test setup, regardless of
 * which profile the receipt happens to carry.
 */
export function isTestSetupAction(action: string): boolean {
  return action.startsWith('setup__');
}
