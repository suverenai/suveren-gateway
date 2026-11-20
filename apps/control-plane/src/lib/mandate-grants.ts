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
import type { ChainState, MandateGrant, MemberList } from '@hap/core/device-keys';
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
import { PhoneGiveStore } from './phone-give-store';
import type { TeamTrustStore, TeamTrustCode, VerifiedTeam } from './team-trust-store';
import { ensureTeamTrust, refreshTeamTrust, honouredTeam, teamTrustFresh, type TeamTrustEnv } from './team-trust';
import { CheckError, type CheckKeyStore, type PlatformChecks } from './platform-checks';

/** Trust in the team's list is refused, blocked, or older than the grace window: the join screens do not build on it. `code` is a TeamTrustCode or 'stale'. */
export class TeamTrustUnavailable extends Error {
  constructor(readonly code: TeamTrustCode | 'stale') {
    super(code);
    this.name = 'TeamTrustUnavailable';
  }
}

/** What the join screens (step 4) ask: the verified head of the team's list, from the slot, brought up to date when older than 5 minutes. */
export interface TeamTrustPort {
  /** The newest verified list and its hash; null when this person has no team or no list; throws {@link TeamTrustUnavailable} when trust is refused, blocked, or stale beyond the grace window. */
  head(teamId: string, session: Session): Promise<{ list: MemberList; hash: string } | null>;
}

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
  /**
   * Approver DIDs the person compared (identity code) in this request. NOT USED any more (DEC-73): who is a colleague comes from the
   * team's verified member list, and no code is asked at grant time. Kept so that an older page's request still parses.
   */
  confirmedApproverDids?: readonly string[];
  /** Reads of the Authority Server through the person's session (the ceremony's own `as`). */
  as: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

export interface PreparedGrant {
  mode: 'automatic' | 'review' | 'review_above_cap';
  /** Informational: now + the duration. The binding of a give uses the duration, not this. */
  expiresAt: number;
  caps: Record<string, number> | null;
  approvals: number | null;
  /** `confirmed`: this approver is in the team's verified member list (or is this person). `name` is the label the admin signed in the list. */
  approvers: Array<{ userId: string; did: string; identityCode: string; isYou: boolean; confirmed: boolean; name?: string }>;
  chainDids: string[];
  blocked: { code: string; message: string; approvers?: Array<{ userId: string; did: string; identityCode: string; name?: string }> } | null;
  /** The person's phone (another active device with a check key) can give this mandate instead: `/give-on-phone`. */
  onPhone: boolean;
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

/** The version a change continues, as this computer holds it (plaintext); the phone checks it against that version's grant. */
export interface PhonePrevious {
  profile: AgentProfile;
  bounds: Record<string, string | number>;
  scope: Record<string, string | number>;
  intent: string;
  expires_at: number;
}

/** A give prepared for the person's phone (`sendToPhone`): what the grant must cover, and what the ceremony then requests. */
export interface PhoneGive {
  mandateId: string;
  mandateVersion: number;
  expiresAt: number;
  op: 'grant' | 'change';
  /** The members planned here: the phone's grant must carry exactly these. */
  members: Record<string, unknown>;
  request: Record<string, unknown>;
  approvers: Array<{ userId: string; did: string; identityCode: string }>;
}

export interface GrantDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  pins: DevicePinStore;
  grants: MandateGrantStore;
  /** The team's verified member list: who counts as a colleague (DEC-73; replaces the per-computer confirmation). */
  teamTrust: TeamTrustStore;
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

  /** Gives waiting on the person's phone, sealed in this gateway's vault (kept across a restart). */
  get phoneGives(): PhoneGiveStore {
    return (this.phoneGiveStore ??= new PhoneGiveStore(this.d.vault, this.now));
  }
  private phoneGiveStore?: PhoneGiveStore;

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

  /**
   * For lib/team-join.ts (DEC-73): a call to the Authority Server with this person's session, answered as the neutral refusals
   * of this class (unreachable, TLS pin), never a thrown network error.
   */
  asCall(s: Session, method: string, path: string, body?: unknown) {
    return this.call(method, path, s.credential, body);
  }

