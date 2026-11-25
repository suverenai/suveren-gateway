/**
 * The mandate-grant routes of the Authority Server for the step 13 tests, on top of StubAs
 * (helpers/stub-as.ts), in the shapes and with the rules of suveren-as PR #141 (read at
 * temp/ws-as-grants/apps/as: lib/device-keys/mandate-{grants,bodies,receipts}.ts, app/api/mandates/**,
 * app/api/as/mandate/route.ts):
 *
 *   POST/GET /api/mandates/:id/grants      stored only after hap-core `verifyGrant` against the owner's chain; the
 *                                          members are EXACTLY the AS's list, written out by hand below (never
 *                                          derived from the gateway's code); versions, replaces, MANDATE_REVOKED
 *   POST/GET /api/mandates/prepared        shape only: exactly { mandate_id, mandate_version, ciphertext, device_keys },
 *                                          one wrap for every active device and for no other key; the 10 minute window
 *   GET/POST /api/mandates/:id/body
 *   POST/GET /api/mandates/:id/receipts    verified with hap-core `verifyReceipt`; one per (mandate, version, gateway)
 *   POST /api/as/mandate                   for a chain account: mandate_id + mandate_version, no ttl, expires_at, only
 *                                          `did` in mandate_owners, the team's settings must equal the request (it fills
 *                                          in nothing), the stored grant must hold for exactly what it signs
 *
 * plus the reads the ceremony makes (groups, profiles, the team's settings, approver keys, identity disclosure).
 * Only the network is a stand-in; every check of a grant is hap-core's. It records every call.
 */

import { createHash } from 'node:crypto';
import {
  verifyChain, verifyGrant, verifyReceipt, grantHash, activeDevices, jcs, b64uBytes, DeviceKeysError,
  type ChainState, type MandateGrant, type MandateReceipt,
} from '@hap/core/device-keys';
import {
  computeBoundsHash, computeProfileHash, computeIntentDisclosureHash, signMandate, encodeMandateBlob, decodeMandateBlob,
  type MandatePayload,
} from '@hap/core';
import type { ExtraRouteContext, StubAs } from './stub-as';

/** The members of a grant besides the fixed ones: PR #141's list (`grantFieldKeys()` of the Authority Server), by hand. */
export const AS_GRANT_MEMBERS = [
  'above_cap_approvals', 'above_cap_approvers', 'above_cap_caps', 'authorization_id', 'bounds_hash', 'chain_dids', 'commitment_mode',
  'disclose_fields', 'execution_context_hash', 'expires_at', 'gate_content_hashes', 'group_id', 'intent_disclosure_hash', 'profile_hash',
  'profile_id', 'replaces', 'scope_hash', 'subjects_disclosed', 'version',
].sort();
const FIXED = ['typ', 'v', 'op', 'owner_did', 'key_id', 'chain_seq', 'chain_head', 'mandate_id', 'mandate_version', 'granted_at', 'nonce'];
const GRANT_BODY_WINDOW = 10 * 60;
const B64U = /^[A-Za-z0-9_-]+$/;
const MANDATE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const AUTHZ = /^authz_[0-9a-f-]{36}$/;

interface Row {
  mandateId: string; version: number; op: 'grant' | 'change' | 'revoke'; userId: string; keyId: string; authorizationId: string; groupId: string;
  grantHash: string; grant: MandateGrant; sig: string; check: unknown; asChainSeq: number; storedAt: number;
}
interface Body { mandateId: string; version: number; userId: string; submittedBy: string; ciphertext: string; deviceKeys: Record<string, { ct: string; enc: string }>; storedAt: number; expiresAt: number }
interface Issued { authorizationId: string; mandateId: string; version: number; blob: string; payload: MandatePayload; groupId: string; revoked: boolean }

/** What the Authority Server computes from the team's settings (the real one reads its tables; a test says it here). */
export interface TeamExpectation {
  mode: 'automatic' | 'review' | 'review_above_cap';
  caps?: Record<string, number>; approvers?: string[]; approvals?: number;
}

export interface Posted { method: string; path: string; body: Record<string, unknown>; status: number }

export class StubMandates {
  readonly rows: Row[] = [];
  readonly bodies: Body[] = [];
  readonly receipts: Array<{ mandateId: string; version: number; keyId: string; grantHash: string; receipt: MandateReceipt; sig: string }> = [];
  readonly issued: Issued[] = [];
  readonly posts: Posted[] = [];
  readonly nonces = new Set<string>();
  /** The team's configured settings, as GET /api/groups/:id/profile-config/:profileId answers them. */
  team: { approvers: string[]; approvals?: number; caps: Record<string, { value: number; kind: 'hard' | 'approval' }> } | null = null;
  /** What the Authority Server would sign for the team (the gateway must have asked for exactly this). */
  expectation: TeamExpectation | null = null;
  /** Account id to DID, and who awaits a team admin's re-confirmation (DEC-35). */
  readonly users = new Map<string, { did: string; reconfirm?: boolean; chain?: boolean }>();
  /** Test only: answer `eligible_approvers` with exactly this (a lying Authority Server). */
  eligibleOverride: unknown = undefined;
  /** Accounts (besides the owner) that may read the owner's grants: team members and approvers (`grantsVisibleTo`). */
  readonly viewers = new Set<string>();
  identity = { verified: false, always: false };
  /** The newest version of an issued mandate wins; the clock the body window and `granted_at` read. */
  now: () => number;

