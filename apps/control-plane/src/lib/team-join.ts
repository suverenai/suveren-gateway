/**
 * The join of a new member to a team, on this computer (DEC-73, design 20.21.5; build step 4): the member's part (compare
 * the admin's identity code, sign the anchor "I trust this admin for this team") and the admin's part (compare the member's
 * identity code, see the member's anchor, sign member list version n+1).
 *
 * What the screens may rely on, all enforced HERE and not by the page:
 *   - each side shows only its OWN code, computed from the DID in the vault or the chain, never one the Authority Server names;
 *   - the other person's code is typed on the screen and compared HERE with `identityCode(did)` of the DID the Authority Server
 *     named. Three wrong codes close that join on this side (`tries_used`); a right code is remembered in memory (a restart
 *     asks again) for 30 minutes and only for that team and that DID;
 *   - nothing is signed before its comparison matched: the member's anchor needs the admin's code to have matched, the admin's
 *     list needs the member's code to have matched AND the member's anchor to verify against the member's own chain (hap-core
 *     `verifyAnchor`, naming this team and this admin). The Authority Server enforces only what it can see;
 *   - the touch (the check of this computer) is the step: the helper builds the prompt from the object that is signed
 *     (lib/platform-checks.ts, packages/unlock-helper/DESIGN.md 3.3), so the page cannot say what the touch is for.
 *
 * Step 3 (team trust: pins, the verified head list) is another work stream. This file needs one thing from it, the verified head
 * list, as {@link TeamTrustPort}; the default here reads the head from the Authority Server and verifies it as the list THIS
 * admin signed (hap-core `verifyMemberList`, `first: true`). A step 3 implementation replaces it without touching the screens.
 *
 * Codes only in refusals, never a signature, nonce, key or name in a log. Wording is the maintainer's (see the page's texts).
 */

import { randomBytes } from 'node:crypto';
import type { ChainState, MemberList, TeamAnchor, TeamMember } from '@hap/core/device-keys';
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import type { Vault } from './vault';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import type { DeviceChainStore } from './device-chain-store';
import { asErrorCode } from './device-as-client';
import { loadDeviceSigningKey } from './e2e-key-manager';
import { GrantRefusal, type MandateGrants, type Session } from './mandate-grants';
import { CheckError, type CheckKeyStore, type PlatformChecks } from './platform-checks';

export const MAX_TRIES = 3;
/** A matched comparison stays good this long (epoch ms), then the code is asked again. */
export const MATCH_TTL_MS = 30 * 60_000;

const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const digitsOf = (s: string): string => s.replace(/\D/g, '');

/** A refusal with a neutral code (the page maps it to its words). `status` is the HTTP status the route answers. */
export class JoinRefusal extends Error {
  constructor(readonly code: string, readonly status = 422, readonly extra: Record<string, unknown> = {}) {
    super(code);
    this.name = 'JoinRefusal';
  }
}

const refuse = (code: string, status = 422, extra?: Record<string, unknown>): never => { throw new JoinRefusal(code, status, extra); };

/**
 * The tries and the matches of one side of a join. Pure (a clock in, nothing else), kept apart from the network code so a test
 * can run every rule: 3 tries, then locked; a match is for one (team, DID) only and runs out.
 */
export class CodeGate {
  private readonly tries = new Map<string, number>();
  private readonly matches = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now(), private readonly max = MAX_TRIES, private readonly ttlMs = MATCH_TTL_MS) {}

  /** `key` names the side, the team and the other person's DID: a match for one DID never counts for another. */
  attempt(key: string, expectedCode: string, typed: string): { match: true } | { match: false; triesLeft: number } {
    const used = this.tries.get(key) ?? 0;
    if (used >= this.max) return refuse('tries_used', 423, { triesLeft: 0 });
    const t = digitsOf(typed);
    if (t.length > 0 && t === digitsOf(expectedCode)) {
      this.tries.delete(key);
      this.matches.set(key, this.now() + this.ttlMs);
      return { match: true };
    }
    this.tries.set(key, used + 1);
    return { match: false, triesLeft: this.max - used - 1 };
  }

  matched(key: string): boolean {
    const until = this.matches.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) { this.matches.delete(key); return false; }
    return true;
  }

  triesLeft(key: string): number {
    return Math.max(0, this.max - (this.tries.get(key) ?? 0));
  }

  /** The join ended (withdrawn, done, the other person changed): start over. */
  forget(key: string): void {
    this.tries.delete(key);
    this.matches.delete(key);
  }
}

