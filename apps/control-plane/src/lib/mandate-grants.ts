/**
 * Mandates granted on this computer with its check (device-keys plan 4.4, 7, 20.19, 20.20; build step 13,
 * computer part). Only a gateway that set up a device chain (SUVEREN_DEVICE_KEYS=on) builds this; every other
 * gateway never reaches it and creates mandates exactly as before.
 *
 * What the person grants is what THIS gateway computed, never what a request body or the Authority Server
 * said:
 *   - the mandate payload is built here from the plan the ceremony validated, the team settings read from the
 *     Authority Server (approvers, caps, approval count) and the approvers' own device chains, verified here
 *     with hap-core from the genesis on;
 *   - the grant's members come from that payload (lib @hap/core/mandate-grant, the Authority Server's own
 *     derivation) and are signed with this computer's device key AND its check: one touch, the prompt text built
 *     by the helper from the grant itself;
 *   - the sealed body (scope and intent) is encrypted to every active device of the owner's chain, taken from the
 *     chain this gateway verified, never from the Authority Server's word about devices.
 *
 * Order: everything that can be refused is checked BEFORE the touch; then touch, grant, body; the ceremony
 * requests the mandate last. Nothing is logged but codes: never a body, a signature, a nonce or a key.
 */

import { randomBytes } from 'node:crypto';
import { buildMandateProjection, checkGroupCeilings, encryptProposalContent, decryptProposalContent, decodeMandateBlob, HapError, type AgentProfile, type MandatePayload } from '@hap/core';
import { createGrantMembers, GRANT_FIXED_MEMBERS } from '@hap/core/mandate-grant';
import type { ChainState, MandateGrant } from '@hap/core/device-keys';
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import type { Vault } from './vault';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import type { DeviceChainStore, StoredDeviceChain } from './device-chain-store';
import { DeviceAsClient, AsUnreachableError, asErrorCode } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import { isBearerCredential } from './as-credential';
import { loadDeviceSigningKey, loadOrGenerateKeyPair } from './e2e-key-manager';
import { PinRefusedError, type DevicePinStore } from './device-pin-store';
import { MandateGrantStore } from './mandate-grant-store';
import { CheckError, type CheckKeyStore, type PlatformChecks } from './platform-checks';

export const { grantFieldKeys, grantMembersOf } = createGrantMembers(buildMandateProjection);

/** A refusal with a neutral code. The sentence is a placeholder: wording is the maintainer's (O19). */
export class GrantRefusal extends Error {
  constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GrantRefusal';
  }
}

const refuse = (code: string, message: string, extra?: Record<string, unknown>): never => { throw new GrantRefusal(code, message, extra); };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asMessage = (body: unknown): string => {
  const first = isObj(body) && Array.isArray(body.errors) ? body.errors[0] : undefined;
  const m = isObj(first) && typeof first.message === 'string' ? first.message : '';
  // text of the Authority Server that reaches the page: no control characters, bounded
  return m.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, 400);
};
const BODY_MAX_CHARS = 128 * 1024;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,128}$/;
const MANDATE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** What the ceremony hands in: everything is its own validated data (lib/mandate-ceremony.ts). */
export interface IssueInput {
  /** A mandate id chosen beforehand (the approval claim names it). Used only for a NEW mandate; a change keeps the id of the mandate it continues. */
  mandateId?: string;
  /** The signed-in person's account id and their root DID (the vault's session). */
  ownUserId: string;
  ownDid: string;
  groupId: string;
  isPersonal: boolean;
  profile: AgentProfile;
  bounds: Record<string, string | number>;
  /** Scope (context) and intent, sealed to the owner's devices; their hashes are in `hashes`. */
  scope: Record<string, string | number>;
  intent: string;
  mode: 'review' | 'automatic';
  ttlSeconds: number;
  authorizationId: string;
  /** An earlier authorization this one takes over from (a change of what the mandate IS), or the same one (a renewal). */
  replaces?: string;
  renewal?: boolean;
  hashes: { profile: string; bounds: string; scope: string; intent: string; executionContext: string };
  /** The intent sealed to the approvers (the legacy path, 20.20 item 7 open): its hash goes into the grant. */
  intentDisclosureHash?: string;
  /** Whether the Authority Server will put the owner's verified name on the mandate (it stamps `subjects`). */
  subjectsDisclosed: boolean;
  /** The team's settings for this profile, as the ceremony read them; null in the personal workspace. */
  team: { approvers: string[]; approvals?: number; caps: Record<string, unknown>; eligible?: Array<{ user_id: string; did: string | null }> } | null;
  /** Approver DIDs the person compared (identity code) in this request. */
  confirmedApproverDids?: readonly string[];
  /** Reads of the Authority Server through the person's session (the ceremony's own `as`). */
  as: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

export interface Issued {
  mandateId: string;
  mandateVersion: number;
  expiresAt: number;
  /** The members of the mandate request that the grant covers: the ceremony adds them to its own request. */
  request: Record<string, unknown>;
  /** The approvers' identities shown for the grant (user id, DID, identity code). */
  approvers: Array<{ userId: string; did: string; identityCode: string }>;
}

export interface GrantDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  pins: DevicePinStore;
  grants: MandateGrantStore;
  checks?: PlatformChecks;
  checkStore?: CheckKeyStore;
  /** Epoch seconds. */
  now?: () => number;
}

