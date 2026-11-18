/**
 * Where the device-key routes are mounted, pulled out of index.ts (which starts
 * a server on import) so a test can mount them with the switch off and on.
 *
 * `SUVEREN_DEVICE_KEYS=on` (the name the Authority Server uses) mounts the
 * unlock-password routes and the OS lock/sleep/user-switch signal. Off, none of
 * them exist (404) and the login-change gate is a refusal that is only ever
 * asked on a vault that already has a password header.
 */

import express, { type Express, type RequestHandler } from 'express';
import type { Vault, McpRekeyClient } from '../lib/vault';
import type { PageSessionDeps } from '../middleware/auth';
import { createOsSignalHook } from '../lib/page-session';
import type { UnlockLimiter } from '../lib/unlock-limiter';
import { type ChangeConfirmations, type LoginChangeGate, createLoginChangeGate, refusingGate } from '../lib/change-confirmation';
import { createPasswordRouter } from './password';
import { createInternalOsSignalRouter } from './internal-os-signal';

export function deviceKeysEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUVEREN_DEVICE_KEYS === 'on';
}

export interface DeviceKeyMountOptions {
  enabled: boolean;
  vault: Vault;
  pageSession: PageSessionDeps;
  limiter: UnlockLimiter;
  confirmations: ChangeConfirmations;
  hasCheckKey: () => boolean;
  mcp?: McpRekeyClient;
  internalSecret: () => string;
  jsonParser?: RequestHandler;
}

/** Mounts what the switch allows; returns the gate the vault and OAuth routes ask. */
export function mountDeviceKeyRoutes(app: Express, o: DeviceKeyMountOptions): { loginChangeGate: LoginChangeGate } {
  if (!o.enabled) return { loginChangeGate: refusingGate };
  const json = o.jsonParser ?? express.json();
  app.use('/auth', json, createPasswordRouter({
    vault: o.vault,
    pageSession: o.pageSession,
    limiter: o.limiter,
    confirmations: o.confirmations,
    hasCheckKey: o.hasCheckKey,
    mcp: o.mcp,
  }));
  app.use('/internal', json, createInternalOsSignalRouter(o.internalSecret, createOsSignalHook(o.pageSession.sessions)));
  return { loginChangeGate: createLoginChangeGate(o.vault, o.pageSession.sessions, o.confirmations) };
}