/**
 * What the join needs from the team-trust work (step 3): the newest member list this gateway has VERIFIED for the team.
 * `null` is a team with no list (no device-keys team); a thrown refusal is "cannot say": nothing is signed.
 */
export interface TeamTrustPort {
  head(teamId: string, s: Session): Promise<{ list: MemberList; hash: string } | null>;
}

export interface TeamJoinDeps {
  vault: Vault;
  store: DeviceChainStore;
  grants: MandateGrants;
  checks?: PlatformChecks;
  checkStore?: CheckKeyStore;
  /** Step 3's verified head list. Unset: the default of this file (see the file comment). */
  trust?: TeamTrustPort;
  /** Epoch seconds. */
  now?: () => number;
  /** Epoch ms, for the gate. */
  nowMs?: () => number;
}

export interface MemberView {
  yourCode: string;
  triesLeft: number;
  /** This side compared the admin's code (in memory; lost on a restart). */
  compared: boolean;
  /** This person's anchor for the team is stored at the Authority Server: they are waiting for the admin. */
  anchored: boolean;
}

export interface AdminRequest {
  userId: string;
  /** The name from the sign-up: NOT checked, the screen says so. */
  memberName: string;
  /** The request carries a root DID (a chain account). Without one this screen cannot join the person. */
  hasDid: boolean;
  triesLeft: number;
  compared: boolean;
  /** The member's anchor: none yet, valid against the member's own chain naming this team and this admin, or not valid. */
  anchor: 'none' | 'ok' | 'invalid';
}

export interface AdminView {
  yourCode: string;
  requests: AdminRequest[];
}

export class TeamJoin {
  private readonly now: () => number;
  private readonly memberGate: CodeGate;
  private readonly adminGate: CodeGate;

  constructor(private readonly d: TeamJoinDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.memberGate = new CodeGate(d.nowMs);
    this.adminGate = new CodeGate(d.nowMs);
  }

  /** Does this gateway have a device chain? Both parts exist only then. */
  active(): boolean {
    return this.d.store.exists();
  }

  // ─── shared ──────────────────────────────────────────────────────────────

  private async session(): Promise<Session> {
    try { return await this.d.grants.approvalSession(); } catch (e) { throw asJoinRefusal(e); }
  }

  private async call(s: Session, method: string, path: string, body?: unknown) {
    try { return await this.d.grants.asCall(s, method, path, body); } catch (e) { throw asJoinRefusal(e); }
  }

  private teamId(v: unknown): string {
    if (typeof v !== 'string' || !TEAM_ID.test(v)) return refuse('bad_request', 400);
    return v;
  }

  private userId(v: unknown): string {
    if (typeof v !== 'string' || !USER_ID.test(v)) return refuse('bad_request', 400);
    return v;
  }

  /** Sign `object` with this computer's device key and its check: one touch. `focus` picks the member a list's prompt names. */
  private async signWithCheck(s: Session, object: object, focus?: string): Promise<{ sig: string; check: { signature: string } }> {
    const { d } = this;
    const dk = await deviceKeys();
    if (!d.checks || !d.checkStore) return refuse('no_check_key');
    let checkKey;
    try { checkKey = d.checkStore.read(); } catch { return refuse('check_key_unreadable'); }
    const device = s.own.devices[s.stored.keyId];
    if (!checkKey || !device?.check || !dk.checkKeysEqual(device.check, platformCheckKey(checkKey.publicKey))) return refuse('no_check_key');
    const signing = loadDeviceSigningKey(d.vault);
    if (!signing || (await dk.keyIdOf(signing.publicKey)) !== s.stored.keyId) return refuse('key_mismatch');
    const sig = await dk.signObject(object, signing.privateSeed);
    try {
      const check = await d.checks.sign(checkKey, dk.signedBytes(object), focus);
      return { sig, check: platformCheckProof(check.signature) };
    } catch (e) {
      if (e instanceof CheckError) return refuse('check_failed', 422, { reason: e.helperCode ?? e.code });
      throw e;
    }
  }

  // ─── the member's part ───────────────────────────────────────────────────

