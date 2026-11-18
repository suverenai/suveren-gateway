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
import { UnlockLimiter } from '../lib/unlock-limiter';
import { type ChangeConfirmations, type LoginChangeGate, createLoginChangeGate, refusingGate } from '../lib/change-confirmation';
import { createPasswordRouter } from './password';
import { createInternalOsSignalRouter } from './internal-os-signal';
import { createDeviceSetupRouter, createConnectCallbackRouter } from './device-setup';
import { DeviceChainStore } from '../lib/device-chain-store';
import { DeviceAsClient } from '../lib/device-as-client';
import { DeviceSignin, type AsKeyCheck, type DeviceSession } from '../lib/device-signin';
import { DeviceSetup } from '../lib/device-setup';
import type { AsFetchPinning } from '../lib/as-tls-pin';
import { PlatformHelper, unlockKeyService } from '../lib/platform-helper';
import { CheckKeyStore, PlatformChecks, platformGate } from '../lib/platform-checks';
import { createPlatformRouter } from './platform';
import { DeviceDecisions, type DecisionRoute, type DecisionKind, type ProposalFacts } from '../lib/device-decision';
import { createDeviceDecisionRouter } from './device-decision';
import { DevicePinStore } from '../lib/device-pin-store';
import { createInternalDeviceRouter } from './internal-device';

export function deviceKeysEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUVEREN_DEVICE_KEYS === 'on';
}

/**
 * The one member `/health` adds on a gateway that set up device keys: the page reads it to send its decisions
 * through the control plane's signing route (step 12). `{}` for every other gateway, so its answer is unchanged.
 */
export function deviceKeysHealth(state: (() => 'none' | 'present' | 'unreadable') | undefined): { deviceKeys?: true } {
  return state && state() === 'present' ? { deviceKeys: true } : {};
}

/** What set-up and device sign-in need from the process: where the Authority Server is and how to trust it. */
export interface DeviceSetupOptions {
  asUrl: string;
  pinning: () => AsFetchPinning;
  /** Prove the Authority Server holds its key (the challenge of lib/as-challenge.ts). */
  checkAs: () => Promise<AsKeyCheck>;
  /** The hand-over after a sign-in (lib/device-session-establish.ts). */
  establish: (session: DeviceSession, first: boolean) => Promise<void>;
  onTlsMismatch?: () => void;
  onAlarm?: (code: 'chain_rollback' | 'chain_fork' | 'device_removed') => void;
  /** Drop the Authority Server credential (vault and MCP server) without locking: see DeviceSigninDeps.discard. */
  discard?: () => void | Promise<void>;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  /**
   * Decisions on the gateway page, signed with this computer's device key (step 12).
   * `facts` asks the MCP server for what only the gateway knows about a proposal (its signed mandate id, its
   * action type); `onDecided` is told after the Authority Server accepted one (events, the executor nudge).
   */
  decision?: {
    facts: (p: { proposalId: string; authorizationId: string; tool: string; reportedActionType?: string; approverDid?: string }) => Promise<ProposalFacts>;
    onDecided?: (route: DecisionRoute, kind: DecisionKind) => void;
  };
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
  /** Device-key set-up and sign-in (step 6). Without it only the step-5 routes are mounted. */
  device?: DeviceSetupOptions;
  /**
   * The native helper (step 5a): unlock by Touch ID and this computer's check key. Without it nothing of
   * step 5a exists (no route, no provider) and every path is the one of step 5/6.
   */
  platform?: { host: PlatformHelper; checkStore: CheckKeyStore; /** Tests only: the other branch of PLATFORM_UNLOCK_OPENS_PAGE_SESSION. */ opensPageSession?: boolean };
}

/**
 * Mounts what the switch allows; returns the gate the vault and OAuth routes ask,
 * and (with the switch on) whether this gateway has device keys, which the
 * account-key login asks before it signs in.
 */
