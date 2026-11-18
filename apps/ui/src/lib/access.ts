/**
 * How this page gets in, decided from what the gateway says about itself (device-keys plan 7).
 *
 *  - `legacy`: SUVEREN_DEVICE_KEYS is off, or the vault has no unlock password. The page is exactly what it
 *    was: sign in with the account key (X-API-Key), no session header, EventSource for /events.
 *  - `password`: the vault has an unlock password. The page signs in with the password (or Touch ID) and holds a
 *    page-session token in memory; the account key is no credential for the gateway's own routes.
 *
 * Pure: the probe is passed in.
 */

import type { Result, PasswordStatus } from './device-client';
import { textForCode } from './device-texts';

export type Access = 'legacy' | 'password';

export interface AccessState {
  access: Access;
  /** The control plane runs with SUVEREN_DEVICE_KEYS=on (its password routes answer). */
  switchOn: boolean;
  passwordSet: boolean;
}

/** The state before the probe answered, and after one that failed: today's page. */
export const LEGACY: AccessState = { access: 'legacy', switchOn: false, passwordSet: false };

/** A 404 (switch off), a network failure or an unreadable answer all mean today's page: never a guess towards a password. */
export function accessFromProbe(probe: Result<PasswordStatus>): AccessState {
  if (!probe.ok) return LEGACY;
  const passwordSet = (probe.data as { passwordSet?: unknown })?.passwordSet === true;
  return { access: passwordSet ? 'password' : 'legacy', switchOn: true, passwordSet };
}

/** After an unlock, what the page does next from the device status. */
export type AfterUnlock = 'in' | 'sign-in' | 'account-key';

export function afterUnlock(status: { setUp: boolean; signedIn: boolean }): AfterUnlock {
  if (!status.setUp) return 'account-key';
  return status.signedIn ? 'in' : 'sign-in';
}

/** Why the page session ended, as the sentence on the unlock screen (items 89 to 91, 88). */
export function sessionEndText(code: string | null | undefined): string | null {
  if (!code) return null;
  return textForCode(code, { screen: 'unlock' });
}

/** Where the page goes for a path, given who is in. Pure mirror of AppRoutes' guard for the tests. */
export function offerSetUp(state: AccessState, signedInByAccountKey: boolean): boolean {
  // A gateway with the switch on but no password offers the password once, after a sign-in; never forced, never in other modes.
  return state.switchOn && !state.passwordSet && signedInByAccountKey;
}
