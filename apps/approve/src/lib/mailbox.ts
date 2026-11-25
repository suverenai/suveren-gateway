/**
 * The pairing mailbox: moved into the shared package `@suveren/pairing` (the gateway's control plane runs the same code).
 * This file only keeps the phone's import path.
 */
export { Mailbox, pairingKeysOf } from '@suveren/pairing';
export type { PairingKeys, Messages, PollResult } from '@suveren/pairing';