export function mountDeviceKeyRoutes(app: Express, o: DeviceKeyMountOptions): {
  loginChangeGate: LoginChangeGate;
  hasDeviceChain?: () => boolean;
  /** What the account-key login asks: 'present' refuses it, 'unreadable' refuses it with its own code. */
  deviceChainState?: () => 'none' | 'present' | 'unreadable';
  signin?: DeviceSignin;
} {
  if (!o.enabled) return { loginChangeGate: refusingGate };
  const json = o.jsonParser ?? express.json();
  let device: { signin: DeviceSignin; setup: DeviceSetup; store: DeviceChainStore; client: DeviceAsClient } | undefined;
  // One PlatformChecks for set-up, the confirmation route and the turn-on/off gate: they share what the helper last said about the key.
  const checks = o.platform ? new PlatformChecks(o.platform.host) : undefined;
  if (o.device) {
    const store = new DeviceChainStore(o.vault);
    const client = new DeviceAsClient({ asUrl: o.device.asUrl, pinning: o.device.pinning, onTlsMismatch: o.device.onTlsMismatch });
    const signin = new DeviceSignin({
      vault: o.vault, store, client, checkAs: o.device.checkAs, establish: o.device.establish,
      onAlarm: o.device.onAlarm, discard: o.device.discard, now: o.device.now, timers: o.device.timers,
    });
    const setup = new DeviceSetup({
      vault: o.vault, store, client, signin, checkAs: o.device.checkAs,
      now: o.device.now ? () => o.device!.now!() * 1000 : undefined,
      ...(o.platform && checks ? { checks, checkStore: o.platform.checkStore } : {}),
    });
    device = { signin, setup, store, client };
  }
  app.use('/auth', json, createPasswordRouter({
    vault: o.vault,
    pageSession: o.pageSession,
    limiter: o.limiter,
    confirmations: o.confirmations,
    hasCheckKey: o.hasCheckKey,
    mcp: o.mcp,
    // Only a gateway that set up device keys signs in by its device key after an unlock.
    afterUnlock: device ? () => { if (device!.store.exists()) device!.signin.signInInBackground(); } : undefined,
  }));
  if (o.platform && checks) {
    o.vault.setPlatformService(unlockKeyService(o.platform.host), platformGate(checks, o.platform.checkStore));
    app.use('/auth', json, createPlatformRouter({
      vault: o.vault,
      pageSession: o.pageSession,
      limiter: new UnlockLimiter(),
      confirmations: o.confirmations,
      host: o.platform.host,
      checks,
      checkStore: o.platform.checkStore,
      passwordLimiter: o.limiter,
      chain: new DeviceChainStore(o.vault),
      mcp: o.mcp,
      opensPageSession: o.platform.opensPageSession,
      afterUnlock: device ? () => { if (device!.store.exists()) device!.signin.signInInBackground(); } : undefined,
    }));
  }
  if (device) {
    app.use('/auth', json, createDeviceSetupRouter({ vault: o.vault, pageSession: o.pageSession, setup: device.setup, signin: device.signin }));
    app.use('/connect', createConnectCallbackRouter({ pageSession: o.pageSession, setup: device.setup }));
    // The MCP server's questions about device keys (its own chain, the heads it has verified), by internal secret.
    app.use('/internal', json, createInternalDeviceRouter(o.internalSecret, device.store, new DevicePinStore(o.vault, device.store)));
    if (o.device?.decision) {
      app.use('/device-decision', json, createDeviceDecisionRouter({
        vault: o.vault,
        pageSession: o.pageSession,
        store: device.store,
        decisions: new DeviceDecisions({
          vault: o.vault, store: device.store, client: device.client,
          facts: o.device.decision.facts, onDecided: o.device.decision.onDecided,
          now: o.device.now,
        }),
      }));
    }
  }
  app.use('/internal', json, createInternalOsSignalRouter(o.internalSecret, createOsSignalHook(o.pageSession.sessions)));
  return {
    loginChangeGate: createLoginChangeGate(o.vault, o.pageSession.sessions, o.confirmations),
    ...(device ? { hasDeviceChain: () => device!.store.exists(), deviceChainState: () => device!.store.state(), signin: device.signin } : {}),
  };
}
