/**
 * The device list as plain data: moved into the shared package `@suveren/pairing` (the gateway's Devices page shows the same rows).
 * This file only keeps the phone's import path.
 */
export { RECENT_SECONDS, deviceRows, originOf, labelTaken } from '@suveren/pairing';
export type { DeviceRow, Origin } from '@suveren/pairing';