  /**
   * For lib/team-join.ts: another person's chain verified from the genesis on against the head pinned before, and the pin moved
   * forward (a rollback or a fork is a refusal, as for an approver's chain in `teamFields`).
   */
  async verifiedChainOf(did: string, s: Session): Promise<ChainState> {
    if (typeof did !== 'string' || !DID.test(did)) return refuse('bad_request', 'Bad request.');
    if (did === s.stored.rootDid) return s.own;
    const state = await this.chainOf(did, s.credential, this.d.pins.get(did));
    try { this.d.pins.advance(did, state.head, this.protectedDids()); } catch (e) {
      const reason = (e as { reason?: string })?.reason;
      if (reason === 'rollback') return refuse('chain_rollback', 'A device chain is shorter than the one verified before.');
      if (reason === 'fork') return refuse('chain_fork', 'A device chain differs from the one verified before.');
      throw e;
    }
    return state;
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
   * What a give would grant, WITHOUT the touch and without any write at the Authority Server or here: the team's part as this gateway
   * computes it, each approver with their DID, identity code and whether this person confirmed them, and the first refusal the real give
   * would meet before the touch (`blocked`). Reads only (the chain, the approvers' chains, the team settings).
   */
  async prepare(i: IssueInput): Promise<PreparedGrant> {
    const { d } = this;
    const dk = await deviceKeys();
    const s = await this.session();
    // Another active device of this chain that names a check key can give it instead (the person's phone, plan 4.4 "Transport").
    const onPhone = dk.activeDevices(s.own).some(x => x.key_id !== s.stored.keyId && !!x.check);
    const empty = (blocked: PreparedGrant['blocked']): PreparedGrant => ({ mode: i.mode, expiresAt: this.now() + i.ttlSeconds, caps: null, approvals: null, approvers: [], chainDids: [], blocked, onPhone: false });
    try {
      if ((!d.checks || !d.checkStore) && !onPhone) return empty({ code: 'no_check_key', message: 'This computer has no check key, so it cannot grant a mandate.' });
      const plan = await this.planGrant(i, s, dk, true);
      let blocked: PreparedGrant['blocked'] = null;
      if (plan.notListed.length > 0) {
        blocked = { code: plan.listCode, message: plan.listCode === 'team_list_unavailable' ? 'Your team\'s member list could not be checked.' : 'An approver is not in your team\'s member list.', approvers: plan.notListed.map(a => ({ userId: a.userId, did: a.did, identityCode: a.identityCode })) };
      } else {
        let checkKey;
        try { checkKey = d.checkStore?.read(); } catch { checkKey = undefined; }
        const device = s.own.devices[s.stored.keyId];
        if (!d.checks || !checkKey || !device?.check || !dk.checkKeysEqual(device.check, platformCheckKey(checkKey.publicKey))) blocked = { code: 'no_check_key', message: 'This computer has no check key that its chain names, so it cannot grant a mandate.' };
      }
      const t = plan.team;
      return {
        mode: t.mode, expiresAt: plan.expiresAt, caps: t.caps ?? null, approvals: t.approvals ?? null, chainDids: t.chainDids,
        approvers: t.identities.map(a => ({ userId: a.userId, did: a.did, identityCode: a.identityCode, isYou: a.did === s.stored.rootDid, confirmed: a.did === s.stored.rootDid || plan.listed.has(a.did), ...(plan.listed.get(a.did) !== undefined ? { name: plan.listed.get(a.did) } : {}) })),
        blocked,
        // Only the missing check key here can be helped by the phone; a team-list refusal blocks the phone's give the same way.
        onPhone: onPhone && (blocked === null || blocked.code === 'no_check_key'),
      };
    } catch (e) {
      if (e instanceof GrantRefusal) return empty({ code: e.code, message: e.message, ...(Array.isArray(e.extra.approvers) ? { approvers: e.extra.approvers as never } : {}) });
      throw e;
    }
  }

  /**
   * Steps 1 to 3 of a give: who the mandate is for, the mandate it continues, the team's part, the members of the grant. Reads only.
   * `dry`: an approver outside the team's verified list is not a refusal here (the caller lists it).
   */
  private async planGrant(i: IssueInput, s: Session, dk: Awaited<ReturnType<typeof deviceKeys>>, dry: boolean) {
    const { d } = this;
    // 1. who the mandate is for: the signed-in person, and nobody else
    if (i.ownDid !== s.stored.rootDid) throw new GrantRefusal('wrong_identity', 'The signed-in person is not the owner of this device chain.');

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
        throw new GrantRefusal('mandate_mismatch', 'The mandate to change was already replaced by another.');
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
    // Who counts as a colleague is the team's member list, signed by the admin's device and verified here (DEC-73). No code is asked at
    // grant time and nothing is remembered per computer. Without a verified list no colleague is named.
    const verified = team.identities.some(a => a.did !== s.stored.rootDid) ? await this.honouredTeam(s) : null;
    const listed = new Map<string, string>((verified?.members ?? []).map(m => [m.did, m.name] as [string, string]));
    const notListed = team.identities.filter(a => a.did !== s.stored.rootDid && !listed.has(a.did));
    const listCode = verified ? 'approver_not_in_team_list' : 'team_list_unavailable';
    if (notListed.length > 0 && !dry) {
      throw new GrantRefusal(
        listCode,
        verified ? 'An approver is not in your team\'s member list.' : 'Your team\'s member list could not be checked.',
        { approvers: notListed.map(a => ({ userId: a.userId, did: a.did, identityCode: a.identityCode })), ...(verified ? {} : { warning: this.teamTrustWarning() }) },
      );
    }
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
        if (dk.jcs({ x: members[k] }) !== dk.jcs({ x: prevGrant[k] ?? null })) throw new GrantRefusal('renewal_is_a_change', `Extending only moves the end date; "${k}" differs from what was granted, so this is a change.`, { member: k });
      }
    }

    return { mandateId, version, op, replaces, authorizationId, team, members, expiresAt, now, carries, notListed, listCode, listed, payload };
  }

