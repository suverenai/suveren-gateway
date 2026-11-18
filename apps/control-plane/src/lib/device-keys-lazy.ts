/**
 * hap-core's device-keys module, loaded on first use.
 *
 * Every gateway starts this control plane, but only one with SUVEREN_DEVICE_KEYS=on
 * uses device keys. A static import would make every gateway, switch off or on,
 * need `@humanagencyp/hap-core/device-keys` (hap-core 0.14.0) at start-up. This
 * keeps the switch-off path loading exactly what it loaded before. Types are
 * imported with `import type` (erased at build time).
 */
export type DeviceKeys = typeof import('@hap/core/device-keys');

let loaded: Promise<DeviceKeys> | null = null;

export function deviceKeys(): Promise<DeviceKeys> {
  return (loaded ??= import('@hap/core/device-keys'));
}

/** `instanceof` without the class: the module is not loaded until used. */
export function isDeviceKeysError(e: unknown): e is Error & { code: string } {
  return e instanceof Error && e.name === 'DeviceKeysError' && typeof (e as { code?: unknown }).code === 'string';
}
