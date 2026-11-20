/**
 * The app's long-lived objects, made once. Everything a screen needs is reached through here, so a screen never makes its own
 * key store, store or transport. Tests build the same objects with fakes (MemoryKv, a fake CheckDevice, a fake Transport).
 */
import { AS_URL, NOW } from './config';
import { IdbKv } from './idb';
import type { Kv } from './kv';
import { DeviceKeyStore } from './key-store';
import { AccountStore } from './account-store';
import { BrowserCheckDevice, type CheckDevice } from './check';
import { DirectTransport, type Transport } from './transport';
import { AsApi } from './as-api';
import { DeviceSession } from './session';
import { ProposalReader } from './proposals';
import { PhoneDecider } from './decide';
import type { CheckDeps } from './card-checks';
import { PushControl, browserPushPlatform, type PushPlatform } from './push';

export interface Runtime {
  kv: Kv;
  keys: DeviceKeyStore;
  accounts: AccountStore;
  check: CheckDevice;
  transport: Transport;
  api: AsApi;
  session: DeviceSession;
  reader: ProposalReader;
  /** What the checks before a decision read with, and the object that signs and sends a decision. */
  checks: CheckDeps;
  decider: PhoneDecider;
  /** Notifications on this phone (stage D4). */
  push: PushControl;
  asUrl: string;
  /** The passkey's relying-party id: this app's own host. */
  rpId: string;
  now: () => number;
}

export interface RuntimeParts {
  kv?: Kv;
  check?: CheckDevice;
  transport?: Transport;
  asUrl?: string;
  rpId?: string;
  now?: () => number;
  pushPlatform?: PushPlatform;
}

export function createRuntime(p: RuntimeParts = {}): Runtime {
  const asUrl = p.asUrl ?? AS_URL;
  const now = p.now ?? NOW;
  const kv = p.kv ?? new IdbKv();
  const rpId = p.rpId ?? globalThis.location.hostname;
  const keys = new DeviceKeyStore(kv, globalThis.crypto.subtle, now);
  const accounts = new AccountStore(kv);
  const check = p.check ?? new BrowserCheckDevice(rpId);
  const transport = p.transport ?? new DirectTransport(asUrl);
  const api = new AsApi(transport);
  const session = new DeviceSession({ accounts, keys, check, api, transport, now });
  // The Personal domain is the account id, known once a session is open.
  const reader = new ProposalReader(api, session, () => session.current()?.user.id ?? '');
  const checks: CheckDeps = { api, session, keys, accounts, now };
  const decider = new PhoneDecider({ api, session, keys, accounts, reader, now });
  const push = new PushControl({ platform: p.pushPlatform ?? browserPushPlatform(), api, kv, now });
  return { kv, keys, accounts, check, transport, api, session, reader, checks, decider, push, asUrl, rpId, now };
}
