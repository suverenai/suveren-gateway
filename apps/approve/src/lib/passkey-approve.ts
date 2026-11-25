/**
 * Approving a passkey for the suveren.ai dashboard on this phone (AS step 17, the device side; plan 6.4 point 3; DEC-47: a phone is a
 * granting device). The list comes from the Authority Server (only this account's waiting requests); the phone signs
 * `suveren-passkey-register` with its device key and its passkey check (one touch) over exactly what that list named, and its own
 * verified chain head. The card is the shared one (packages/approval-card DashboardPasskeyCard), the same the computer shows.
 */
import { b64uEncode, objectHash, signedBytes } from '@hap/core/device-keys';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { DeviceKeyStore } from './key-store';
import type { DeviceSession } from './session';

export interface PendingPasskey {
  requestId: string; credId: string; rpId: string; code: string;
  credentialAt: number; expiresAt: number; email: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** One entry as the Authority Server listed it, member by member; anything else is dropped, never shown. */
export function pendingOf(x: unknown, now: number): PendingPasskey | null {
  if (!isObj(x) || !isObj(x.account)) return null;
  const r = x.request_id, c = x.cred_id, rp = x.rp_id, code = x.code, at = x.credential_at, ex = x.expires_at, email = x.account.email;
  if (typeof r !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(r)) return null;
  if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(c)) return null;
  if (typeof rp !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(rp)) return null;
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return null;
  if (typeof at !== 'number' || typeof ex !== 'number' || !Number.isSafeInteger(at) || !Number.isSafeInteger(ex) || ex <= now) return null;
  if (typeof email !== 'string') return null;
  return { requestId: r, credId: c, rpId: rp, code, credentialAt: at, expiresAt: ex, email };
}

export interface PasskeyDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  api: AsApi;
  accounts: AccountStore;
  session: DeviceSession;
  now: () => number;
}

export async function readPendingPasskeys(d: Pick<PasskeyDeps, 'api' | 'session' | 'now'>): Promise<PendingPasskey[]> {
  const bearer = d.session.bearer();
  if (!bearer) return [];
  const r = await d.api.pendingPasskeys(bearer);
  if (!r.ok || !Array.isArray(r.data.pending)) return [];
  return r.data.pending.map((x) => pendingOf(x, d.now())).filter((p): p is PendingPasskey => p !== null);
}

/** Approve `item` with one touch. Returns null when added, else a code (`passkey_request_gone`, `check_failed`, `session_ended`, the AS code). */
export async function approvePasskey(d: PasskeyDeps, item: PendingPasskey): Promise<string | null> {
  const s = d.session.current();
  const bearer = d.session.bearer();
  const account = await d.accounts.read();
  if (!s || !bearer || !account || !account.check) return 'session_ended';
  // Only a request the Authority Server lists for this account now: the page holds nothing else.
  const listed = (await readPendingPasskeys(d)).find((p) => p.requestId === item.requestId);
  if (!listed) return 'passkey_request_gone';
  const register = {
    typ: 'suveren-passkey-register', v: 1, root_did: account.root_did, key_id: account.key_id,
    chain_seq: s.chain.head.seq, chain_head: s.chain.head.hash,
    request_id: listed.requestId, cred_id: listed.credId, rp_id: listed.rpId, issued_at: d.now(),
  };
  let proof;
  try { proof = await d.check.prove(account.check.cred_id, await objectHash(register as never)); } catch (e) {
    if (e instanceof CheckError) return 'check_failed';
    throw e;
  }
  const sig = b64uEncode(await d.keys.sign(signedBytes(register as never)));
  const r = await d.api.approvePasskey({ register, sig, check: proof }, bearer);
  d.session.noteUse();
  if (!r.ok) return r.code;
  return r.data.registered === true && r.data.cred_id === listed.credId ? null : 'as_answer_invalid';
}
