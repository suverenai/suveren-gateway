/**
 * Changes of a team's member list after the join, on this computer (DEC-73 step 5, design 20.21.3 re-sign rule, 20.21.5 "Change of
 * admin" and "A new identity", 20.21.8). Builds on step 3's verifier (the verified head comes from {@link TeamTrustPort}) and step 4's
 * join (compare codes, anchor, signing with the touch): this file only adds what changes in a list that already exists.
 *
 *   admin:   remove someone (they left, were removed) · replace someone who took a new identity (a new join: codes compared again, a new
 *            anchor) · sign the same members again when the device that signed the list is gone (re-sign) · hand over (3 steps).
 *   member:  see that the admin changed (compare the new admin's code and anchor again: step 4's member screen does it). A take-over
 *            when the admin took a new identity is deferred (DEC-82).
 *
 * The Authority Server only POINTS (`GET /api/teams/:id/offers`). Everything that is signed is built from the list THIS gateway verified
 * (or, for a take-over after the admin's chain is gone, from the list this gateway's own pin names, by hash) and from the person's own
 * chain. Nothing is signed before the touch; the helper builds the touch prompt from the object and the list before it (`previous`), so
 * the page and the AI cannot say what the touch is for. Codes only in refusals.
 */
import { randomBytes } from 'node:crypto';
import type { MemberList, TeamMember } from '@hap/core/device-keys';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import { asErrorCode } from './device-as-client';
import { GrantRefusal, type Session, TeamTrustUnavailable } from './mandate-grants';
import { JoinRefusal, type TeamJoin } from './team-join';
import type { TeamTrustStore } from './team-trust-store';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,128}$/;
const refuse = (code: string, status = 422, extra?: Record<string, unknown>): never => { throw new JoinRefusal(code, status, extra); };

export type RemoveReason = 'left' | 'removed' | 'not_member';

export interface RemoveOffer { did: string; name: string; reason: RemoveReason }
export interface ReplaceOffer {
  oldDid: string;
  /** null while the person has not set up the new identity yet. */
  newDid: string | null;
  name: string;
  userId: string;
  triesLeft: number;
  compared: boolean;
  anchor: 'none' | 'ok' | 'invalid';
}
export interface HandoverView {
  you: 'old_admin' | 'new_admin';
  /** `named`: the old admin named her device; the new admin builds and signs. `signed`: the new admin signed; the old admin signs last. */
  stage: 'named' | 'signed';
  newAdminName: string | null;
}

export interface AdminChanges {
  role: 'admin';
  version: number;
  yourCode: string;
  remove: RemoveOffer[];
  replace: ReplaceOffer[];
  /** The device that signed the current list is gone: offer the same list again, signed by a device that stays. */
  resign: boolean;
  handover: HandoverView | null;
  /** Other members of the verified list a hand-over can name. */
  candidates: { did: string; name: string }[];
}
export interface MemberChanges {
  role: 'member';
  /** The Authority Server names another admin than the one this person's anchor names: compare codes and anchor again. */
  adminChanged: boolean;
  /** The admin took a new identity and cannot sign: the admin must set up the team again (a take-over is deferred, DEC-82). */
  adminGone: boolean;
  /** This person is the proposed new admin of a hand-over. */
  handover: HandoverView | null;
}
export type TeamChanges = AdminChanges | MemberChanges;

export interface TeamChangesDeps {
  join: TeamJoin;
  store: TeamTrustStore;
  now?: () => number;
}

