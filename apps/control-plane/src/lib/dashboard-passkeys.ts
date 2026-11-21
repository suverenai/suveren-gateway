/**
 * Approving a passkey for the Suveren dashboard on this computer (device-keys plan 6.4 point 3; AS step 17, the device side).
 *
 * The dashboard (a browser signed in to suveren.ai) makes a passkey and waits. A granting device of the same account approves it:
 * it signs `suveren-passkey-register` { typ, v, root_did, key_id, chain_seq, chain_head, request_id, cred_id, rp_id, issued_at }
 * with its device key and its check (Touch ID) over exactly that object. The unlock password is never accepted.
 *
 * What this computer shows comes from the Authority Server's list of waiting requests (GET /api/passkeys/register/pending): the
 * six-digit code the dashboard shows beside the request, when it was made, until when it can be approved, and the account. The
 * person compares the code. The object signed names the request, the passkey and the address exactly as that list named them, and
 * this computer's own chain head (verified from the genesis on): the Authority Server checks all of it again.
 */
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import { deviceKeys } from './device-keys-lazy';
import { loadDeviceSigningKey } from './e2e-key-manager';
import { asErrorCode } from './device-as-client';
import { CheckError, type CheckKeyStore, type PlatformChecks } from './platform-checks';
import { GrantRefusal, type MandateGrants } from './mandate-grants';
import type { Vault } from './vault';

export const PASSKEY_REGISTER_TYP = 'suveren-passkey-register';

export interface PendingPasskey {
  requestId: string;
  credId: string;
  rpId: string;
  /** Six digits, the same the dashboard shows. */
  code: string;
  /** Epoch seconds. */
  createdAt: number;
  credentialAt: number;
  expiresAt: number;
  account: { email: string; name: string };
}

export class PasskeyApprovalRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PasskeyApprovalRefusal';
  }
}

export interface DashboardPasskeyDeps {
  grants: MandateGrants;
  vault: Vault;
  checks?: PlatformChecks;
  checkStore?: CheckKeyStore;
  /** Epoch seconds. */
  now?: () => number;
}

const B64U = /^[A-Za-z0-9_-]{1,512}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** One entry of the Authority Server's list, checked member by member; anything else is dropped, never shown. */
function pendingOf(x: unknown): PendingPasskey | null {
  if (!isObj(x) || !isObj(x.account)) return null;
  const { request_id: r, cred_id: c, rp_id: rp, code, created_at: ca, credential_at: cr, expires_at: ex } = x;
  if (typeof r !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(r)) return null;
  if (typeof c !== 'string' || !B64U.test(c)) return null;
  if (typeof rp !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(rp)) return null;
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return null;
  for (const n of [ca, cr, ex]) if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
  const { email, name } = x.account;
  if (typeof email !== 'string' || typeof name !== 'string') return null;
  return { requestId: r, credId: c, rpId: rp, code, createdAt: ca as number, credentialAt: cr as number, expiresAt: ex as number, account: { email, name } };
}