  /**
   * Prepare, sign and store the grant for this mandate and store its sealed body. Returns what the ceremony adds
   * to its own request to the Authority Server. Throws {@link GrantRefusal}.
   */
  async issue(i: IssueInput, opts: { onTouched?: () => void } = {}): Promise<Issued> {
    const { d } = this;
    const dk = await deviceKeys();
    const s = await this.session();
    if (!d.checks || !d.checkStore) return refuse('no_check_key', 'This computer has no check key, so it cannot grant a mandate.');

    const plan = await this.planGrant(i, s, dk, false);
    const { mandateId, version, op, team, members, expiresAt, now, carries, replaces } = plan;

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
    // The touch is given: from here the page shows the work, not the wait for the touch (never a silent wait).
    try { opts.onTouched?.(); } catch { /* a progress signal never fails the grant */ }
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

    // 8. what the ceremony adds to its request (a renewal names `replaces` as the grant before it did: the AS checks the grant against it)
    const request = this.requestOf(i, { mandateId, version, expiresAt, team, carries, replaces });
    return { mandateId, mandateVersion: version, expiresAt, request, approvers: team.identities };
  }

  /** What the ceremony adds to its mandate request for a planned give (step 8 of `issue`). */
  private requestOf(i: IssueInput, plan: { mandateId: string; version: number; expiresAt: number; team: { mode: string; caps?: unknown; approvers?: unknown; approvals?: number }; carries: boolean; replaces: string | null }): Record<string, unknown> {
    const { team } = plan;
    return {
      mandate_id: plan.mandateId, mandate_version: plan.version, expires_at: plan.expiresAt, commitment_mode: team.mode,
      mandate_owners: [{ did: i.ownDid }],
      ...(plan.carries ? { above_cap_caps: team.caps, above_cap_approvers: team.approvers, ...(team.approvals !== undefined ? { above_cap_approvals: team.approvals } : {}) } : {}),
      ...(i.renewal ? { renew: true, ...(plan.replaces ? { replaces: plan.replaces } : {}) } : {}),
    };
  }

  // ─── give on the phone (plan 4.4 "Transport", DEC-86) ─────────────────────