  /** The admin's root DID as the Authority Server names it for this team (a requester may read it). */
  private async adminDidFor(s: Session, teamId: string): Promise<string> {
    const r = await this.call(s, 'GET', `/api/teams/${encodeURIComponent(teamId)}/trust`);
    if (r.status === 404) return refuse('team_unknown', 404);
    if (r.status !== 200 || !isObj(r.body)) return refuse('as_answer_invalid', 502);
    const did = r.body.admin_did;
    if (typeof did !== 'string' || !did.startsWith('did:key:')) return refuse('admin_unknown', 409);
    return did;
  }

  private memberKey(teamId: string, adminDid: string): string { return `m:${teamId}:${adminDid}`; }

  private async ownAnchorOf(s: Session, teamId: string): Promise<{ anchor: TeamAnchor; hash: string } | null> {
    const r = await this.call(s, 'GET', `/api/teams/${encodeURIComponent(teamId)}/anchor`);
    if (r.status !== 200 || !isObj(r.body)) return refuse('as_answer_invalid', 502);
    const a = r.body.anchor;
    if (a === null || a === undefined) return null;
    if (!isObj(a) || !isObj(a.anchor) || typeof a.hash !== 'string') return refuse('as_answer_invalid', 502);
    return { anchor: a.anchor as unknown as TeamAnchor, hash: a.hash };
  }

  /** Step 1 of the member's column: the member's own code and where this side stands. */
  async memberView(teamIdIn: unknown): Promise<MemberView> {
    const teamId = this.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.session();
    const adminDid = await this.adminDidFor(s, teamId);
    const key = this.memberKey(teamId, adminDid);
    const mine = await this.ownAnchorOf(s, teamId);
    return {
      yourCode: await dk.identityCode(s.stored.rootDid),
      triesLeft: this.memberGate.triesLeft(key),
      compared: this.memberGate.matched(key),
      anchored: !!mine && mine.anchor.admin_did === adminDid,
    };
  }

  /** Step 2: the typed code against `identityCode(admin_did)` of the DID the Authority Server names. */
  async memberCheck(teamIdIn: unknown, typed: unknown): Promise<{ match: true } | { match: false; triesLeft: number }> {
    const teamId = this.teamId(teamIdIn);
    if (typeof typed !== 'string' || typed.length > 64) return refuse('bad_request', 400);
    const dk = await deviceKeys();
    const s = await this.session();
    const adminDid = await this.adminDidFor(s, teamId);
    return this.memberGate.attempt(this.memberKey(teamId, adminDid), await dk.identityCode(adminDid), typed);
  }

  /** Step 3: the touch signs the anchor. Refused until the admin's code matched. */
  async memberAnchor(teamIdIn: unknown): Promise<{ stored: true }> {
    const teamId = this.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.session();
    const adminDid = await this.adminDidFor(s, teamId);
    const key = this.memberKey(teamId, adminDid);
    if (!this.memberGate.matched(key)) return refuse('not_compared', 409);
    const prev = await this.ownAnchorOf(s, teamId);
    if (prev && prev.anchor.admin_did === adminDid) return { stored: true };   // already said; nothing new to sign
    const anchor = dk.buildAnchor({
      member_did: s.stored.rootDid, team_id: teamId, admin_did: adminDid,
      version: prev ? prev.anchor.version + 1 : 1, prev: prev ? prev.hash : null,
      key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash,
      created_at: this.now(), nonce: dk.b64uEncode(randomBytes(16)),
    });
    const { sig, check } = await this.signWithCheck(s, anchor);
    const body = { anchor, sig, check };
    let r = await this.call(s, 'POST', `/api/teams/${encodeURIComponent(teamId)}/anchor`, body);
    if (r.status === 409 && asErrorCode(r.body) === 'CHAIN_HEAD_MOVED') r = await this.call(s, 'POST', `/api/teams/${encodeURIComponent(teamId)}/anchor`, body);
    if (r.status !== 200 && r.status !== 201) return refuse(asErrorCode(r.body) ?? 'anchor_refused', r.status === 409 ? 409 : 422);
    return { stored: true };
  }

  /** The member's side is over (withdrawn, joined): the next join starts with three tries again. */
  memberForget(teamIdIn: unknown, adminDid: string): void {
    this.memberGate.forget(this.memberKey(this.teamId(teamIdIn), adminDid));
  }

  // ─── the admin's part ────────────────────────────────────────────────────

  private adminKey(teamId: string, userId: string, memberDid: string): string { return `a:${teamId}:${userId}:${memberDid}`; }