export class DashboardPasskeys {
  private readonly now: () => number;
  constructor(private readonly d: DashboardPasskeyDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async sessionOrRefuse() {
    try {
      return await this.d.grants.deviceSession();
    } catch (e) {
      if (e instanceof GrantRefusal) throw new PasskeyApprovalRefusal(409, e.code, e.message);
      throw e;
    }
  }

  private async asCall(s: Awaited<ReturnType<MandateGrants['deviceSession']>>, method: string, path: string, body?: unknown) {
    try {
      return await this.d.grants.asCall(s, method, path, body);
    } catch (e) {
      if (e instanceof GrantRefusal) throw new PasskeyApprovalRefusal(502, e.code, e.message);
      throw e;
    }
  }

  /** The dashboard passkeys that wait for one of this person's devices, as the Authority Server lists them (not yet expired). */
  async pending(): Promise<{ pending: PendingPasskey[]; canApprove: boolean }> {
    const s = await this.sessionOrRefuse();
    const r = await this.asCall(s, 'GET', '/api/passkeys/register/pending');
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.pending)) {
      throw new PasskeyApprovalRefusal(502, asErrorCode(r.body) ?? 'as_answer_invalid', 'The Authority Server answered with something unexpected.');
    }
    const now = this.now();
    const pending = r.body.pending.map(pendingOf).filter((p): p is PendingPasskey => p !== null && p.expiresAt > now);
    return { pending, canApprove: await this.hasCheckKey(s) };
  }

  /** Whether this computer can approve: a check key that its own verified chain names. */
  private async hasCheckKey(s: Awaited<ReturnType<MandateGrants['deviceSession']>>): Promise<boolean> {
    if (!this.d.checks || !this.d.checkStore) return false;
    const dk = await deviceKeys();
    let key;
    try { key = this.d.checkStore.read(); } catch { return false; }
    const device = s.own.devices[s.stored.keyId];
    return Boolean(key && device?.check && dk.checkKeysEqual(device.check, platformCheckKey(key.publicKey)));
  }

  /**
   * Approve the waiting request `requestId`: only one the Authority Server lists for this account right now; signed with this
   * computer's key and its check (one touch). `onTouched` fires once the touch is given (the page then shows the work).
   */
  async approve(requestId: unknown, opts: { onTouched?: () => void } = {}): Promise<{ registered: true; credId: string; code: string }> {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(requestId)) throw new PasskeyApprovalRefusal(400, 'bad_request', 'No such passkey request.');
    const { d } = this;
    if (!d.checks || !d.checkStore) throw new PasskeyApprovalRefusal(409, 'no_check_key', 'This computer has no check key, so it cannot approve a passkey.');
    const s = await this.sessionOrRefuse();
    const dk = await deviceKeys();

    // The request as the Authority Server lists it for this account now: nothing the page sent beyond its id.
    const list = await this.asCall(s, 'GET', '/api/passkeys/register/pending');
    const entry = list.status === 200 && isObj(list.body) && Array.isArray(list.body.pending)
      ? list.body.pending.map(pendingOf).find((p) => p !== null && p.requestId === requestId) ?? null
      : null;
    if (!entry || entry.expiresAt <= this.now()) throw new PasskeyApprovalRefusal(410, 'passkey_request_gone', 'This passkey request is no longer waiting.');

    let checkKey;
    try { checkKey = d.checkStore.read(); } catch { throw new PasskeyApprovalRefusal(409, 'check_key_unreadable', 'The stored check key cannot be read.'); }
    const device = s.own.devices[s.stored.keyId];
    if (!checkKey || !device?.check || !dk.checkKeysEqual(device.check, platformCheckKey(checkKey.publicKey))) {
      throw new PasskeyApprovalRefusal(409, 'no_check_key', 'This computer has no check key that its chain names, so it cannot approve a passkey.');
    }
    const signing = loadDeviceSigningKey(d.vault);
    if (!signing || (await dk.keyIdOf(signing.publicKey)) !== s.stored.keyId) throw new PasskeyApprovalRefusal(409, 'key_mismatch', 'This computer\'s key does not match the stored chain.');

    const register = {
      typ: PASSKEY_REGISTER_TYP, v: 1, root_did: s.stored.rootDid, key_id: s.stored.keyId,
      chain_seq: s.own.head.seq, chain_head: s.own.head.hash,
      request_id: entry.requestId, cred_id: entry.credId, rp_id: entry.rpId, issued_at: this.now(),
    };
    const sig = await dk.signObject(register as never, signing.privateSeed);
    let check;
    try { check = await d.checks.sign(checkKey, dk.signedBytes(register as never)); } catch (e) {
      if (e instanceof CheckError) throw new PasskeyApprovalRefusal(409, 'check_failed', 'The check on this computer was not given.');
      throw e;
    }
    try { opts.onTouched?.(); } catch { /* a progress signal never fails the approval */ }
    const r = await this.asCall(s, 'POST', '/api/passkeys/register', { register, sig, check: platformCheckProof(check.signature) });
    if (r.status !== 201 || !isObj(r.body) || r.body.registered !== true || r.body.cred_id !== entry.credId) {
      const code = asErrorCode(r.body) ?? 'as_answer_invalid';
      throw new PasskeyApprovalRefusal(r.status >= 400 && r.status < 500 ? 409 : 502, code, 'The Authority Server did not register the passkey.');
    }
    return { registered: true, credId: entry.credId, code: entry.code };
  }
}
