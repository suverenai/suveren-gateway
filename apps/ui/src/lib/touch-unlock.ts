/**
 * DEC-92: Touch ID opens the gateway page. On a computer where the native helper can make a Touch ID key, unlock by
 * Touch ID is turned on as part of the set-up, right after the unlock password is set (the password is in hand, the
 * page has its session): one call, and the helper asks for the touch(es) it needs. Never blocks the set-up: a
 * cancelled touch or a computer without Touch ID simply leaves the password as the way in, and Settings offers it later.
 */
import type { DeviceClient } from './device-client';

export type TouchUnlockOutcome = 'on' | 'already-on' | 'unavailable' | 'skipped';

export async function turnOnTouchUnlock(client: Pick<DeviceClient, 'platformCapabilities' | 'enablePlatform'>, password: string): Promise<TouchUnlockOutcome> {
  const caps = await client.platformCapabilities();
  if (!caps.ok || caps.data.available !== true) return 'unavailable';
  if (caps.data.unlockEnabled) return 'already-on';
  const r = await client.enablePlatform(password);
  return r.ok ? 'on' : 'skipped';
}