  constructor(private readonly as: StubAs, readonly profile: Record<string, any>, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    const prev = as.extraRoutes;
    as.extraRoutes = async c => (await this.route(c)) || (prev ? prev(c) : false);
  }

  ownerDid(): string { return this.as.accounts.get('u1')!.rootDid!; }
  private async chain(): Promise<ChainState> { return verifyChain({ expectedRootDid: this.ownerDid(), entries: this.as.chainEntries() }); }
  private hasChain(did: string): boolean { return did === this.ownerDid() || this.as.otherChains.has(did); }

  grantsOf(mandateId: string): Row[] { return this.rows.filter(r => r.mandateId === mandateId); }

  private async route(c: ExtraRouteContext): Promise<boolean> {
    const { method, path } = c;
    const done = (status: number): boolean => { if (method !== 'GET') this.posts.push({ method, path, body: c.body, status }); return true; };
    const refuse = (status: number, code: string, message = code, extra: Record<string, unknown> = {}): boolean => { c.refuse(status, code, message, extra); return done(status); };
    const ok = (status: number, body: unknown): boolean => { c.json(status, body); return done(status); };
    let m: RegExpExecArray | null;

    // ── what the ceremony reads
    if (method === 'GET' && path === '/api/groups') return ok(200, { groups: [{ id: 'g_personal', name: 'Anna', isPersonal: true }, { id: 'g_team', name: 'Sales Vienna', isPersonal: false }] });
    if (method === 'GET' && path === '/api/profiles') return ok(200, { profiles: [{ id: this.profile.id }] });
    if (method === 'GET' && path.startsWith('/api/profiles/')) return decodeURIComponent(path.slice(14)) === this.profile.id ? ok(200, this.profile) : refuse(404, 'NOT_FOUND');
    if (method === 'GET' && /^\/api\/groups\/[^/]+\/profile-config\/[^/]+$/.test(path)) {
      if (!this.team) return refuse(404, 'NOT_FOUND');
      // device keys on: who may approve, with the DID (null without a chain), ascending DID order (null last) — PR #141's `eligible_approvers`
      const eligible = this.team.approvers.filter(u => !this.users.get(u)?.reconfirm).map(u => ({ user_id: u, did: this.users.get(u)?.chain === false ? null : (this.users.get(u)?.did ?? null) }))
        .sort((a, b) => (a.did === null || b.did === null) ? (a.did === null ? 1 : 0) - (b.did === null ? 1 : 0) : a.did < b.did ? -1 : a.did > b.did ? 1 : 0);
      return ok(200, { config: { approvers: this.team.approvers, grantors: [...this.team.approvers, 'u1'], approvals: this.team.approvals, caps: this.team.caps }, eligible_approvers: this.eligibleOverride !== undefined ? this.eligibleOverride : eligible });
    }
    if (method === 'GET' && /\/approvers\/pubkeys$/.test(path)) {
      const eligible = (this.team?.approvers ?? []).filter(u => !this.users.get(u)?.reconfirm);
      return ok(200, { pubkeys: Object.fromEntries(eligible.map(u => [u, Buffer.alloc(32, 7).toString('base64')])) });
    }
    if (method === 'GET' && path === '/api/users/me/identity-disclosure') return ok(200, { always: this.identity.always, verified: this.identity.verified });
    if ((m = /^\/api\/users\/([^/]+)\/pubkey$/.exec(path)) && method === 'GET') {
      const u = this.users.get(decodeURIComponent(m[1]));
      if (!u) return refuse(404, 'NOT_FOUND');
      if (u.reconfirm) return refuse(409, 'APPROVER_RECONFIRMATION_REQUIRED', 'awaiting a team admin');
      return ok(200, { userId: m[1], pubkey: Buffer.alloc(32, 7).toString('base64'), did: u.did });
    }
    if (method === 'GET' && path === '/api/mandates') {
      const id = new URLSearchParams(c.req.url?.split('?')[1] ?? '').get('authorization_id') ?? '';
      const list = this.issued.filter(i => i.authorizationId === id);
      return ok(200, { authorization_id: id, mandates: list.map(i => ({ domain: 'owner', blob: i.blob, expires_at: i.payload.expires_at })), complete: list.length > 0, revoked: list.some(i => i.revoked) });
    }
    if (method === 'GET' && path === '/api/mandates/mine') return ok(200, { mandates: this.issued.filter(i => !i.revoked).map(i => ({ authorization_id: i.authorizationId })) });
    if (method === 'POST' && (m = /^\/api\/authorizations\/([^/]+)\/revoke$/.exec(path))) {
      for (const i of this.issued) if (i.authorizationId === m[1]) i.revoked = true;
      return ok(200, {});
    }

    if (!c.session) return refuse(401, 'DEVICE_SESSION_REQUIRED', 'a device session of the owner is required');
    const session = c.session;

    // ── the mandate request
    if (method === 'POST' && path === '/api/as/mandate') return this.mandate(c, ok, refuse);

    // ── grants, bodies, receipts
    if ((m = /^\/api\/mandates\/([^/]+)\/grants$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (!MANDATE_ID.test(id)) return refuse(400, 'MALFORMED', 'not a mandate id');
      if (method === 'GET') {
        const list = this.grantsOf(id);
        // like `grantsVisibleTo`: the owner, or someone who may see the mandate's authorization (a team member, an approver)
        if (list.length > 0 && list[0].userId !== session.userId && !this.viewers.has(session.userId)) return ok(200, { grants: [] });
        return ok(200, { grants: list.map(g => ({ mandate_id: g.mandateId, mandate_version: g.version, op: g.op, grant: g.grant, sig: g.sig, check: g.check, grant_hash: g.grantHash, as_chain_seq: g.asChainSeq, stored_at: g.storedAt })) });
      }
      return this.storeGrant(c, id, ok, refuse);
    }
    if (method === 'POST' && path === '/api/mandates/prepared') return this.storePrepared(c, ok, refuse);
    if (method === 'GET' && path === '/api/mandates/prepared') {
      // like `preparedFor`: the owner's waiting bodies (no grant stored at that version yet), the caller's own wrap only, expired ones swept first
      this.sweep();
      return ok(200, { prepared: this.bodies.filter(b => b.userId === session.userId && !this.grantsOf(b.mandateId).some(g => g.version === b.version && g.op !== 'revoke'))
        .map(b => ({ mandate_id: b.mandateId, mandate_version: b.version, submitted_by_key_id: b.submittedBy, ciphertext: b.ciphertext, device_key: b.deviceKeys[session.keyId] ?? null, stored_at: b.storedAt, expires_at: b.expiresAt })) });
    }
    if ((m = /^\/api\/mandates\/([^/]+)\/body$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (!MANDATE_ID.test(id)) return refuse(400, 'MALFORMED', 'not a mandate id');
      if (method === 'GET') {
        this.sweep();
        return ok(200, { bodies: this.bodies.filter(b => b.mandateId === id && b.userId === session.userId).sort((a, b) => a.version - b.version).map(b => ({ mandate_id: b.mandateId, mandate_version: b.version, submitted_by_key_id: b.submittedBy, ciphertext: b.ciphertext, device_key: b.deviceKeys[session.keyId] ?? null, granted: this.grantsOf(id).some(g => g.version === b.version && g.op !== 'revoke'), stored_at: b.storedAt, expires_at: b.expiresAt })) });
      }
      if (method === 'POST') return this.addWraps(c, id, ok, refuse);
    }
    if ((m = /^\/api\/mandates\/([^/]+)\/receipts$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') return ok(200, { receipts: this.receipts.filter(r => r.mandateId === id).map(r => ({ mandate_id: r.mandateId, mandate_version: r.version, key_id: r.keyId, grant_hash: r.grantHash, receipt: r.receipt, sig: r.sig, stored_at: 0 })) });
      return this.storeReceipt(c, id, ok, refuse);
    }
    return false;
  }

  // ─── POST /api/mandates/:id/grants ──────────────────────────────────────

  private async storeGrant(c: ExtraRouteContext, mandateId: string, ok: (s: number, b: unknown) => boolean, refuse: (s: number, c: string, m?: string, e?: Record<string, unknown>) => boolean): Promise<boolean> {
    const session = c.session!;
    const env = c.body as { grant?: any; sig?: unknown; check?: unknown };
    if (!env.grant || typeof env.grant !== 'object' || Array.isArray(env.grant)) return refuse(400, 'MALFORMED', 'grant must be an object');
    if (typeof env.sig !== 'string' || !env.sig) return refuse(400, 'MALFORMED', 'sig must be a string');
    const raw = env.grant as Record<string, unknown>;
    const op = raw.op as 'grant' | 'change' | 'revoke';
    const version = raw.mandate_version as number;
    if (op !== 'grant' && op !== 'change' && op !== 'revoke') return refuse(400, 'MALFORMED', 'op must be grant, change or revoke');
    if (!Number.isSafeInteger(version) || version < 1) return refuse(400, 'MALFORMED', 'mandate_version must be an integer from 1');
    if (raw.mandate_id !== mandateId) return refuse(409, 'GRANT_MISMATCH', 'the grant names another mandate than the route');
    const chain = await this.chain();
    const rows = this.grantsOf(mandateId);
    if (rows.some(r => r.userId !== session.userId)) return refuse(409, 'MANDATE_ID_TAKEN', 'this mandate id belongs to another account');
    const revoked = rows.find(r => r.op === 'revoke');
    const newest = rows.filter(r => r.op !== 'revoke').sort((a, b) => b.version - a.version)[0] ?? null;

    let fields: Record<string, unknown>;
    if (op === 'revoke') {
      if (!newest) return refuse(404, 'MANDATE_UNKNOWN', 'no grant is stored for this mandate, so there is nothing to revoke here');
      fields = Object.fromEntries(Object.entries(newest.grant).filter(([k]) => !FIXED.includes(k)));
    } else {
      fields = Object.fromEntries(Object.entries(raw).filter(([k]) => !FIXED.includes(k)));
      const have = Object.keys(fields).sort();
      if (jcs(have) !== jcs(AS_GRANT_MEMBERS)) {
        return refuse(400, 'GRANT_FIELDS_INVALID', `a grant carries exactly the mandate's members (missing: ${AS_GRANT_MEMBERS.filter(k => !have.includes(k)).join(', ') || 'none'}; extra: ${have.filter(k => !AS_GRANT_MEMBERS.includes(k)).join(', ') || 'none'})`);
      }
      if (fields.version !== '0.8') return refuse(400, 'GRANT_FIELDS_INVALID', 'a grant covers a v0.8 mandate');
      if (typeof fields.authorization_id !== 'string' || !AUTHZ.test(fields.authorization_id)) return refuse(400, 'GRANT_FIELDS_INVALID', 'authorization_id is not an authorization id');
      if (fields.replaces !== null && (typeof fields.replaces !== 'string' || !AUTHZ.test(fields.replaces))) return refuse(400, 'GRANT_FIELDS_INVALID', 'replaces must be null or an authorization id');
      for (const k of ['version', 'profile_id', 'profile_hash', 'bounds_hash', 'scope_hash', 'execution_context_hash', 'gate_content_hashes', 'commitment_mode', 'expires_at', 'subjects_disclosed', 'authorization_id', 'group_id', 'chain_dids']) {
        if (fields[k] === null || fields[k] === undefined) return refuse(400, 'GRANT_FIELDS_INVALID', `grant member ${k} may not be null`);
      }
    }
    if (revoked) {
      if (op === 'revoke' && version === revoked.version) return ok(200, { stored: true, mandate_id: mandateId, mandate_version: version, op, grant_hash: revoked.grantHash, as_chain_seq: revoked.asChainSeq });
      return refuse(409, 'MANDATE_REVOKED', 'this mandate was revoked; a revocation is final');
    }
    const existing = rows.find(r => r.version === version && r.op === op);
    if (op !== 'revoke' && newest && version < newest.version) return refuse(409, 'GRANT_VERSION_REFUSED', `the newest version is ${newest.version}; an older one is refused`, { current_version: newest.version });
    if (op === 'grant') { if (version !== 1) return refuse(409, 'GRANT_VERSION_REFUSED', 'a first grant is version 1'); }
    else if (op === 'change') {
      if (!newest) return refuse(409, 'GRANT_VERSION_REFUSED', 'a change needs a stored grant to change');
      if (!existing && version !== newest.version + 1) return refuse(409, 'GRANT_VERSION_REFUSED', `the next version is ${newest.version + 1}; an older or skipped version is refused`, { current_version: newest.version });
    } else if (version !== newest!.version) return refuse(409, 'GRANT_VERSION_REFUSED', `a revoke names the current version (${newest!.version})`, { current_version: newest!.version });

    let verified: MandateGrant;
    try {
      verified = await verifyGrant({ grant: raw, sig: env.sig, check: env.check }, { chain, mandateFields: fields, expect: { ops: [op], mandate_id: mandateId, mandate_version: version } });
    } catch (e) {
      if (!(e instanceof DeviceKeysError)) throw e;
      return refuse(e.code === 'MALFORMED' ? 400 : e.code === 'CHAIN_AHEAD' || e.code === 'GRANT_MISMATCH' ? 409 : 403, e.code, `grant refused: ${e.message}`);
    }
    const hash = await grantHash(verified);
    if (existing) return existing.grantHash === hash ? ok(200, { stored: true, mandate_id: mandateId, mandate_version: version, op, grant_hash: hash, as_chain_seq: existing.asChainSeq }) : refuse(409, 'GRANT_VERSION_REFUSED', 'another grant is stored for this version');
    if (this.nonces.has(verified.nonce)) return refuse(409, 'GRANT_NONCE_REUSED', 'this grant nonce was used before');
    const now = this.now();
    if (verified.granted_at > now + 300) return refuse(400, 'MALFORMED', 'granted_at lies in the future');
    if (op !== 'revoke') {
      if ((fields.expires_at as number) <= now) return refuse(409, 'MANDATE_EXPIRED', 'This mandate\'s expires_at is already in the past. Grant it again with a later expiry.');
      if (fields.profile_id !== this.profile.id) return refuse(400, 'PROFILE_NOT_FOUND', `unknown profile: ${String(fields.profile_id)}`);
      if (computeProfileHash(this.profile as never) !== fields.profile_hash) return refuse(409, 'PROFILE_HASH_MISMATCH', 'profile_hash is not the hash of this Authority Server\'s bytes for the profile');
      if ((fields.expires_at as number) > now + (this.profile.ttl.max as number)) return refuse(422, 'EXPIRES_BEYOND_MAX', 'expires_at is later than now + the profile\'s max TTL');
      const approvers = (fields.above_cap_approvers as string[] | null) ?? [];
      const want = [...new Set([verified.owner_did, ...approvers])].filter(d => this.hasChain(d)).sort();
      if (want.length !== new Set([verified.owner_did, ...approvers]).size) return refuse(409, 'MIXED_CHAIN_ACCOUNTS', 'an approver has no device chain; a mandate does not mix accounts with and without one');
      if (jcs(fields.chain_dids) !== jcs(want)) return refuse(409, 'GRANT_MISMATCH', 'chain_dids is not the set of the owner and approvers that have a device chain at this Authority Server');
      if (op === 'change' && newest) {
        const before = newest.grant as Record<string, unknown>;
        if (fields.authorization_id !== newest.authorizationId) {
          if (fields.replaces !== newest.authorizationId) return refuse(409, 'CHANGE_NOT_ISSUABLE', `a change under a new authorization_id names the previous one in replaces (${newest.authorizationId})`);
        } else {
          if (fields.replaces !== (before.replaces ?? null)) return refuse(409, 'CHANGE_NOT_ISSUABLE', 'a change under the same authorization_id keeps replaces as it was');
          if (before.commitment_mode !== fields.commitment_mode || (before.above_cap_approvers === null) !== (fields.above_cap_approvers === null)) return refuse(409, 'CHANGE_NOT_ISSUABLE', 'a change of the commitment mode, or of whether the mandate carries above-cap approvers, names a new authorization_id (and replaces)');
          if (before.bounds_hash !== fields.bounds_hash || before.scope_hash !== fields.scope_hash || jcs(before.gate_content_hashes) !== jcs(fields.gate_content_hashes) || before.profile_id !== fields.profile_id) return refuse(409, 'CHANGE_NOT_ISSUABLE', 'bounds, scope, the intent gate, the mode and the profile of an authorization never change: name a new authorization_id (and replaces) for a change of any of them');
        }
      }
    }
    this.nonces.add(verified.nonce);
    this.rows.push({
      mandateId, version, op, userId: session.userId, keyId: verified.key_id, authorizationId: fields.authorization_id as string, groupId: fields.group_id as string,
      grantHash: hash, grant: verified, sig: env.sig, check: env.check ?? null, asChainSeq: chain.head.seq, storedAt: now,
    });
    if (op === 'revoke') {
      this.bodies.splice(0, this.bodies.length, ...this.bodies.filter(b => b.mandateId !== mandateId));
      for (const i of this.issued) if (i.mandateId === mandateId) i.revoked = true;
    } else {
      for (const b of this.bodies) if (b.mandateId === mandateId && b.version === version) b.expiresAt = fields.expires_at as number;
      if (op === 'change') this.bodies.splice(0, this.bodies.length, ...this.bodies.filter(b => !(b.mandateId === mandateId && b.version < version)));
    }
    return ok(201, { stored: true, mandate_id: mandateId, mandate_version: version, op, grant_hash: hash, as_chain_seq: chain.head.seq });
  }

  /** Like `sweepExpiredBodies`: a body whose time ran out is gone, on the stub's clock. */
  private sweep(): void {
    const now = this.now();
    this.bodies.splice(0, this.bodies.length, ...this.bodies.filter(b => b.expiresAt > now));
  }

  // ─── POST /api/mandates/:id/body (a device adds wraps for other active devices, 20.19 item 3) ───

  private async addWraps(c: ExtraRouteContext, mandateId: string, ok: (s: number, b: unknown) => boolean, refuse: (s: number, c: string, m?: string, e?: Record<string, unknown>) => boolean): Promise<boolean> {
    const session = c.session!;
    const body = c.body;
    const members = Object.keys(body).sort();
    if (members.length !== 2 || members[0] !== 'device_keys' || members[1] !== 'mandate_version') return refuse(400, 'MALFORMED', 'the body is exactly { mandate_version, device_keys }');
    const version = body.mandate_version as number;
    if (!Number.isSafeInteger(version) || version < 1) return refuse(400, 'MALFORMED', 'mandate_version must be an integer from 1');
    if (!body.device_keys || typeof body.device_keys !== 'object' || Array.isArray(body.device_keys) || Object.keys(body.device_keys).length === 0) return refuse(400, 'MALFORMED', 'device_keys is empty');
    const wraps = body.device_keys as Record<string, any>;
    for (const [k, w] of Object.entries(wraps)) {
      try { b64uBytes(k, 32, 'key id'); } catch { return refuse(400, 'MALFORMED', 'a device_keys name must be a device key id'); }
      const wm = w && typeof w === 'object' ? Object.keys(w).sort() : [];
      if (wm.length !== 2 || wm[0] !== 'ct' || wm[1] !== 'enc' || !B64U.test(w.ct) || !B64U.test(w.enc) || w.ct.length > 512 || w.enc.length > 512) return refuse(400, 'MALFORMED', 'a wrap is exactly { ct, enc } of base64url strings');
    }
    const active = new Set(activeDevices(await this.chain()).map(d => d.key_id));
    for (const k of Object.keys(wraps)) if (!active.has(k)) return refuse(409, 'DEVICE_KEYS_INVALID', 'a wrap is for a key that is not an active device of the owner', { key_id: k });
    this.sweep();
    const row = this.bodies.find(b => b.mandateId === mandateId && b.version === version && b.userId === session.userId);
    if (!row) return refuse(404, 'BODY_NOT_FOUND', 'no sealed body of yours for this mandate version');
    for (const k of Object.keys(wraps)) if (row.deviceKeys[k]) return refuse(409, 'WRAP_EXISTS', 'a wrap for this device is already stored; it is never replaced', { key_id: k });
    row.deviceKeys = { ...row.deviceKeys, ...wraps };
    return ok(201, { added: Object.keys(wraps) });
  }

  // ─── POST /api/mandates/prepared ────────────────────────────────────────

  private async storePrepared(c: ExtraRouteContext, ok: (s: number, b: unknown) => boolean, refuse: (s: number, c: string, m?: string, e?: Record<string, unknown>) => boolean): Promise<boolean> {
    const session = c.session!;
    const body = c.body;
    const members = Object.keys(body).sort();
    const allowed = ['ciphertext', 'device_keys', 'mandate_id', 'mandate_version'];
    if (members.length !== allowed.length || members.some((x, i) => x !== allowed[i])) return refuse(400, 'MALFORMED', 'a prepared mandate is exactly { mandate_id, mandate_version, ciphertext, device_keys }: ciphertext and wraps only');
    if (typeof body.mandate_id !== 'string' || !MANDATE_ID.test(body.mandate_id)) return refuse(400, 'MALFORMED', 'mandate_id must be 8 to 64 characters of letters, digits, - and _');
    const version = body.mandate_version as number;
    if (!Number.isSafeInteger(version) || version < 1) return refuse(400, 'MALFORMED', 'mandate_version must be an integer from 1');
    if (typeof body.ciphertext !== 'string' || !body.ciphertext || !B64U.test(body.ciphertext)) return refuse(400, 'MALFORMED', 'ciphertext must be a base64url string');
    if (!body.device_keys || typeof body.device_keys !== 'object' || Array.isArray(body.device_keys)) return refuse(400, 'MALFORMED', 'device_keys must be an object');
    const wraps = body.device_keys as Record<string, any>;
    for (const [k, w] of Object.entries(wraps)) {
      try { b64uBytes(k, 32, 'key id'); } catch { return refuse(400, 'MALFORMED', 'a device_keys name must be a device key id'); }
      const wm = w && typeof w === 'object' ? Object.keys(w).sort() : [];
      if (wm.length !== 2 || wm[0] !== 'ct' || wm[1] !== 'enc' || !B64U.test(w.ct) || !B64U.test(w.enc) || w.ct.length > 512 || w.enc.length > 512) return refuse(400, 'MALFORMED', 'a wrap is exactly { ct, enc } of base64url strings');
    }
    const chain = await this.chain();
    const active = activeDevices(chain).map(d => d.key_id).sort();
    const wrapped = Object.keys(wraps).sort();
    if (active.length !== wrapped.length || active.some((k, i) => k !== wrapped[i])) return refuse(409, 'DEVICE_KEYS_INVALID', 'a sealed body carries one wrap for every active device of the owner, and for no other key', { active_devices: active });
    const g = this.grantsOf(body.mandate_id);
    if (g.some(r => r.userId !== session.userId)) return refuse(409, 'MANDATE_ID_TAKEN', 'this mandate id belongs to another account');
    if (g.some(r => r.op === 'revoke')) return refuse(409, 'MANDATE_REVOKED', 'this mandate was revoked; a revocation is final');
    const newest = Math.max(0, ...g.map(r => r.version));
    const now = this.now();
    const granted = g.find(r => r.version === version);
    let expiresAt = now + 7 * 24 * 3600;
    if (granted) {
      if (version !== newest || now - granted.storedAt > GRANT_BODY_WINDOW) return refuse(409, 'GRANT_VERSION_REFUSED', `a body for version ${version} came more than ${GRANT_BODY_WINDOW} seconds after its grant`, { current_version: newest });
      expiresAt = Number((granted.grant as Record<string, unknown>).expires_at);
    } else if (version !== newest + 1) return refuse(409, 'GRANT_VERSION_REFUSED', `the next version of this mandate is ${newest + 1}`, { current_version: newest });
    if (this.bodies.some(b => b.mandateId === body.mandate_id && b.version === version)) return refuse(409, 'PREPARED_EXISTS', 'a body is already stored for this version');
    this.bodies.push({ mandateId: body.mandate_id, version, userId: session.userId, submittedBy: session.keyId, ciphertext: body.ciphertext, deviceKeys: wraps, storedAt: now, expiresAt });
    return ok(201, { mandate_id: body.mandate_id, mandate_version: version, expires_at: expiresAt });
  }

  // ─── POST /api/mandates/:id/receipts ────────────────────────────────────

  private async storeReceipt(c: ExtraRouteContext, mandateId: string, ok: (s: number, b: unknown) => boolean, refuse: (s: number, c: string, m?: string, e?: Record<string, unknown>) => boolean): Promise<boolean> {
    const session = c.session!;
    const env = c.body as { receipt?: any; sig?: unknown };
    if (!env.receipt || typeof env.receipt !== 'object') return refuse(400, 'MALFORMED', 'receipt must be an object');
    if (typeof env.sig !== 'string' || !env.sig) return refuse(400, 'MALFORMED', 'sig must be a string');
    const rows = this.grantsOf(mandateId);
    if (rows.some(r => r.op === 'revoke')) return refuse(409, 'MANDATE_REVOKED', 'this mandate was revoked; a revocation is final');
    const grant = rows.find(r => r.op !== 'revoke' && r.version === env.receipt.mandate_version);
    if (!grant) return refuse(404, 'GRANT_NOT_FOUND', 'no grant is stored for the version this receipt names');
    if (grant.userId !== session.userId) return refuse(403, 'NOT_AUTHORIZED_FOR_MANDATE', 'this mandate is not yours');
    let receipt: MandateReceipt;
    try {
      receipt = await verifyReceipt({ receipt: env.receipt, sig: env.sig }, { chain: await this.chain(), grant: grant.grant });
    } catch (e) {
      if (!(e instanceof DeviceKeysError)) throw e;
      return refuse(e.code === 'MALFORMED' ? 400 : e.code === 'CHAIN_AHEAD' || e.code === 'GRANT_MISMATCH' ? 409 : 403, e.code, `receipt refused: ${e.message}`);
    }
    if (receipt.key_id !== session.keyId) return refuse(403, 'DEVICE_MISMATCH', 'a receipt is stored by the gateway that signed it');
    const dev = (await this.chain()).devices[receipt.key_id];
    if (dev?.kind !== 'gateway') return refuse(403, 'DEVICE_KIND_NOT_ALLOWED', 'only a gateway answers a grant with a receipt');
    const old = this.receipts.find(r => r.mandateId === mandateId && r.version === receipt.mandate_version && r.keyId === receipt.key_id);
    if (old) return old.sig === env.sig ? ok(200, { stored: true, mandate_id: mandateId, mandate_version: receipt.mandate_version, key_id: receipt.key_id }) : refuse(409, 'RECEIPT_EXISTS', 'this gateway already answered this version; a receipt is not replaced');
    this.receipts.push({ mandateId, version: receipt.mandate_version, keyId: receipt.key_id, grantHash: receipt.grant_hash, receipt, sig: env.sig });
    return ok(201, { stored: true, mandate_id: mandateId, mandate_version: receipt.mandate_version, key_id: receipt.key_id });
  }

  // ─── POST /api/as/mandate (a chain account) ─────────────────────────────

  private async mandate(c: ExtraRouteContext, ok: (s: number, b: unknown) => boolean, refuse: (s: number, c: string, m?: string, e?: Record<string, unknown>) => boolean): Promise<boolean> {
    const b = c.body as Record<string, any>;
    const session = c.session!;
    if (typeof b.did !== 'string' || b.did !== this.ownerDid()) return refuse(403, 'DID_MISMATCH', "did must equal the authenticated identity's DID.");
    if (!Array.isArray(b.supported_versions) || !b.supported_versions.includes('0.8')) return refuse(426, 'VERSION_UNSUPPORTED', 'An account with a device chain is granted protocol v0.8 mandates only.');
    if (typeof b.authorization_id !== 'string' || !AUTHZ.test(b.authorization_id)) return refuse(400, 'MALFORMED_MANDATE', 'Invalid authorization_id: expected "authz_<uuid>" format.');
    if (b.replaces !== undefined && (typeof b.replaces !== 'string' || !AUTHZ.test(b.replaces))) return refuse(400, 'MALFORMED_MANDATE', 'Invalid replaces: expected "authz_<uuid>" format.');
    if (b.mandate_id === undefined || b.mandate_version === undefined) return refuse(403, 'MANDATE_GRANT_REQUIRED', 'This account has a device chain: a mandate is granted on a device first, and the request names that mandate_id and mandate_version.');
    if (typeof b.mandate_id !== 'string' || !MANDATE_ID.test(b.mandate_id) || !Number.isSafeInteger(b.mandate_version) || b.mandate_version < 1) return refuse(400, 'MALFORMED_MANDATE', 'mandate_id must be the id the grant names and mandate_version an integer from 1.');
    if (b.ttl !== undefined) return refuse(400, 'MALFORMED_MANDATE', 'A mandate for an account with a device chain carries the expires_at the owner granted, not a ttl.');
    if (typeof b.profile_id !== 'string' || b.profile_id !== this.profile.id) return refuse(400, 'PROFILE_NOT_FOUND', `Unknown profile: ${String(b.profile_id)}`);
    if (b.profile_hash !== computeProfileHash(this.profile as never)) return refuse(409, 'PROFILE_HASH_MISMATCH', 'profile_hash does not match');
    // the AS fills in nothing: the team's settings must be what the request says
    const e = this.expectation;
    const eMode = e?.mode ?? b.commitment_mode;
    const carries = e?.approvers !== undefined;
    if (eMode !== b.commitment_mode || (carries && !(jcs(e!.caps ?? null) === jcs(b.above_cap_caps ?? null) && jcs([...(b.above_cap_approvers ?? [])].sort()) === jcs([...e!.approvers!].sort()) && e!.approvals === b.above_cap_approvals))) {
      return refuse(400, 'MALFORMED_MANDATE', `The team settings require commitment_mode "${eMode}" ${carries ? `with above_cap_caps ${JSON.stringify(e!.caps)}, above_cap_approvers (${e!.approvers!.length}) and above_cap_approvals ${String(e!.approvals)}` : ''}, but the mandate asks for something else.`);
    }
    if (b.mandate_owners === undefined || !Array.isArray(b.mandate_owners) || b.mandate_owners.length !== 1 || Object.keys(b.mandate_owners[0]).some(k => k !== 'did') || b.mandate_owners[0].did !== b.did) {
      return refuse(400, 'MALFORMED_MANDATE', 'For an account with a device chain, mandate_owners[0] names only did.');
    }
    const now = this.now();
    if (typeof b.expires_at !== 'number') return refuse(400, 'MALFORMED_MANDATE', 'A mandate for an account with a device chain requires expires_at — the grant covers the expiry; the AS may not invent it.');
    if (b.expires_at <= now) return refuse(422, 'MALFORMED_MANDATE', 'expires_at is already in the past. Grant the mandate again with a later expiry.');
    if (b.expires_at > now + (this.profile.ttl.max as number)) return refuse(422, 'MALFORMED_MANDATE', 'expires_at beyond the profile maximum');
    const bounds = b.bounds as Record<string, string | number>;
    const boundsHash = computeBoundsHash(bounds as never, this.profile as never);
    const intentDisclosureHash = typeof b.intent_ciphertext === 'string' ? computeIntentDisclosureHash(b.intent_ciphertext, b.approvers_frozen as string[]) : undefined;
    const subjects = this.identity.verified && (b.disclose_identity === true || this.identity.always);
    const approvers = carries ? e!.approvers! : null;
    const chainDids = [...new Set([b.did as string, ...(approvers ?? [])])].filter(d => this.hasChain(d)).sort();
    const payload = {
      mandate_id: b.mandate_id, version: '0.8', profile_id: b.profile_id, bounds_hash: boundsHash, scope_hash: b.scope_hash,
      execution_context_hash: b.execution_context_hash, profile_hash: b.profile_hash, issuer: this.as.issuerDid,
      mandate_owners: [{ did: b.did }], gate_content_hashes: b.gate_content_hashes,
      ...(subjects ? { subjects: [{ did: b.did, assurance: 'high', method: 'x', trust_root: 'x', verifier: 'x', disclose: { name: 'N' }, verified_at: 1 }] } : {}),
      ...(intentDisclosureHash ? { intent_disclosure_hash: intentDisclosureHash } : {}),
      commitment_mode: eMode,
      ...(carries ? { above_cap_caps: e!.caps, above_cap_approvers: e!.approvers, ...(e!.approvals !== undefined ? { above_cap_approvals: e!.approvals } : {}) } : {}),
      issued_at: now, expires_at: b.expires_at,
    } as unknown as MandatePayload;
    // the grant must hold for exactly what is signed: written out by hand (never the gateway's derivation)
    const rows = this.grantsOf(b.mandate_id);
    if (rows.length === 0) return refuse(403, 'MANDATE_GRANT_REQUIRED', 'This mandate has no grant. A mandate for an account with a device chain is granted on a device first.');
    if (rows.some(r => r.userId !== session.userId)) return refuse(403, 'MANDATE_GRANT_REQUIRED', 'The grants stored for this mandate are not the owner\'s.');
    if (rows.some(r => r.op === 'revoke')) return refuse(403, 'MANDATE_REVOKED', 'This mandate was revoked on a device.');
    const newest = rows.filter(r => r.op !== 'revoke').sort((a, z) => z.version - a.version)[0];
    if (b.mandate_version !== newest.version) return refuse(403, 'MANDATE_GRANT_REQUIRED', `The newest grant of this mandate is version ${newest.version}; the request names ${b.mandate_version}.`, { reason: 'GRANT_VERSION_REFUSED' });
    const fields = {
      version: '0.8', profile_id: b.profile_id, profile_hash: b.profile_hash, bounds_hash: boundsHash, scope_hash: b.scope_hash, execution_context_hash: b.execution_context_hash,
      gate_content_hashes: b.gate_content_hashes, commitment_mode: eMode, expires_at: b.expires_at, intent_disclosure_hash: intentDisclosureHash ?? null,
      above_cap_caps: carries ? e!.caps ?? null : null, above_cap_approvers: approvers, above_cap_approvals: carries ? e!.approvals ?? null : null,
      disclose_fields: null, subjects_disclosed: subjects, authorization_id: b.authorization_id, group_id: b.group_id, replaces: b.replaces ?? null, chain_dids: chainDids,
    };
    try {
      await verifyGrant({ grant: newest.grant, sig: newest.sig, check: newest.check ?? undefined }, { chain: await this.chain(), mandateFields: fields, expect: { ops: [newest.op], mandate_id: b.mandate_id, mandate_version: newest.version } });
    } catch (err) {
      if (!(err instanceof DeviceKeysError)) throw err;
      return refuse(403, 'MANDATE_GRANT_REQUIRED', `The stored grant does not hold for this mandate: ${err.message}`, { reason: err.code });
    }
    const blob = encodeMandateBlob(await signMandate(payload, this.as.signingSeed));
    for (const i of this.issued) if (i.mandateId === b.mandate_id && i.version < newest.version && i.authorizationId !== b.authorization_id) i.revoked = true;
    this.issued.push({ authorizationId: b.authorization_id, mandateId: b.mandate_id, version: newest.version, blob, payload, groupId: b.group_id, revoked: false });
    return ok(201, { authorization_id: b.authorization_id, mandate_version: newest.version, bounds_hash: boundsHash, commitment_mode: eMode });
  }
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export { decodeMandateBlob };