export class TeamListChanges {
  private readonly now: () => number;
  constructor(private readonly d: TeamChangesDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private get join(): TeamJoin { return this.d.join; }

  active(): boolean { return this.join.active(); }

  private path(teamId: string, rest: string): string { return `/api/teams/${encodeURIComponent(teamId)}${rest}`; }

  private async offersOf(s: Session, teamId: string): Promise<Record<string, any>> {
    const r = await this.join.call(s, 'GET', this.path(teamId, '/offers'));
    if (r.status === 403 || r.status === 404) return refuse('team_unknown', r.status);
    if (r.status !== 200 || !isObj(r.body)) return refuse('as_answer_invalid', 502);
    return r.body;
  }

  /** The verified head (step 3), or null when it cannot be had (blocked, stale, the admin's chain gone). */
  private async verifiedHead(s: Session, teamId: string): Promise<{ list: MemberList; hash: string } | null> {
    try { return await this.join.d.trust.head(teamId, s); } catch (e) {
      if (e instanceof TeamTrustUnavailable) return null;
      throw e;
    }
  }

  private async requireHead(s: Session, teamId: string): Promise<{ list: MemberList; hash: string }> {
    const h = await this.verifiedHead(s, teamId);
    if (!h) return refuse('trust_unavailable', 422);
    return h;
  }

  private async adminHead(s: Session, teamId: string): Promise<{ list: MemberList; hash: string }> {
    const h = await this.requireHead(s, teamId);
    if (h.list.admin_did !== s.stored.rootDid) return refuse('not_admin', 403);
    return h;
  }

  private replaceKey(teamId: string, userId: string, newDid: string): string { return `r:${teamId}:${userId}:${newDid}`; }

  // ─── what is on offer ────────────────────────────────────────────────────

  async status(teamIdIn: unknown): Promise<TeamChanges> {
    const teamId = this.join.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.join.session();
    const offers = await this.offersOf(s, teamId);
    const head = await this.verifiedHead(s, teamId);
    const hand = await this.handoverOf(s, teamId);
    const handView = (h: NonNullable<typeof hand>, names?: Map<string, string>): HandoverView => ({ you: h.you, stage: h.stage, newAdminName: h.newDid && names ? names.get(h.newDid) ?? null : null });
    if (!head || head.list.admin_did !== s.stored.rootDid) {
      const anchor = await this.ownAnchorAdmin(s, teamId);
      const asAdmin = typeof offers.admin_did === 'string' ? offers.admin_did : null;
      return {
        role: 'member',
        adminChanged: !!asAdmin && !!anchor && anchor !== asAdmin,
        adminGone: offers.admin_gone === true,
        handover: hand && hand.you === 'new_admin' ? handView(hand) : null,
      };
    }
    const names = new Map(head.list.members.map(m => [m.did, m.name]));
    const remove: RemoveOffer[] = [];
    for (const o of Array.isArray(offers.remove) ? offers.remove : []) {
      if (!isObj(o) || typeof o.did !== 'string' || o.did === s.stored.rootDid || !names.has(o.did)) continue;
      const reason: RemoveReason = o.reason === 'left' || o.reason === 'removed' ? o.reason : 'not_member';
      remove.push({ did: o.did, name: names.get(o.did)!, reason });
    }
    const replace: ReplaceOffer[] = [];
    for (const o of Array.isArray(offers.replace) ? offers.replace : []) {
      if (!isObj(o) || typeof o.old_did !== 'string' || typeof o.user_id !== 'string' || !names.has(o.old_did) || o.old_did === s.stored.rootDid) continue;
      const newDid = typeof o.new_did === 'string' && DID.test(o.new_did) ? o.new_did : null;
      const key = newDid ? this.replaceKey(teamId, o.user_id, newDid) : '';
      replace.push({
        oldDid: o.old_did, newDid, name: names.get(o.old_did)!, userId: o.user_id,
        triesLeft: newDid ? this.join.adminGate.triesLeft(key) : 0, compared: newDid ? this.join.adminGate.matched(key) : false,
        anchor: newDid ? await this.join.anchorState(s, teamId, o.user_id, newDid) : 'none',
      });
    }
    return {
      role: 'admin', version: head.list.version, yourCode: await dk.identityCode(s.stored.rootDid), remove, replace,
      resign: !dk.isActive(s.own, head.list.key_id),
      handover: hand && hand.you === 'old_admin' ? handView(hand, names) : null,
      candidates: head.list.members.filter(m => m.did !== s.stored.rootDid).map(m => ({ did: m.did, name: m.name })),
    };
  }

  private async ownAnchorAdmin(s: Session, teamId: string): Promise<string | null> {
    const r = await this.join.call(s, 'GET', this.path(teamId, '/anchor'));
    if (r.status !== 200 || !isObj(r.body)) return null;
    const a = r.body.anchor;
    return isObj(a) && isObj(a.anchor) && typeof a.anchor.admin_did === 'string' ? a.anchor.admin_did : null;
  }

  // ─── building and posting a list ─────────────────────────────────────────

  /** The next list on the verified head with `members` (entries as signed before, or a rebuilt one), signed by this computer's device. */
  private async signNext(s: Session, head: { list: MemberList; hash: string }, members: TeamMember[], rest: { admin_did?: string; handover?: MemberList['handover']; signer?: Session } = {}): Promise<{ list: MemberList; sigs: unknown[] }> {
    const dk = await deviceKeys();
    const sorted = [...members].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
    const list = dk.buildMemberList({
      team_id: head.list.team_id, version: head.list.version + 1, prev: head.hash, admin_did: rest.admin_did ?? s.stored.rootDid, members: sorted,
      handover: rest.handover ?? null,
      key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash,
      created_at: this.now(), nonce: dk.b64uEncode(randomBytes(16)),
    });
    try { dk.validateMemberList(list); } catch { return refuse('list_invalid'); }
    const { sig, check } = await this.join.signWithCheck(s, list, undefined, head.list);
    return { list, sigs: [{ key_id: s.stored.keyId, sig, check }] };
  }

  private async post(s: Session, path: string, body: unknown, ok: number[] = [200, 201]): Promise<any> {
    const r = await this.join.call(s, 'POST', path, body);
    if (!ok.includes(r.status)) return refuse(asErrorCode(r.body) ?? 'list_refused', r.status === 409 ? 409 : 422);
    return r.body;
  }

  /** Remove one person from the list (they left, or the AS ended their membership). One touch. */
  async removeMember(teamIdIn: unknown, didIn: unknown): Promise<{ version: number }> {
    const teamId = this.join.teamId(teamIdIn);
    if (typeof didIn !== 'string' || !DID.test(didIn)) return refuse('bad_request', 400);
    const s = await this.join.session();
    const head = await this.adminHead(s, teamId);
    if (didIn === s.stored.rootDid) return refuse('bad_request', 400);
    if (!head.list.members.some(m => m.did === didIn)) return refuse('not_a_member', 409);
    const next = await this.signNext(s, head, head.list.members.filter(m => m.did !== didIn));
    await this.post(s, this.path(teamId, '/members/remove'), next);
    return { version: next.list.version };
  }

  /** Step 1 of a new identity: the typed code of the NEW identity, against the DID the Authority Server names for that person. */
  async replaceCheck(teamIdIn: unknown, userIdIn: unknown, typed: unknown): Promise<{ match: true } | { match: false; triesLeft: number }> {
    const teamId = this.join.teamId(teamIdIn);
    const userId = this.join.userId(userIdIn);
    if (typeof typed !== 'string' || typed.length > 64) return refuse('bad_request', 400);
    const dk = await deviceKeys();
    const s = await this.join.session();
    const o = (await this.status(teamId));
    const offer = o.role === 'admin' ? o.replace.find(x => x.userId === userId) : undefined;
    if (!offer) return refuse('no_replacement', 404);
    if (!offer.newDid) return refuse('new_identity_missing', 409);
    return this.join.adminGate.attempt(this.replaceKey(teamId, userId, offer.newDid), await dk.identityCode(offer.newDid), typed);
  }

  /** Step 2: the touch signs the list that replaces the old DID by the new one. Needs the code to have matched AND the person's new anchor to verify. */
  async replaceMember(teamIdIn: unknown, userIdIn: unknown): Promise<{ version: number }> {
    const teamId = this.join.teamId(teamIdIn);
    const userId = this.join.userId(userIdIn);
    const dk = await deviceKeys();
    const s = await this.join.session();
    const head = await this.adminHead(s, teamId);
    const offers = await this.offersOf(s, teamId);
    const o = (Array.isArray(offers.replace) ? offers.replace : []).find((x: any) => isObj(x) && x.user_id === userId);
    if (!o || typeof o.old_did !== 'string' || typeof o.new_did !== 'string' || !DID.test(o.new_did)) return refuse('no_replacement', 404);
    const oldEntry = head.list.members.find(m => m.did === o.old_did);
    if (!oldEntry || o.old_did === s.stored.rootDid) return refuse('no_replacement', 404);
    if (!this.join.adminGate.matched(this.replaceKey(teamId, userId, o.new_did))) return refuse('not_compared', 409);
    if ((await this.join.anchorState(s, teamId, userId, o.new_did)) !== 'ok') return refuse('anchor_required', 409);
    let added: TeamMember;
    try { added = await dk.buildTeamMember(o.new_did, oldEntry.name); } catch { return refuse('list_invalid'); }
    const next = await this.signNext(s, head, [...head.list.members.filter(m => m.did !== o.old_did), added]);
    await this.post(s, this.path(teamId, '/members/replace'), next);
    this.join.adminGate.forget(this.replaceKey(teamId, userId, o.new_did));
    return { version: next.list.version };
  }

  /** Re-sign: the same members again, signed by a device that stays, once the signer of the current list is gone (checked HERE against the own chain). One touch. */
  async resign(teamIdIn: unknown): Promise<{ version: number }> {
    const teamId = this.join.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.join.session();
    const head = await this.adminHead(s, teamId);
    if (dk.isActive(s.own, head.list.key_id)) return refuse('resign_not_needed', 409);
    const next = await this.signNext(s, head, head.list.members);
    await this.post(s, this.path(teamId, '/members/resign'), next);
    return { version: next.list.version };
  }

  // ─── hand-over, signed by both ───────────────────────────────────────────

  private async handoverOf(s: Session, teamId: string): Promise<(HandoverView & { raw: Record<string, any>; newDid: string | null }) | null> {
    const r = await this.join.call(s, 'GET', this.path(teamId, '/handover'));
    if (r.status !== 200 || !isObj(r.body) || !isObj(r.body.handover)) return null;
    const h = r.body.handover as Record<string, any>;
    if (h.you !== 'old_admin' && h.you !== 'new_admin') return null;
    const newDid = isObj(h.list) && typeof h.list.admin_did === 'string' ? h.list.admin_did : null;
    return { you: h.you, stage: h.list ? 'signed' : 'named', newAdminName: null, newDid, raw: h };
  }

  /** The old admin names the new admin and her own device. Nothing is signed. */
  async handoverOffer(teamIdIn: unknown, didIn: unknown): Promise<{ ok: true }> {
    const teamId = this.join.teamId(teamIdIn);
    if (typeof didIn !== 'string' || !DID.test(didIn)) return refuse('bad_request', 400);
    const s = await this.join.session();
    const head = await this.adminHead(s, teamId);
    if (!head.list.members.some(m => m.did === didIn) || didIn === s.stored.rootDid) return refuse('not_a_member', 409);
    await this.post(s, this.path(teamId, '/handover'), { new_admin_did: didIn, handover: { key_id: s.stored.keyId, chain_seq: s.own.head.seq, chain_head: s.own.head.hash } });
    return { ok: true };
  }

  /** The new admin builds the list with the device the old admin named and signs it (one touch). */
  async handoverBuild(teamIdIn: unknown): Promise<{ version: number }> {
    const teamId = this.join.teamId(teamIdIn);
    const s = await this.join.session();
    const head = await this.requireHead(s, teamId);
    const hand = await this.handoverOf(s, teamId);
    if (!hand || hand.you !== 'new_admin' || hand.stage !== 'named') return refuse('no_handover', 404);
    if (!head.list.members.some(m => m.did === s.stored.rootDid)) return refuse('not_a_member', 409);
    const hd = hand.raw.handover;
    if (!isObj(hd) || typeof hd.key_id !== 'string' || typeof hd.chain_head !== 'string' || !Number.isSafeInteger(hd.chain_seq)) return refuse('as_answer_invalid', 502);
    const next = await this.signNext(s, head, head.list.members, {
      admin_did: s.stored.rootDid, handover: { admin_did: head.list.admin_did, key_id: hd.key_id, chain_seq: hd.chain_seq as number, chain_head: hd.chain_head },
    });
    await this.post(s, this.path(teamId, '/handover/list'), next);
    return { version: next.list.version };
  }

  /** The old admin checks what the new admin signed, adds her signature (one touch); the Authority Server stores the list. */
  async handoverSign(teamIdIn: unknown): Promise<{ version: number }> {
    const teamId = this.join.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.join.session();
    const head = await this.adminHead(s, teamId);
    const hand = await this.handoverOf(s, teamId);
    if (!hand || hand.you !== 'old_admin' || hand.stage !== 'signed') return refuse('no_handover', 404);
    let list: MemberList;
    try { list = dk.validateMemberList(hand.raw.list); } catch { return refuse('list_invalid'); }
    const theirs = hand.raw.sigs;
    const h = list.handover;
    const same = list.members.length === head.list.members.length && list.members.every((m, i) => m.did === head.list.members[i].did && m.name === head.list.members[i].name);
    if (list.team_id !== teamId || list.version !== head.list.version + 1 || list.prev !== head.hash || !same
      || !head.list.members.some(m => m.did === list.admin_did) || list.admin_did === s.stored.rootDid
      || !h || h.admin_did !== s.stored.rootDid || h.key_id !== s.stored.keyId) return refuse('handover_mismatch', 409);
    if (!Array.isArray(theirs) || theirs.length !== 1 || !isObj(theirs[0])) return refuse('as_answer_invalid', 502);
    // the new admin's chain, verified here; both signatures are verified here before the last touch is spent
    let theirChain;
    try { theirChain = await this.join.d.grants.verifiedChainOf(list.admin_did, s); } catch (e) {
      if (e instanceof GrantRefusal) return refuse(e.code, 422);
      throw e;
    }
    const { sig, check } = await this.join.signWithCheck(s, list, undefined, head.list);
    const mine = { key_id: s.stored.keyId, sig, check };
    try {
      await dk.verifyMemberList({ list, sigs: [theirs[0], mine] }, { chain: theirChain, oldAdminChain: s.own, prev: head.list });
    } catch (e) {
      return refuse(isDeviceKeysError(e) ? 'handover_invalid' : 'handover_mismatch', 409);
    }
    await this.post(s, this.path(teamId, '/handover/sign'), { sigs: [mine] });
    return { version: list.version };
  }

  async handoverWithdraw(teamIdIn: unknown): Promise<{ ok: true }> {
    const teamId = this.join.teamId(teamIdIn);
    const s = await this.join.session();
    const r = await this.join.call(s, 'DELETE', this.path(teamId, '/handover'));
    if (r.status !== 200 && r.status !== 404) return refuse(asErrorCode(r.body) ?? 'withdraw_refused', 422);
    return { ok: true };
  }

  // ─── the admin took a new identity ───────────────────────────────────────
  // deferred (DEC-82): NOT reachable. No route calls `takeOver`; the AS has no take-over route either (it needs the two-person support
  // confirmation first). Kept, unmounted, so the logic is not lost.

  /**
   * A member takes over: the next list is signed by this person alone and drops the old admin's DID. Built on the list THIS gateway's
   * pin names (found by hash among the lists the Authority Server serves), because the old admin's chain is gone and the normal
   * verification cannot run. Members trust it only after they re-anchored to this person.
   */
  async takeOver(teamIdIn: unknown): Promise<{ version: number }> {
    const teamId = this.join.teamId(teamIdIn);
    const dk = await deviceKeys();
    const s = await this.join.session();
    const offers = await this.offersOf(s, teamId);
    if (offers.admin_gone !== true) return refuse('admin_can_sign', 409);
    const pin = this.d.store.pin(teamId);
    if (!pin) return refuse('no_pin', 409);
    const r = await this.join.call(s, 'GET', `${this.path(teamId, '/trust')}?from=${pin.version}&leaves_limit=1`);
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.lists)) return refuse('as_answer_invalid', 502);
    let prev: MemberList | null = null;
    for (const e of r.body.lists) {
      if (!isObj(e)) continue;
      try {
        const l = dk.validateMemberList(e.list);
        if (l.version === pin.version && (await dk.memberListHash(l)) === pin.hash) prev = l;
      } catch { /* not this one */ }
    }
    if (!prev) return refuse('pinned_list_missing', 409);
    if (prev.admin_did === s.stored.rootDid || !prev.members.some(m => m.did === s.stored.rootDid)) return refuse('not_a_member', 409);
    const next = await this.signNext(s, { list: prev, hash: pin.hash }, prev.members.filter(m => m.did !== prev!.admin_did));
    await this.post(s, this.path(teamId, '/admin-takeover'), next);
    return { version: next.list.version };
  }
}