  /**
   * Prepare a give for another granting device of this person (their phone) instead of granting here: the same plan as `issue`, then the
   * whole request sealed to every ACTIVE device of the chain this gateway verified and stored at `POST /api/mandates/prepared`. Nothing is
   * signed here and nothing is requested from the Authority Server yet. The phone shows the request, computes every hash it signs from the
   * plaintext it shows, and stores the grant; `phoneGrant` then accepts only a grant whose members are EXACTLY the ones planned here.
   *
   * The sealed request (`v: 2`) is a superset of a body (`v: 1`: scope and intent), so the row stays the mandate's body after the grant.
   */
  /**
   * `previous`: for a change, the version it continues, in plaintext (limits, scope, intent, end, profile). The phone shows the crossed-out
   * diff from it and checks it first against the previous grant's hashes, so a wrong value here only gets the give refused there.
   */
  async sendToPhone(i: IssueInput, shown: { title: string; previous?: PhonePrevious }): Promise<PhoneGive> {
    const dk = await deviceKeys();
    const s = await this.session();
    const plan = await this.planGrant(i, s, dk, false);
    // Some OTHER active device of this chain must be able to grant (its check key named in the chain): otherwise nobody can.
    const granters = dk.activeDevices(s.own).filter(x => x.key_id !== s.stored.keyId && !!x.check);
    if (granters.length === 0) return refuse('no_granting_phone', 'None of your other devices can give a mandate.');
    if (plan.op === 'change' && !i.renewal && !shown.previous) return refuse('previous_unknown', 'The mandate this change continues could not be read on this computer.');
    const place = { authorization_id: plan.authorizationId, group_id: i.groupId, replaces: plan.replaces, chain_dids: [...plan.team.chainDids] };
    const give = {
      op: plan.op, profile: i.profile, bounds: i.bounds, payload: plan.payload, place, title: shown.title.slice(0, 200),
      prepared_at: plan.now, ...(i.renewal ? { renewal: true } : {}),
      ...(plan.op === 'change' && shown.previous ? { previous: { ...shown.previous, mandate_version: plan.version - 1 } } : {}),
    };
    const readers = dk.activeDevices(s.own).map(x => ({ did: x.key_id, publicKey: dk.b64uDecode(x.read_pub) }));
    const sealed = await encryptProposalContent({ v: 2, mandate_id: plan.mandateId, mandate_version: plan.version, scope: i.scope, intent: i.intent, give }, readers);
    const reply = await this.call('POST', '/api/mandates/prepared', s.credential, {
      mandate_id: plan.mandateId, mandate_version: plan.version, ciphertext: sealed.content.ciphertext, device_keys: sealed.content.encrypted_keys,
    });
    if (reply.status !== 201) return refuse(asErrorCode(reply.body) ?? 'body_refused', asMessage(reply.body) || 'The Authority Server did not take the prepared mandate.');
    return {
      mandateId: plan.mandateId, mandateVersion: plan.version, expiresAt: plan.expiresAt, op: plan.op, members: plan.members,
      request: this.requestOf(i, plan), approvers: plan.team.identities,
    };
  }

