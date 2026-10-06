/**
 * Which icon and name a profile shows on a mandate/ticket/picker card.
 *
 * No per-profile color anywhere (that was tried and dropped — see
 * temp/mandates-tickets-ui-mockup.html). Profiles are told apart by a neutral
 * line icon plus the profile name, never by hue.
 *
 * Icon resolution, in order:
 *  1. The profile declares `icon` (profile JSON, forward-looking — no shipped
 *     profile sets this field yet) AND it names one of the icons the gateway
 *     actually ships → use it.
 *  2. A fallback map keyed by the profile's SHORT id (the segment before `@`,
 *     after the last `/`) — covers every profile shipped before `icon`
 *     existed, and needs no profile-side change.
 *  3. Anything still unmatched (an unknown/company-added profile) → a neutral
 *     `help-circle`. Never guessed from the id string beyond the short-id key.
 */

import { profileDisplayName } from './profile-display';

/** The fixed set of icons the gateway ships SVGs for (see ProfileIcon.tsx). */
export type IconName =
  | 'mail'
  | 'users'
  | 'receipt'
  | 'credit-card'
  | 'calendar'
  | 'megaphone'
  | 'archive'
  | 'rocket'
  | 'flask'
  | 'shopping-cart'
  | 'bar-chart'
  | 'help-circle';

const KNOWN_ICONS: ReadonlySet<string> = new Set<IconName>([
  'mail', 'users', 'receipt', 'credit-card', 'calendar', 'megaphone',
  'archive', 'rocket', 'flask', 'shopping-cart', 'bar-chart', 'help-circle',
]);

/** Fallback icon by short profile id, for profiles that don't declare `icon`. */
const FALLBACK_ICON_BY_SHORT_ID: Readonly<Record<string, IconName>> = {
  email: 'mail',
  customers: 'users',
  sales: 'receipt',
  charge: 'credit-card',
  calendar: 'calendar',
  publish: 'megaphone',
  records: 'archive',
  deploy: 'rocket',
  delegation: 'flask',
  purchase: 'shopping-cart',
  reporting: 'bar-chart',
};

/** `.../hap-profiles/charge@0.4` → `charge`; `claims@0.1` → `claims`. */
export function shortProfileId(profileId: string): string {
  const lastSlash = profileId.lastIndexOf('/');
  const segment = lastSlash >= 0 ? profileId.slice(lastSlash + 1) : profileId;
  const atIndex = segment.indexOf('@');
  return (atIndex >= 0 ? segment.slice(0, atIndex) : segment).toLowerCase();
}

export interface ProfileIdentity {
  icon: IconName;
  /** The profile's display name, with the delegation → "Test Setup" override applied. */
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
  declared?: { name?: string; icon?: string },
): ProfileIdentity {
  const shortId = shortProfileId(profileId);

  const icon =
    declared?.icon && KNOWN_ICONS.has(declared.icon)
      ? (declared.icon as IconName)
      : FALLBACK_ICON_BY_SHORT_ID[shortId] ?? 'help-circle';

  // profileDisplayName applies the delegation → "Test Setup" override.
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
