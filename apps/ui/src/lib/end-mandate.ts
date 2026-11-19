/** The page's "End a mandate" only for a gateway with a device chain: the switch on, a password session and a set-up device. */
import type { DeviceStatus } from './device-client';

export function endIsDeviceSigned(a: { deviceKeysSwitch: boolean; access: string }, status: Pick<DeviceStatus, 'setUp'> | null): boolean {
  return a.deviceKeysSwitch && a.access === 'password' && status?.setUp === true;
}