export interface Session { credential: string; stored: StoredDeviceChain; own: ChainState }

type CapShape = { enforcedBy?: string; boundType?: { kind?: string } };

export class MandateGrants {
  private readonly now: () => number;

  constructor(private readonly d: GrantDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Does this gateway have a device chain (and so grant mandates itself)? Fails closed on an unreadable slot. */
  active(): boolean {
    return this.d.store.exists();
  }

  // ─── reads, verified here ────────────────────────────────────────────────

  private async call(method: string, path: string, credential: string, body?: unknown) {
    try {
      return await this.d.client.call(method, path, { bearer: credential, ...(body !== undefined ? { body } : {}) });
    } catch (e) {
      if (e instanceof AsTlsMismatchError) return refuse('as_tls_mismatch', 'The Authority Server connection did not match its pin.');
      if (e instanceof AsUnreachableError) return refuse('as_unreachable', 'The Authority Server could not be reached.');
      throw e;
    }
  }

  /** A person's chain, verified from the genesis on against `did` and the head pinned before. */
  private async chainOf(did: string, credential: string, pin: { seq: number; hash: string } | null): Promise<ChainState> {
    const dk = await deviceKeys();
    const got = await this.call('GET', `/api/devices/chain?did=${encodeURIComponent(did)}`, credential);
    if (got.status === 404) return refuse('chain_unknown', 'The Authority Server has no device chain for this identity.');
    if (got.status !== 200 || !isObj(got.body) || !Array.isArray(got.body.entries)) return refuse('as_answer_invalid', 'The Authority Server answered with something unexpected.');
    let state: ChainState;
    try {
      state = await dk.verifyChain({ expectedRootDid: did, entries: got.body.entries, storedHead: pin });
    } catch (e) {
      if (isDeviceKeysError(e)) {
        if (e.code === 'ROLLBACK') return refuse('chain_rollback', 'A device chain is shorter than the one verified before.');
        if (e.code === 'FORK') return refuse('chain_fork', 'A device chain differs from the one verified before.');
        return refuse('chain_invalid', `A device chain does not verify (${e.code}).`);
      }
      throw e;
    }
    const named = isObj(got.body.head) ? got.body.head : null;
    if (!named || named.seq !== state.head.seq || named.hash !== state.head.hash) return refuse('head_mismatch', 'The Authority Server named another chain head than its entries end in.');
    return state;
  }

  private async session(): Promise<Session> {
    const { d } = this;
    if (!d.vault.isUnlocked()) return refuse('locked', 'The gateway is locked.');
    let stored;
    try { stored = d.store.read(); } catch { return refuse('chain_unreadable', 'The stored device chain cannot be read.'); }
    if (!stored) return refuse('not_set_up', 'Device keys are not set up.');
    const credential = d.vault.getSpCookie();
    if (!isBearerCredential(credential)) return refuse('not_signed_in', 'This computer is not signed in to the Authority Server.');
    const own = await this.chainOf(stored.rootDid, credential, stored.head);
    const dk = await deviceKeys();
    if (!dk.isActive(own, stored.keyId)) return refuse('device_removed', 'This computer is no longer a device of the chain.');
    return { credential, stored, own };
  }

  /** The mandate id of the mandate an authorization was granted as, read from the Authority Server and verified against this person's chain. */
  async mandateIdFor(authorizationId: string): Promise<string> {
    const s = await this.session();
    return (await this.held(authorizationId, s)).mandateId;
  }

  /** This person's own chain, verified from the genesis on, and this computer's session: what an approval is checked against (lib/device-approvals.ts). */
  approvalSession(): Promise<Session> {
    return this.session();
  }

  // ─── the team's part of the mandate (plan 20.20 item 2) ──────────────────

  /**
   * What the team settings put into the mandate: commitment mode, caps, approvers (DIDs) and count. The same
   * rules the Authority Server applies (app/api/as/mandate/route.ts, v0.8 group branch), recomputed here so
   * that the grant covers them and the Authority Server only has to agree (it refuses a difference).
   */
  private async teamFields(i: IssueInput, s: Session): Promise<{
    mode: 'automatic' | 'review' | 'review_above_cap';
    caps?: Record<string, number>; approvers?: string[]; approvals?: number;
    identities: Issued['approvers']; chainDids: string[];
  }> {
    const dk = await deviceKeys();
    const plain = { mode: i.mode, identities: [] as Issued['approvers'], chainDids: [s.stored.rootDid] };
    const team = i.team;
    if (!team) return plain;
    // Caps: hard or approval, by the same forcing rules as the Authority Server's `effectiveCapKind`.
    const defs = (i.profile.boundsSchema?.fields ?? {}) as unknown as Record<string, CapShape>;
    const approval: Record<string, number> = {};
    const hard: Record<string, number | string> = {};
    for (const [field, raw] of Object.entries(team.caps ?? {})) {
      const cfg = isObj(raw) ? raw : { value: raw };
      const def = defs[field];
      const stored = cfg.kind === 'hard' ? 'hard' : 'approval';
      const kind = team.approvers.length === 0 || def?.enforcedBy === 'gatekeeper' || def?.boundType?.kind === 'enum' ? 'hard' : stored;
      if (kind === 'approval' && typeof cfg.value === 'number') approval[field] = cfg.value;
      else hard[field] = cfg.value as number | string;
    }
    // The approvers: the list the Authority Server gives with the team's settings (`eligible_approvers`, DEC-35 already applied, in
    // ascending DID order), each with a device chain. Its answer is checked below: every DID's chain is verified here and its
    // identity code is shown before a person first accepts it. Without the list the grant is not made.
    const identities: Issued['approvers'] = [];
    if (team.approvers.length > 0 && !Array.isArray(team.eligible)) return refuse('approvers_unavailable', 'The Authority Server did not say who may approve for this team.');
    const seenDid = new Set<string>();
    for (const e of team.eligible ?? []) {
      if (typeof e.did === 'string') { if (seenDid.has(e.did)) continue; seenDid.add(e.did); }
      if (!team.approvers.includes(e.user_id)) return refuse('approver_unresolved', 'The Authority Server named an approver this team does not have.');
      if (e.did === null) return refuse('approver_has_no_chain', 'A team approver has no device chain; a mandate does not mix accounts with and without one.');
      if (typeof e.did !== 'string' || !DID.test(e.did)) return refuse('approver_unresolved', 'An approver of this team could not be identified.');
      identities.push({ userId: e.user_id, did: e.did, identityCode: await dk.identityCode(e.did) });
    }
    for (const a of identities) {
      if (a.did === s.stored.rootDid) continue;
      const pin = this.d.pins.get(a.did);
      let state: ChainState;
      try { state = await this.chainOf(a.did, s.credential, pin); } catch (e) {
        if (e instanceof GrantRefusal && e.code === 'chain_unknown') return refuse('approver_has_no_chain', 'A team approver has no device chain; a mandate does not mix accounts with and without one.');
        throw e;
      }
      try { this.d.pins.advance(a.did, state.head, this.protectedDids()); } catch (e) {
        const reason = (e as { reason?: string })?.reason;
        if (reason === 'rollback') return refuse('chain_rollback', 'A device chain is shorter than the one verified before.');
        if (reason === 'fork') return refuse('chain_fork', 'A device chain differs from the one verified before.');
        throw e;
      }
    }
    const approverDids = identities.map(a => a.did).sort();   // ascending, as the Authority Server signs them
    const approvalsNeeded = team.approvals ?? 1;
    const reachable = approverDids.filter(x => x !== i.ownDid).length >= approvalsNeeded;
    const approvalFields = Object.keys(approval);
    try {
      checkGroupCeilings(i.bounds as never, i.profile, reachable ? { approval, hard } : { hard: { ...hard, ...approval }, approval: {} });
    } catch (e) {
      return refuse('cap_exceeded', e instanceof HapError || e instanceof Error ? e.message : 'A limit exceeds the team cap.');
    }
    const chainDids = [...new Set([s.stored.rootDid, ...(approvalFields.length > 0 && reachable ? approverDids : [])])].sort();
    if (approvalFields.length > 0 && reachable) {
      return { mode: i.mode === 'review' ? 'review' : 'review_above_cap', caps: approval, approvers: approverDids, approvals: approvalsNeeded, identities, chainDids };
    }
    return { mode: i.mode, identities, chainDids };
  }

  // ─── the grant ───────────────────────────────────────────────────────────

  /**
   * The mandate behind an authorization this person holds, with its newest grant on file VERIFIED against this
   * gateway's own chain (hap-core `verifyGrant`): a change or a revocation is built from what the owner granted,
   * never from what the Authority Server says it holds. Throws when the mandate was revoked.
   */
  private async held(authorizationId: string, s: Session): Promise<{ mandateId: string; version: number; grant: MandateGrant }> {
    const dk = await deviceKeys();
    const r = await this.call('GET', `/api/mandates?authorization_id=${encodeURIComponent(authorizationId)}`, s.credential);
    const list = isObj(r.body) && Array.isArray(r.body.mandates) ? r.body.mandates : [];
    let mandateId = '';
    for (const m of list) {
      try {
        const p = decodeMandateBlob((m as { blob: string }).blob).payload;
        if (p.mandate_owners?.[0]?.did === s.stored.rootDid && typeof p.mandate_id === 'string' && MANDATE_ID.test(p.mandate_id)) { mandateId = p.mandate_id; break; }
      } catch { /* not a mandate this gateway can read */ }
    }
    if (r.status !== 200 || !mandateId) return refuse('mandate_unknown', 'The mandate could not be found.');
    const g = await this.call('GET', `/api/mandates/${encodeURIComponent(mandateId)}/grants`, s.credential);
    if (g.status !== 200 || !isObj(g.body) || !Array.isArray(g.body.grants)) return refuse('as_answer_invalid', 'The Authority Server answered with something unexpected.');
    const grants = g.body.grants.filter(isObj);
    // A revoke row counts only when it verifies as a revoke of a device of THIS chain; an unverified one is ignored.
    const fixedNames = new Set(GRANT_FIXED_MEMBERS);
    for (const e of grants.filter(x => x.op === 'revoke' && isObj(x.grant) && Number.isSafeInteger(x.mandate_version))) {
      const rg = e.grant as MandateGrant;
      const rf: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rg)) if (!fixedNames.has(k)) rf[k] = v;
      try {
        await dk.verifyGrant({ grant: rg, sig: e.sig, check: e.check ?? undefined }, { chain: s.own, mandateFields: rf, expect: { ops: ['revoke'], mandate_id: mandateId, mandate_version: e.mandate_version as number } });
        return refuse('mandate_revoked', 'This mandate was revoked on a device; a revocation is final.');
      } catch (err) { if (!isDeviceKeysError(err)) throw err; }
    }
    const live = grants.filter(e => e.op !== 'revoke' && isObj(e.grant) && typeof e.mandate_version === 'number');
    live.sort((a, b) => (b.mandate_version as number) - (a.mandate_version as number));
    const top = live[0];
    if (!top) return refuse('mandate_unknown', 'No grant is on file for this mandate.');
    const grant = top.grant as MandateGrant;
    const fixed = new Set(GRANT_FIXED_MEMBERS);
    const mandateFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(grant)) if (!fixed.has(k)) mandateFields[k] = v;
    try {
      await dk.verifyGrant({ grant, sig: top.sig, check: top.check ?? undefined }, { chain: s.own, mandateFields, expect: { ops: [grant.op], mandate_id: mandateId, mandate_version: top.mandate_version as number } });
    } catch (e) {
      if (isDeviceKeysError(e)) return refuse('grant_invalid', `The grant on file does not verify (${e.code}).`);
      throw e;
    }
    const version = Math.max(top.mandate_version as number, this.d.grants.get(mandateId)?.version ?? 0);
    return { mandateId, version, grant };
  }

  /**
   * Prepare, sign and store the grant for this mandate and store its sealed body. Returns what the ceremony adds
   * to its own request to the Authority Server. Throws {@link GrantRefusal}.
   */
  async issue(i: IssueInput): Promise<Issued> {
    const { d } = this;
    const dk = await deviceKeys();
    const s = await this.session();
    if (!d.checks || !d.checkStore) return refuse('no_check_key', 'This computer has no check key, so it cannot grant a mandate.');

    // 1. who the mandate is for: the signed-in person, and nobody else
    if (i.ownDid !== s.stored.rootDid) return refuse('wrong_identity', 'The signed-in person is not the owner of this device chain.');

    // 2. the mandate this one continues, if any
    let mandateId: string = typeof i.mandateId === 'string' && MANDATE_ID.test(i.mandateId) ? i.mandateId : randomBytes(18).toString('base64url');
    let version = 1;
    let op: 'grant' | 'change' = 'grant';
    let replaces: string | null = null;
    let authorizationId = i.authorizationId;
    let prevGrant: Record<string, unknown> | undefined;
    let intentDisclosureHash = i.intentDisclosureHash;
    let subjectsDisclosed = i.subjectsDisclosed;
    if (i.replaces || i.renewal) {
      const prev = await this.held(i.replaces ?? i.authorizationId, s);
      const was = prev.grant as Record<string, unknown>;
      prevGrant = was;
      // The mandate the AS named must be the one the owner granted for THIS authorization.
      if (typeof was.authorization_id !== 'string' || was.authorization_id !== (i.replaces ?? i.authorizationId)) {
        return refuse('mandate_mismatch', 'The mandate to change was already replaced by another.');
      }
      mandateId = prev.mandateId;
      version = prev.version + 1;
      op = 'change';
      replaces = i.renewal ? (typeof was.replaces === 'string' ? was.replaces : null) : i.replaces!;
      // A renewal moves only the expiry: the intent sealed to the approvers and the shown name stay as granted.
      if (i.renewal) {
        intentDisclosureHash = typeof was.intent_disclosure_hash === 'string' ? was.intent_disclosure_hash : undefined;
        subjectsDisclosed = was.subjects_disclosed === true;
      }
    }

    // 3. the team's part, and the payload as the Authority Server will sign it
    const team = await this.teamFields(i, s);
    const unconfirmed = team.identities.filter(a => a.did !== s.stored.rootDid && !d.grants.approverConfirmed(a.did) && !(i.confirmedApproverDids ?? []).includes(a.did));
    if (unconfirmed.length > 0) {
      return refuse('approver_identity_unconfirmed', 'Compare the identity code of each new approver before granting.', { approvers: unconfirmed.map(a => ({ userId: a.userId, did: a.did, identityCode: a.identityCode })) });
    }
    // The person compared these codes: remembered, so each DID is asked about once.
    const compared = (i.confirmedApproverDids ?? []).filter(x => team.identities.some(a => a.did === x));
    if (compared.length > 0) { try { d.grants.confirmApprovers(compared); } catch { /* asked again next time */ } }
    const now = this.now();
    const expiresAt = now + i.ttlSeconds;
    const carries = team.approvers !== undefined;
    const payload = {
      mandate_id: mandateId, version: '0.8', profile_id: i.profile.id, bounds_hash: i.hashes.bounds, scope_hash: i.hashes.scope,
      execution_context_hash: i.hashes.executionContext, profile_hash: i.hashes.profile, issuer: 'did:key:z',
      mandate_owners: [{ did: i.ownDid }], gate_content_hashes: { intent: i.hashes.intent },
      ...(subjectsDisclosed ? { subjects: [{ did: i.ownDid }] } : {}),
      ...(intentDisclosureHash ? { intent_disclosure_hash: intentDisclosureHash } : {}),
      commitment_mode: team.mode,
      ...(carries ? { above_cap_caps: team.caps, above_cap_approvers: team.approvers, ...(team.approvals !== undefined ? { above_cap_approvals: team.approvals } : {}) } : {}),
      issued_at: now, expires_at: expiresAt,
    } as unknown as MandatePayload;
    const members = grantMembersOf(payload, { authorizationId, groupId: i.groupId, replaces, chainDids: team.chainDids });
    // A renewal moves only the expiry. Everything else the previous VERIFIED grant said must be equal; otherwise it is a change of what
    // the mandate IS and goes through the change flow (a new authorization and the diff the person sees).
    if (i.renewal && prevGrant) {
      for (const k of Object.keys(members)) {
        if (k === 'expires_at') continue;
        if (dk.jcs({ x: members[k] }) !== dk.jcs({ x: prevGrant[k] ?? null })) return refuse('renewal_is_a_change', `Extending only moves the end date; "${k}" differs from what was granted, so this is a change.`, { member: k });
      }
    }

    // 4. this computer's check key must be the one its chain names, BEFORE anything is asked of the person
    let checkKey;
    try { checkKey = d.checkStore.read(); } catch { return refuse('check_key_unreadable', 'The stored check key cannot be read.'); }
    const device = s.own.devices[s.stored.keyId];
    if (!checkKey || !device?.check || !dk.checkKeysEqual(device.check, platformCheckKey(checkKey.publicKey))) {
      return refuse('no_check_key', 'This computer has no check key that its chain names, so it cannot grant a mandate.');
    }
    const signing = loadDeviceSigningKey(d.vault);
    if (!signing || (await dk.keyIdOf(signing.publicKey)) !== s.stored.keyId) return refuse('key_mismatch', 'This computer\'s key does not match the stored chain.');

    // 5. the grant, signed with the device key and the computer's check (one touch; the helper words the prompt)
    const grant = dk.buildGrant({
      op, owner_did: i.ownDid, key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash,
      mandate_id: mandateId, mandate_version: version, granted_at: now, nonce: dk.b64uEncode(randomBytes(16)),
    }, members) as MandateGrant;
    const sig = await dk.signObject(grant, signing.privateSeed);
    let check;
    try { check = await d.checks.sign(checkKey, dk.signedBytes(grant)); } catch (e) {
      if (e instanceof CheckError) return refuse('check_failed', 'The check on this computer was not given.', { reason: e.helperCode ?? e.code });
      throw e;
    }
    const body = { grant, sig, check: platformCheckProof(check.signature) };
    const hash = await dk.grantHash(grant);

    // 6. store the grant at the Authority Server (one retry when the chain moved while it checked)
    let stored = await this.call('POST', `/api/mandates/${encodeURIComponent(mandateId)}/grants`, s.credential, body);
    if (stored.status === 409 && asErrorCode(stored.body) === 'CHAIN_HEAD_MOVED') stored = await this.call('POST', `/api/mandates/${encodeURIComponent(mandateId)}/grants`, s.credential, body);
    if (stored.status !== 200 && stored.status !== 201) {
      return refuse(asErrorCode(stored.body) ?? 'grant_refused', asMessage(stored.body) || 'The Authority Server refused the grant.');
    }
    if (!isObj(stored.body) || stored.body.grant_hash !== hash || stored.body.mandate_version !== version) return refuse('as_answer_invalid', 'The Authority Server answered with something unexpected.');
    try { d.grants.observe(mandateId, version, hash, op); } catch { return refuse('grant_not_recorded', 'This computer could not record the grant.'); }

    // 7. the sealed body: to every ACTIVE device of the chain this gateway verified
    const readers = dk.activeDevices(s.own).map(x => ({ did: x.key_id, publicKey: dk.b64uDecode(x.read_pub) }));
    const sealed = await encryptProposalContent({ v: 1, mandate_id: mandateId, mandate_version: version, scope: i.scope, intent: i.intent }, readers);
    const bodyReply = await this.call('POST', '/api/mandates/prepared', s.credential, {
      mandate_id: mandateId, mandate_version: version, ciphertext: sealed.content.ciphertext, device_keys: sealed.content.encrypted_keys,
    });
    if (bodyReply.status !== 201) {
      return refuse(asErrorCode(bodyReply.body) ?? 'body_refused', asMessage(bodyReply.body) || 'The Authority Server did not take the sealed mandate body.');
    }

    // 8. what the ceremony adds to its request
    const request: Record<string, unknown> = {
      mandate_id: mandateId, mandate_version: version, expires_at: expiresAt, commitment_mode: team.mode,
      mandate_owners: [{ did: i.ownDid }],
      ...(carries ? { above_cap_caps: team.caps, above_cap_approvers: team.approvers, ...(team.approvals !== undefined ? { above_cap_approvals: team.approvals } : {}) } : {}),
      // A renewal names `replaces` as the grant before it did: the Authority Server checks the grant against the request's.
      ...(i.renewal ? { renew: true, ...(replaces ? { replaces } : {}) } : {}),
    };
    return { mandateId, mandateVersion: version, expiresAt, request, approvers: team.identities };
  }

  // ─── revoke: device-signed and final ─────────────────────────────────────

  /**
   * End a mandate with a device signature (no check; any active device). The members are those of the newest
   * grant on file, which this gateway verified against its own chain first: it signs what the owner granted,
   * not what the Authority Server says.
   */
  async revoke(authorizationId: string): Promise<{ mandateId: string; version: number }> {
    const { d } = this;
    const dk = await deviceKeys();
    const s = await this.session();
    const prev = await this.held(authorizationId, s);
    const signing = loadDeviceSigningKey(d.vault);
    if (!signing || (await dk.keyIdOf(signing.publicKey)) !== s.stored.keyId) return refuse('key_mismatch', 'This computer\'s key does not match the stored chain.');
    const { grant: g, version, mandateId } = prev;
    const members: Record<string, unknown> = {};
    const fixed = new Set(GRANT_FIXED_MEMBERS);
    for (const [k, v] of Object.entries(g)) if (!fixed.has(k)) members[k] = v;
    const revoke = dk.buildGrant({
      op: 'revoke', owner_did: s.stored.rootDid, key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash,
      mandate_id: mandateId, mandate_version: version, granted_at: this.now(), nonce: dk.b64uEncode(randomBytes(16)),
    }, members) as MandateGrant;
    const sig = await dk.signObject(revoke, signing.privateSeed);
    const r = await this.call('POST', `/api/mandates/${encodeURIComponent(mandateId)}/grants`, s.credential, { grant: revoke, sig });
    if (r.status !== 200 && r.status !== 201) return refuse(asErrorCode(r.body) ?? 'revoke_refused', asMessage(r.body) || 'The Authority Server refused the revocation.');
    try { d.grants.observe(mandateId, version, await dk.grantHash(revoke), 'revoke'); } catch { /* the Authority Server holds it; the MCP server learns it from there */ }
    return { mandateId, version };
  }

  /** Pins that are never dropped when the table is full: this person's own chain and every identity they confirmed. */
  protectedDids(): string[] {
    let own: string[] = [];
    try { const r = this.d.store.read()?.rootDid; if (r) own = [r]; } catch { /* locked */ }
    try { return [...own, ...this.d.grants.confirmedList()]; } catch { return own; }
  }

  /**
   * Pin a person's chain head AFTER verifying the chain here (the Authority Server's copy, from the genesis on, against the head pinned
   * before). A caller names only the DID; what it verified itself is not taken on its word. Throws {@link PinRefusedError} for a
   * rollback, a fork and for this computer's own chain (moved by sign-in only).
   */
  async pinChain(did: string): Promise<{ seq: number; hash: string }> {
    if (typeof did !== 'string' || !DID.test(did)) throw new PinRefusedError('bad_request');
    const s = await this.session();
    if (did === s.stored.rootDid) throw new PinRefusedError('own_chain');
    let state: ChainState;
    try { state = await this.chainOf(did, s.credential, this.d.pins.get(did)); } catch (e) {
      if (e instanceof GrantRefusal && e.code === 'chain_rollback') throw new PinRefusedError('rollback');
      if (e instanceof GrantRefusal && e.code === 'chain_fork') throw new PinRefusedError('fork');
      throw e;
    }
    return this.d.pins.advance(did, state.head, this.protectedDids());
  }

  /** The person withdraws a confirmation of someone's identity. */
  forgetIdentity(did: unknown): void {
    if (typeof did !== 'string' || !DID.test(did)) throw new GrantRefusal('bad_request', 'Bad request.');
    this.d.grants.forgetApprover(did);
  }

  // ─── what the MCP server asks to have remembered: only what this control plane verified itself ───

  /** Is this DID this person's own, or one whose identity code they compared and accepted? */
  ownerKnown(did: string): boolean {
    if (typeof did !== 'string' || !DID.test(did)) return false;
    try { if (this.d.store.read()?.rootDid === did) return true; } catch { return false; }
    return this.d.grants.approverConfirmed(did);
  }

  /** The person compared the identity code of `did` with the one on the other person's own screen. */
  async confirmIdentity(did: unknown, code: unknown): Promise<void> {
    const dk = await deviceKeys();
    if (typeof did !== 'string' || !DID.test(did) || typeof code !== 'string') return refuse('bad_request', 'Bad request.');
    if ((await dk.identityCode(did)).replace(/\D/g, '') !== code.replace(/\D/g, '')) return refuse('identity_code_mismatch', 'The identity code does not match this person.');
    this.d.grants.confirmApprovers([did]);
  }

  /**
   * The grant of (mandate, version) as the Authority Server carries it, verified HERE against the owner's chain (the owner is this
   * person, or someone they confirmed): its device signature, its check, the named head, the hash the caller names. The MCP server
   * checks the same against the signed mandate; this is what keeps a caller from making this control plane remember, or answer
   * with a receipt, something it did not see verify.
   */
  async verifyHeld(i: { mandateId: string; version: number; grantHash: string; op?: 'grant' | 'change' | 'revoke' }): Promise<{ ownerDid: string; op: 'grant' | 'change' | 'revoke' }> {
    const dk = await deviceKeys();
    if (!MANDATE_ID.test(i.mandateId) || !Number.isSafeInteger(i.version) || i.version < 1 || !/^sha256:[0-9a-f]{64}$/.test(i.grantHash)) return refuse('bad_request', 'Bad request.');
    const s = await this.session();
    const g = await this.call('GET', `/api/mandates/${encodeURIComponent(i.mandateId)}/grants`, s.credential);
    if (g.status !== 200 || !isObj(g.body) || !Array.isArray(g.body.grants)) return refuse('as_answer_invalid', 'The Authority Server answered with something unexpected.');
    let row: Record<string, unknown> | undefined;
    for (const e of g.body.grants) {
      if (!isObj(e) || !isObj(e.grant) || e.mandate_version !== i.version || (i.op ? e.op !== i.op : e.op === 'revoke')) continue;
      if (await dk.grantHash(e.grant as MandateGrant) === i.grantHash) { row = e; break; }
    }
    if (!row) return refuse('grant_not_held', 'The Authority Server does not hold this grant.');
    const grant = row.grant as MandateGrant;
    const ownerDid = String(grant.owner_did);
    if (!this.ownerKnown(ownerDid)) return refuse('owner_unknown', 'The owner of this mandate is not this person and has not been confirmed.');
    let chain = s.own;
    if (ownerDid !== s.stored.rootDid) {
      chain = await this.chainOf(ownerDid, s.credential, this.d.pins.get(ownerDid));
      try { this.d.pins.advance(ownerDid, chain.head, this.protectedDids()); } catch (e) {
        const reason = (e as { reason?: string })?.reason;
        if (reason === 'rollback') return refuse('chain_rollback', 'A device chain is shorter than the one verified before.');
        if (reason === 'fork') return refuse('chain_fork', 'A device chain differs from the one verified before.');
        throw e;
      }
    }
    const fixed = new Set(GRANT_FIXED_MEMBERS);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(grant)) if (!fixed.has(k)) fields[k] = v;
    try {
      await dk.verifyGrant({ grant, sig: row.sig, check: row.check ?? undefined }, { chain, mandateFields: fields, expect: { ops: [grant.op], mandate_id: i.mandateId, mandate_version: i.version } });
    } catch (e) {
      if (isDeviceKeysError(e)) return refuse('grant_invalid', `The grant does not verify (${e.code}).`);
      throw e;
    }
    return { ownerDid, op: grant.op };
  }

  // ─── the sealed body (plan 20.19, DEC-58) ───────────────────────────────

  /**
   * Open the sealed body (scope and intent) of a mandate version for THIS computer. The Authority Server only carries it.
   *
   *   - the grant it belongs to is verified here first (`verifyHeld`: the owner's chain, the device signature, the check);
   *     only the owner's own computers are recipients, so any other owner is refused;
   *   - the wrap is the one under THIS computer's key id, and it is opened only with this computer's own read key after that key
   *     equals the `read_pub` of this computer's record in the chain this gateway verified (never the Authority Server's word);
   *   - the opened content must name exactly this mandate and version and have exactly the members of a body;
   *   - the caller (the MCP server) compares scope and intent with the hashes of the verified mandate before anything is used.
   *
   * A missing body or wrap is `body_not_received`: shown as not yet received, never replaced by anything the Authority Server
   * says in the clear. Nothing of the body, a wrap or a key is logged or put into an error text.
   */
  async openBody(input: { mandateId: string; version: number; grantHash: string }): Promise<{ scope: Record<string, string | number>; intent: string }> {
    const { d } = this;
    const dk = await deviceKeys();
    if (!MANDATE_ID.test(input.mandateId) || !Number.isSafeInteger(input.version) || input.version < 1 || !/^sha256:[0-9a-f]{64}$/.test(input.grantHash)) return refuse('bad_request', 'Bad request.');
    const s = await this.session();
    const held = await this.verifyHeld(input);
    if (held.ownerDid !== s.stored.rootDid || held.op === 'revoke') return refuse('not_own_mandate', 'Only the owner\'s own computers receive the sealed body of a mandate.');
    const got = await this.call('GET', `/api/mandates/${encodeURIComponent(input.mandateId)}/body`, s.credential);
    if (got.status !== 200 || !isObj(got.body) || !Array.isArray(got.body.bodies)) return refuse('as_answer_invalid', 'The Authority Server answered with something unexpected.');
    const row = got.body.bodies.find((b: unknown) => isObj(b) && b.mandate_id === input.mandateId && b.mandate_version === input.version);
    if (!isObj(row) || !isObj(row.device_key)) return refuse('body_not_received', 'The sealed mandate has not reached this computer yet.');
    const { ciphertext, device_key: wrap } = row as { ciphertext?: unknown; device_key: Record<string, unknown> };
    const B64U = /^[A-Za-z0-9_-]+$/;
    if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > BODY_MAX_CHARS || !B64U.test(ciphertext)
      || Object.keys(wrap).sort().join() !== 'ct,enc' || typeof wrap.ct !== 'string' || typeof wrap.enc !== 'string' || !B64U.test(wrap.ct) || !B64U.test(wrap.enc)) {
      return refuse('body_invalid', 'The sealed mandate is not in the shape of one.');
    }
    // This computer's reading key is the one its own record in the verified chain names.
    const record = s.own.devices[s.stored.keyId];
    const kp = await loadOrGenerateKeyPair(d.vault);
    if (!record || record.read_pub !== dk.b64uEncode(kp.publicKey)) return refuse('key_mismatch', 'This computer\'s reading key does not match the stored chain.');
    let content: unknown;
    try {
      const opened = await decryptProposalContent({ ciphertext, encrypted_keys: { [s.stored.keyId]: { ct: wrap.ct, enc: wrap.enc } }, readers: [s.stored.keyId], unreadable: [] }, s.stored.keyId, kp.privateKey);
      content = opened.arguments;
    } catch {
      return refuse('body_unreadable', 'The sealed mandate cannot be opened with this computer\'s key.');
    }
    if (!isObj(content) || Object.keys(content).sort().join() !== 'intent,mandate_id,mandate_version,scope,v'
      || content.v !== 1 || content.mandate_id !== input.mandateId || content.mandate_version !== input.version) {
      return refuse('body_invalid', 'The sealed mandate does not name this mandate and version.');
    }
    const { scope, intent } = content;
    if (typeof intent !== 'string' || intent.length > 20_000 || !isObj(scope) || Object.keys(scope).length > 64
      || Object.entries(scope).some(([k, v]) => k.length > 100 || !(typeof v === 'string' ? v.length <= 4_000 : typeof v === 'number' && Number.isFinite(v)))) {
      return refuse('body_invalid', 'The sealed mandate is not in the shape of one.');
    }
    return { scope: scope as Record<string, string | number>, intent };
  }

  // ─── receipt (DEC-23) ────────────────────────────────────────────────────

  /**
   * This computer verified the grant of `version` (the MCP server did, against the chain it pinned): answer it with
   * this computer's signed receipt, once. The chain position and the key come from THIS gateway's own record.
   */
  async receipt(input: { mandateId: string; version: number; grantHash: string }): Promise<{ sent: boolean }> {
    const { d } = this;
    const dk = await deviceKeys();
    if (!MANDATE_ID.test(input.mandateId) || !Number.isSafeInteger(input.version) || input.version < 1 || !/^sha256:[0-9a-f]{64}$/.test(input.grantHash)) return refuse('bad_request', 'Bad request.');
    if (d.grants.isReceipted(input.mandateId, input.version)) return { sent: false };
    const s = await this.session();
    // Only a grant this control plane verified itself, and only the owner's OWN gateway answers one.
    const held = await this.verifyHeld(input);
    if (held.ownerDid !== s.stored.rootDid || held.op === 'revoke') return refuse('not_own_mandate', 'Only the owner\'s own computer answers a grant with a receipt.');
    const signing = loadDeviceSigningKey(d.vault);
    if (!signing || (await dk.keyIdOf(signing.publicKey)) !== s.stored.keyId) return refuse('key_mismatch', 'This computer\'s key does not match the stored chain.');
    const receipt = dk.buildReceipt({
      mandate_id: input.mandateId, mandate_version: input.version, grant_hash: input.grantHash,
      key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash, received_at: this.now(),
    });
    const sig = await dk.signObject(receipt, signing.privateSeed);
    const r = await this.call('POST', `/api/mandates/${encodeURIComponent(input.mandateId)}/receipts`, s.credential, { receipt, sig });
    if (r.status !== 200 && r.status !== 201) return refuse(asErrorCode(r.body) ?? 'receipt_refused', asMessage(r.body) || 'The Authority Server did not take the receipt.');
    d.grants.markReceipted(input.mandateId, input.version);
    return { sent: true };
  }
}