  /**
   * Has the phone given the mandate `sendToPhone` prepared? `null` while no grant of that version is stored. A grant is accepted only when
   * it verifies against THIS gateway's own verified chain (a granting device's signature and its check over exactly that grant) with every
   * member equal to the members planned here; anything else is refused and never used.
   */
  async phoneGrant(p: PhoneGive): Promise<Issued | null> {
    const { d } = this;
    const dk = await deviceKeys();
    const s = await this.session();
    const g = await this.call('GET', `/api/mandates/${encodeURIComponent(p.mandateId)}/grants`, s.credential);
    if (g.status === 404) return null;
    if (g.status !== 200 || !isObj(g.body) || !Array.isArray(g.body.grants)) return refuse('as_answer_invalid', 'The Authority Server answered with something unexpected.');
    const rows = (g.body.grants as unknown[]).filter((e): e is Record<string, unknown> => isObj(e) && isObj(e.grant) && e.mandate_version === p.mandateVersion);
    if (rows.some(r => r.op === 'revoke')) return refuse('mandate_revoked', 'This mandate was ended.');
    const row = rows.find(r => r.op === p.op);
    if (!row) return null;
    const grant = row.grant as MandateGrant;
    if (grant.owner_did !== s.stored.rootDid) return refuse('grant_invalid', 'The grant is not this person\'s.');
    try {
      await dk.verifyGrant({ grant, sig: row.sig, check: row.check ?? undefined }, {
        chain: s.own, mandateFields: p.members, expect: { ops: [p.op], mandate_id: p.mandateId, mandate_version: p.mandateVersion },
      });
    } catch (e) {
      if (isDeviceKeysError(e)) return refuse('grant_invalid', `The grant from your phone does not match what was prepared (${e.code}).`);
      throw e;
    }
    const hash = await dk.grantHash(grant);
    try { d.grants.observe(p.mandateId, p.mandateVersion, hash, p.op); } catch { return refuse('grant_not_recorded', 'This computer could not record the grant.'); }
    return { mandateId: p.mandateId, mandateVersion: p.mandateVersion, expiresAt: p.expiresAt, request: p.request, approvers: p.approvers };
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

  /** Pins that are never dropped when the table is full: this person's own chain and every member of the team's verified list. */
  protectedDids(): string[] {
    let own: string[] = [];
    try { const r = this.d.store.read()?.rootDid; if (r) own = [r]; } catch { /* locked */ }
    try { return [...own, ...(this.d.teamTrust.verified()?.members.map(m => m.did) ?? [])]; } catch { return own; }
  }

  // ─── who is a colleague: the team's signed member list (DEC-73, design 20.21.6) ───

  private moveAdvance(did: string, head: ChainState['head']): void {
    try { this.d.pins.advance(did, head, this.protectedDids()); } catch (e) {
      const reason = (e as { reason?: string })?.reason;
      if (reason === 'rollback') return refuse('chain_rollback', 'A device chain is shorter than the one verified before.');
      if (reason === 'fork') return refuse('chain_fork', 'A device chain differs from the one verified before.');
      throw e;
    }
  }

  private teamEnv(s: Session): TeamTrustEnv {
    return {
      store: this.d.teamTrust,
      ownDid: s.stored.rootDid,
      own: s.own,
      get: (path) => this.call('GET', path, s.credential),
      chain: async (did) => {
        const state = await this.chainOf(did, s.credential, this.d.pins.get(did));
        this.moveAdvance(did, state.head);
        return state;
      },
      now: this.now,
    };
  }

  private teamInflight: Promise<VerifiedTeam | null> | null = null;

  /**
   * The verified team this gateway honours now. A verification younger than 5 minutes is used as it is; otherwise the list is fetched and
   * verified (one run at a time). A fetch that fails leaves the last verified state in force for 15 minutes; a blocking warning leaves nothing.
   * Never throws: no list means no colleague.
   */
  private async honouredTeam(s?: Session): Promise<VerifiedTeam | null> {
    const { teamTrust: store } = this.d;
    if (teamTrustFresh(store, this.now())) return honouredTeam(store, this.now());
    if (this.teamInflight) return this.teamInflight;
    const run = (async () => {
      let sess = s;
      try { sess ??= await this.session(); } catch { return honouredTeam(store, this.now()); }
      return ensureTeamTrust(this.teamEnv(sess));
    })();
    this.teamInflight = run;
    try { return await run; } finally { this.teamInflight = null; }
  }

  /** The port the join screens take as `teamTrust`. */
  teamTrustPort(): TeamTrustPort {
    return {
      head: async (teamId, session) => {
        const store = this.d.teamTrust;
        const v = await ensureTeamTrust(this.teamEnv(session));
        let cur: string | null;
        try { cur = store.currentTeam(); } catch { throw new TeamTrustUnavailable('stale'); }
        if (v && cur === teamId) {
          if (!v.head) throw new TeamTrustUnavailable('stale');
          return { list: v.head, hash: v.hash };
        }
        const w = this.teamTrustWarning();
        if (w) throw new TeamTrustUnavailable(w.code);
        if (cur !== teamId) return null;
        let had: unknown = null;
        try { had = store.verified(); } catch { /* locked */ }
        if (had) throw new TeamTrustUnavailable('stale');
        return null;
      },
    };
  }

  /** The verified member DIDs (admin included, leavers out), brought up to date when older than 5 minutes; null when nothing is honoured. */
  async teamMembers(): Promise<ReadonlySet<string> | null> {
    const v = await this.honouredTeam();
    return v ? new Set(v.members.map(m => m.did)) : null;
  }

  /** The reason no colleague is honoured, if there is one (a code for the page). */
  teamTrustWarning(): { code: TeamTrustCode; at: number; version?: number } | null {
    try { const w = this.d.teamTrust.warning(); return w ? { code: w.code, at: w.at, ...(w.version !== undefined ? { version: w.version } : {}) } : null; } catch { return null; }
  }

  /**
   * What the page shows about the team: the verified member list (names as the admin signed them), or why there is none.
   * `refresh`: fetch and verify now instead of using a verification younger than 5 minutes.
   * state: 'none' (this person is in no team, or the list was never fetched), 'verified', 'warning' (a code; nothing of a colleague is honoured
   * when the code is a blocking one, see `blocking`).
   */
  async teamTrustStatus(refresh = false): Promise<{ state: 'none' | 'verified' | 'warning'; code?: TeamTrustCode; blocking?: boolean; teamId?: string; adminDid?: string; version?: number; members?: Array<{ did: string; name: string }> }> {
    const { teamTrust: store } = this.d;
    if (refresh) { try { await refreshTeamTrust(this.teamEnv(await this.session())); } catch { /* shown as the state below */ } }
    else await this.honouredTeam();
    let w: ReturnType<TeamTrustStore['warning']> = null;
    let v: VerifiedTeam | null = null;
    let teamId: string | null = null;
    try { w = store.warning(); v = honouredTeam(store, this.now()); teamId = store.currentTeam(); } catch { /* locked */ }
    if (w) return { state: 'warning', code: w.code, blocking: v === null, ...(teamId ? { teamId } : {}) };
    if (!v || !teamId) return { state: 'none' };
    return { state: 'verified', teamId, adminDid: v.adminDid, version: v.version, members: v.members.map(m => ({ did: m.did, name: m.name })) };
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

  /** The person withdraws a confirmation of someone's identity. (Legacy slot: no longer what makes a colleague, see {@link ownerKnown}.) */
  forgetIdentity(did: unknown): void {
    if (typeof did !== 'string' || !DID.test(did)) throw new GrantRefusal('bad_request', 'Bad request.');
    this.d.grants.forgetApprover(did);
  }

  // ─── what the MCP server asks to have remembered: only what this control plane verified itself ───

  /**
   * Is this DID this person's own, or a member of the team's VERIFIED member list (DEC-73)? Reads what was verified last (no fetch):
   * nothing without a verified list, nothing after a blocking warning, nothing once the last verification is older than 15 minutes.
   * The per-computer confirmation (`approverConfirmed`) is not consulted: it is legacy and ignored for team DIDs.
   */
  ownerKnown(did: string): boolean {
    if (typeof did !== 'string' || !DID.test(did)) return false;
    try { if (this.d.store.read()?.rootDid === did) return true; } catch { return false; }
    return honouredTeam(this.d.teamTrust, this.now())?.members.some(m => m.did === did) === true;
  }

  /** {@link ownerKnown} after the list was brought up to date when it is older than 5 minutes (what the MCP server asks). */
  async ownerKnownFresh(did: string): Promise<boolean> {
    if (typeof did !== 'string' || !DID.test(did)) return false;
    try { if (this.d.store.read()?.rootDid === did) return true; } catch { return false; }
    // A locked gateway cannot say (the MCP server keeps what it honoured); it is not the same as "no".
    if (!this.d.vault.isUnlocked()) throw new GrantRefusal('locked', 'The gateway is locked.');
    await this.honouredTeam();
    return this.ownerKnown(did);
  }

  /**
   * The person compared the identity code of `did` with the one on the other person's own screen. LEGACY (DEC-73): the answer is remembered
   * in the per-computer slot, which no longer makes anyone a colleague; the later optional self-comparison writes a person-signed
   * statement instead, so that it holds on every device. The route stays so that an older page does not break.
   */
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
    if (ownerDid !== s.stored.rootDid) await this.honouredTeam(s);
    if (!this.ownerKnown(ownerDid)) return refuse('owner_unknown', 'The owner of this mandate is not this person and is not in the verified member list of their team.');
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
    // v1: the body. v2: a give prepared for the phone (`sendToPhone`), which stays the body after the grant: the same members plus `give`.
    const shape = isObj(content) ? Object.keys(content).sort().join() : '';
    const v1 = shape === 'intent,mandate_id,mandate_version,scope,v' && isObj(content) && content.v === 1;
    const v2 = shape === 'give,intent,mandate_id,mandate_version,scope,v' && isObj(content) && content.v === 2 && isObj(content.give);
    if (!isObj(content) || !(v1 || v2) || content.mandate_id !== input.mandateId || content.mandate_version !== input.version) {
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