  private async requestsOf(s: Session, teamId: string): Promise<Array<{ userId: string; memberDid: string | null; memberName: string }>> {
    const r = await this.call(s, 'GET', `/api/groups/${encodeURIComponent(teamId)}/requests`);
    if (r.status === 403) return refuse('not_admin', 403);
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.requests)) return refuse('as_answer_invalid', 502);
    const out: Array<{ userId: string; memberDid: string | null; memberName: string }> = [];
    for (const q of r.body.requests) {
      if (!isObj(q) || typeof q.userId !== 'string') continue;
      const did = typeof q.memberDid === 'string' && q.memberDid.startsWith('did:key:') ? q.memberDid : null;
      const name = typeof q.memberName === 'string' && q.memberName ? q.memberName : typeof q.name === 'string' ? q.name : q.userId;
      out.push({ userId: q.userId, memberDid: did, memberName: name });
    }
    return out;
  }

  /** The member's anchor as the Authority Server carries it, verified here against the member's own chain. */
  private async anchorState(s: Session, teamId: string, userId: string, memberDid: string): Promise<'none' | 'ok' | 'invalid'> {
    const dk = await deviceKeys();
    const r = await this.call(s, 'GET', `/api/teams/${encodeURIComponent(teamId)}/anchors/${encodeURIComponent(userId)}`);
    if (r.status !== 200 || !isObj(r.body)) return refuse('as_answer_invalid', 502);
    if (r.body.member_did !== memberDid) return 'invalid';
    const a = r.body.anchor;
    if (a === null || a === undefined) return 'none';
    if (!isObj(a)) return 'invalid';
    let chain: ChainState;
    try { chain = await this.d.grants.verifiedChainOf(memberDid, s); } catch (e) {
      if (e instanceof GrantRefusal && e.code === 'chain_unknown') return 'invalid';
      throw asJoinRefusal(e);
    }
    try {
      await dk.verifyAnchor({ anchor: a.anchor, sig: a.sig, check: a.check ?? undefined }, { chain, expect: { team_id: teamId, admin_did: s.stored.rootDid } });
      return 'ok';
    } catch (e) {
      if (isDeviceKeysError(e)) return 'invalid';
      throw e;
    }
  }

  /** Step 1 of the admin's column: the admin's own code and every request with where it stands. */
  async adminView(teamIdIn: unknown): Promise<AdminView> {
    const teamId = this.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.session();
    const requests: AdminRequest[] = [];
    for (const q of await this.requestsOf(s, teamId)) {
      if (!q.memberDid) { requests.push({ userId: q.userId, memberName: q.memberName, hasDid: false, triesLeft: 0, compared: false, anchor: 'none' }); continue; }
      const key = this.adminKey(teamId, q.userId, q.memberDid);
      requests.push({
        userId: q.userId, memberName: q.memberName, hasDid: true,
        triesLeft: this.adminGate.triesLeft(key), compared: this.adminGate.matched(key),
        anchor: await this.anchorState(s, teamId, q.userId, q.memberDid),
      });
    }
    return { yourCode: await dk.identityCode(s.stored.rootDid), requests };
  }

  private async requestFor(s: Session, teamId: string, userId: string): Promise<{ memberDid: string; memberName: string }> {
    const q = (await this.requestsOf(s, teamId)).find(x => x.userId === userId);
    if (!q) return refuse('no_join_request', 404);
    if (!q.memberDid) return refuse('member_has_no_chain', 409);
    return { memberDid: q.memberDid, memberName: q.memberName };
  }

  /** Step 2: the typed code against `identityCode(member_did)` of the DID in the request. */
  async adminCheck(teamIdIn: unknown, userIdIn: unknown, typed: unknown): Promise<{ match: true } | { match: false; triesLeft: number }> {
    const teamId = this.teamId(teamIdIn);
    const userId = this.userId(userIdIn);
    if (typeof typed !== 'string' || typed.length > 64) return refuse('bad_request', 400);
    const dk = await deviceKeys();
    const s = await this.session();
    const q = await this.requestFor(s, teamId, userId);
    return this.adminGate.attempt(this.adminKey(teamId, userId, q.memberDid), await dk.identityCode(q.memberDid), typed);
  }

  /** The newest verified list: step 3's port, or the default of this file. */
  private async headList(s: Session, teamId: string): Promise<{ list: MemberList; hash: string }> {
    const head = this.d.trust ? await this.d.trust.head(teamId, s) : await this.fetchedHead(s, teamId);
    if (!head) return refuse('no_member_list', 409);
    return head;
  }

  private async fetchedHead(s: Session, teamId: string): Promise<{ list: MemberList; hash: string } | null> {
    const dk = await deviceKeys();
    const base = `/api/teams/${encodeURIComponent(teamId)}/trust`;
    const first = await this.call(s, 'GET', base);
    if (first.status !== 200 || !isObj(first.body)) return refuse('as_answer_invalid', 502);
    const h = first.body.head;
    if (h === null || h === undefined) return null;
    if (!isObj(h) || !Number.isSafeInteger(h.version) || typeof h.hash !== 'string') return refuse('as_answer_invalid', 502);
    const r = await this.call(s, 'GET', `${base}?from=${h.version as number}`);
    const lists = r.status === 200 && isObj(r.body) && Array.isArray(r.body.lists) ? r.body.lists : null;
    const top = lists?.[lists.length - 1];
    if (!isObj(top) || top.version !== h.version || top.hash !== h.hash) return refuse('as_answer_invalid', 502);
    try {
      const list = await dk.verifyMemberList({ list: top.list, sigs: top.sigs }, { chain: s.own, first: true });
      if ((await dk.memberListHash(list)) !== h.hash) return refuse('as_answer_invalid', 502);
      return { list, hash: h.hash };
    } catch (e) {
      if (isDeviceKeysError(e)) return refuse('trust_invalid', 422, { reason: e.code });
      throw e;
    }
  }

  /** Step 5: the touch signs list version n+1. Refused until the code matched and the member's anchor verifies. */
  async adminAdd(teamIdIn: unknown, userIdIn: unknown): Promise<{ version: number }> {
    const teamId = this.teamId(teamIdIn);
    const userId = this.userId(userIdIn);
    const dk = await deviceKeys();
    const s = await this.session();
    const q = await this.requestFor(s, teamId, userId);
    if (!this.adminGate.matched(this.adminKey(teamId, userId, q.memberDid))) return refuse('not_compared', 409);
    if ((await this.anchorState(s, teamId, userId, q.memberDid)) !== 'ok') return refuse('anchor_required', 409);
    const prev = await this.headList(s, teamId);
    if (prev.list.admin_did !== s.stored.rootDid) return refuse('not_admin', 403);
    if (prev.list.members.some(m => m.did === q.memberDid)) return refuse('already_member', 409);
    const name = Array.from(q.memberName.replace(/[\u0000-\u001f\u007f-\u009f  ]/g, ' ').trim()).slice(0, dk.TEAM_MAX_NAME).join('') || userId;
    let added: TeamMember;
    try { added = await dk.buildTeamMember(q.memberDid, name); } catch { return refuse('list_invalid'); }
    const members = [...prev.list.members, added].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
    const list = dk.buildMemberList({
      team_id: teamId, version: prev.list.version + 1, prev: prev.hash, admin_did: s.stored.rootDid, members, handover: null,
      key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash,
      created_at: this.now(), nonce: dk.b64uEncode(randomBytes(16)),
    });
    try { dk.validateMemberList(list); } catch { return refuse('list_invalid'); }
    const { sig, check } = await this.signWithCheck(s, list, q.memberDid);
    const body = { list, sigs: [{ key_id: s.stored.keyId, sig, check }], request_user_id: userId };
    let r = await this.call(s, 'POST', `/api/teams/${encodeURIComponent(teamId)}/members`, body);
    if (r.status === 409 && asErrorCode(r.body) === 'CHAIN_HEAD_MOVED') r = await this.call(s, 'POST', `/api/teams/${encodeURIComponent(teamId)}/members`, body);
    if (r.status !== 201 && r.status !== 200) return refuse(asErrorCode(r.body) ?? 'list_refused', r.status === 409 ? 409 : 422);
    this.adminGate.forget(this.adminKey(teamId, userId, q.memberDid));
    return { version: list.version };
  }
}

/** The refusals of the shared grant code become this file's, so the route answers one shape. */
function asJoinRefusal(e: unknown): JoinRefusal | unknown {
  if (e instanceof JoinRefusal) return e;
  if (e instanceof GrantRefusal) {
    const status = e.code === 'locked' || e.code === 'not_signed_in' ? 401 : e.code === 'as_unreachable' || e.code === 'as_tls_mismatch' ? 502 : 422;
    return new JoinRefusal(e.code, status);
  }
  return e;
}
