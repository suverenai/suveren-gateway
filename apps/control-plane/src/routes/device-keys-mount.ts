/**
 * Where the device-key routes are mounted, pulled out of index.ts (which starts
 * a server on import) so a test can mount them with the switch off and on.
 *
 * `SUVEREN_DEVICE_KEYS=on` (the name the Authority Server uses) mounts the
 * unlock-password routes and the OS lock/sleep/user-switch signal. Off, none of
 * them exist (404) and the login-change gate is a refusal that is only ever
 * asked on a vault that already has a password header.
 */

import express, { type Express, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
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
import { createDeviceRecoveryRouter, createRecoveryCallbackRouter } from './device-recovery';
import { DeviceRecovery } from '../lib/device-recovery';
import { IdentityResetAlarm } from '../lib/identity-reset-alarm';
import { eventBus } from '../lib/event-bus';
import { DeviceDecisions, type DecisionRoute, type DecisionKind, type ProposalFacts } from '../lib/device-decision';
import { createDeviceDecisionRouter } from './device-decision';
import { DevicePinStore } from '../lib/device-pin-store';
import { createInternalDeviceRouter } from './internal-device';
import { isBearerCredential } from '../lib/as-credential';
import { MandateGrantStore } from '../lib/mandate-grant-store';
import { TeamTrustStore } from '../lib/team-trust-store';
import { MandateGrants, type TeamTrustPort } from '../lib/mandate-grants';
import { DeviceReaders } from '../lib/device-readers';
import { ProposalRewrap } from '../lib/proposal-rewrap';
import { DeviceApprovals } from '../lib/device-approvals';
import { TeamJoin } from '../lib/team-join';
import { DevicePairing } from '../lib/device-pairing';
import { createDevicePairingRouter } from './device-pairing';

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
  /** A desktop notification for a pending request for a new root DID (once per request). Unset: none. */
  notifyIdentityReset?: (title: string, message: string) => void;
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
  /** Grants mandates on this computer with its check (step 13): only with device set-up. */
  grants?: MandateGrants;
  /** Checks what the person approved on ANY of their own devices, for the Setup tools; `/internal/mandate` runs only for these (plan 20.21.6). */
  approvals?: DeviceApprovals;
  /** The verified head of the team's list (step 3's port; the join screens use it internally). */
  teamTrust?: TeamTrustPort;
  /** The verified member DIDs, null when nothing is honoured (stage C). */
  teamMembers?: () => Promise<ReadonlySet<string> | null>;
  /** The join screens' logic (DEC-73 step 4): only with device set-up. */
  teamJoin?: TeamJoin;
  /** Step 8: who can read a proposal (verified chains), and the re-wrap of open proposals for a later device. Only with device set-up. */
  readers?: DeviceReaders;
  rewrap?: ProposalRewrap;
} {
  if (!o.enabled) return { loginChangeGate: refusingGate };
  const json = o.jsonParser ?? express.json();
  let device: { signin: DeviceSignin; setup: DeviceSetup; store: DeviceChainStore; client: DeviceAsClient; recovery: DeviceRecovery; alarm: IdentityResetAlarm; pins: DevicePinStore; grantStore: MandateGrantStore; grants: MandateGrants; approvals: DeviceApprovals; teamJoin: TeamJoin; readers: DeviceReaders; rewrap: ProposalRewrap; pairing: DevicePairing } | undefined;
  // One PlatformChecks for set-up, the confirmation route and the turn-on/off gate: they share what the helper last said about the key.
  const checks = o.platform ? new PlatformChecks(o.platform.host) : undefined;
  if (o.device) {
    const store = new DeviceChainStore(o.vault);
    const client = new DeviceAsClient({ asUrl: o.device.asUrl, pinning: o.device.pinning, onTlsMismatch: o.device.onTlsMismatch });
    // The alarm for a pending request for a new root DID: what a sign-in learns, shown as a banner state and a doorbell event.
    const alarm = new IdentityResetAlarm({
      emit: (type, payload) => eventBus.emit(type, payload),
      notify: o.device.notifyIdentityReset,
      now: o.device.now,
    });
    o.vault.onLocked(() => alarm.forget());
    // Step 8: readers of a proposal come from verified chains; a person whose chain does not verify is an alarm on the page.
    const pins = new DevicePinStore(o.vault, store);
    // Grants (and with them step 3's team trust) exist BEFORE the readers and the join: both take their verified list from it.
    const grantStore = new MandateGrantStore(o.vault);
    const grants = new MandateGrants({
      vault: o.vault, store, client, pins, grants: grantStore, teamTrust: new TeamTrustStore(o.vault),
      ...(o.platform && checks ? { checks, checkStore: o.platform.checkStore } : {}),
      now: o.device.now,
    });
    const readers = new DeviceReaders({ vault: o.vault, store, client, pins, teamMembers: () => grants.teamMembers(), onAlarm: (did, code) => eventBus.emit('reader-chain-alarm', { did, code }) });
    const rewrap = new ProposalRewrap({ vault: o.vault, client, readers });
    // A device added since the last sign-in is learned from the verified chain: open proposals get a wrap for it.
    const establish: typeof o.device.establish = async (session, first) => {
      await o.device!.establish(session, first);
      void rewrap.run().catch(() => { /* a re-wrap that fails never fails a sign-in */ });
    };
    const signin = new DeviceSignin({
      vault: o.vault, store, client, checkAs: o.device.checkAs, establish,
      onAlarm: o.device.onAlarm, onPendingReset: p => alarm.observe(p), discard: o.device.discard, now: o.device.now, timers: o.device.timers,
    });
    // `setup` and `recovery` refuse to start while the other is running; each asks the other through a late-bound closure.
    let recovery!: DeviceRecovery;
    const setup = new DeviceSetup({
      vault: o.vault, store, client, signin, checkAs: o.device.checkAs,
      now: o.device.now ? () => o.device!.now!() * 1000 : undefined,
      ...(o.platform && checks ? { checks, checkStore: o.platform.checkStore } : {}),
      otherFlowPending: () => recovery.status().recoveryPending,
    });
    recovery = new DeviceRecovery({
      vault: o.vault, store, client, signin, checkAs: o.device.checkAs, alarm,
      setupPending: () => setup.status().setupPending || setup.isBusy(),
      now: o.device.now ? () => o.device!.now!() * 1000 : undefined,
      ...(o.platform && checks ? { checks, checkStore: o.platform.checkStore } : {}),
    });
    const approvals = new DeviceApprovals({ vault: o.vault, client, grants, pins, now: o.device.now });
    const teamJoin = new TeamJoin({
      vault: o.vault, store, grants, trust: grants.teamTrustPort(), now: o.device.now,
      ...(o.platform && checks ? { checks, checkStore: o.platform.checkStore } : {}),
    });
    // Pairing with the phone app (step 11, gateway part): "Add a phone" and "Add this computer". Never beside a set-up or a recovery.
    const pairing = new DevicePairing({
      vault: o.vault, store, client, signin, checkAs: o.device.checkAs, now: o.device.now,
      ...(o.platform && checks ? { checks, checkStore: o.platform.checkStore } : {}),
      otherFlowPending: () => setup.status().setupPending || setup.isBusy() || recovery.status().recoveryPending,
    });
    device = { signin, setup, store, client, recovery, alarm, pins, grantStore, grants, approvals, teamJoin, readers, rewrap, pairing };
  }
  // A body that does not parse is answered here, for EVERY route under /auth (the recovery code and the password
  // are typed into several), with nothing of it in the answer or the log: Express's own handler logs the parser's
  // message, and for a body that holds a secret that message holds a piece of it. Only with the switch on.
  app.use('/auth', json, (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) { next(); return; }
    res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' });
  });
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
    app.use('/auth', json, createDeviceSetupRouter({ vault: o.vault, pageSession: o.pageSession, setup: device.setup, signin: device.signin, alarm: device.alarm, recovery: device.recovery }));
    app.use('/auth', json, createDeviceRecoveryRouter({ vault: o.vault, pageSession: o.pageSession, recovery: device.recovery }));
    app.use('/auth', json, createDevicePairingRouter({ vault: o.vault, pageSession: o.pageSession, pairing: device.pairing }));
    app.use('/connect', createConnectCallbackRouter({ pageSession: o.pageSession, setup: device.setup }));
    app.use('/recover', createRecoveryCallbackRouter({ pageSession: o.pageSession, recovery: device.recovery }));
    // The MCP server's questions about device keys (its own chain, the heads it has verified), by internal secret.
    app.use('/internal', json, createInternalDeviceRouter(o.internalSecret, device.store, device.pins, {
      store: device.grantStore, grants: device.grants,
      // A Bearer credential is a device session (a chain exists then); the account's DID is known here from the API-key sign-in only.
      account: () => {
        const cookie = o.vault.getSpCookie();
        const user = o.vault.getSessionUser();
        return { signedIn: !!cookie && !(isBearerCredential(cookie) && !user), did: user?.did ?? null };
      },
    }));
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
    ...(device ? { hasDeviceChain: () => device!.store.exists(), deviceChainState: () => device!.store.state(), signin: device.signin, grants: device.grants, approvals: device.approvals, teamTrust: device.grants.teamTrustPort(), teamMembers: () => device!.grants.teamMembers(), teamJoin: device.teamJoin, readers: device.readers, rewrap: device.rewrap } : {}),
  };
}
