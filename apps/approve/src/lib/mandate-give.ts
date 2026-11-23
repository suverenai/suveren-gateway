/**
 * Giving a mandate on the phone (device-keys plan 4.4, DEC-47, DEC-85/86/88; mockup phone-d3-live.html A2, A4/A5).
 *
 * A computer of this person prepared the give and sealed it to the person's devices (`POST /api/mandates/prepared`, the gateway's
 * `sendToPhone`). The phone opens it with its own key and offers the touch only when everything it would sign is what it shows:
 *
 *   from      the preparing device is an active device of THIS phone's verified chain, not the phone itself
 *   owner     the mandate is this person's own (its owner is the chain's root DID)
 *   hashes    profile, limits, scope, intent and the execution-context hash are recomputed HERE from the plaintext shown, with
 *             hap-core's own functions (give-hashes.ts), and must equal the mandate the Authority Server will sign
 *   place     the authorization id, the group, `replaces` and `chain_dids` (the owner, every above-cap approver, nobody else)
 *   version   a first give is version 1 and nothing is granted under that mandate id yet; a change follows the newest grant
 *   time      the mandate has not run out
 *
 * The grant's members are then rebuilt HERE from that mandate with the gateway's own rule (`createGrantMembers`), signed with the
 * phone's device key and checked with its passkey over exactly that grant (one touch). The computer accepts it only with exactly
 * the members it planned. What the phone cannot check: whether the approvers named are the person's colleagues (the computer checks
 * the team's member list), and the intent sealed to the approvers (`intent_disclosure_hash`).
 *
 * After the grant the phone reads the gateways' receipts (DEC-23): "Signed" once one of the person's computers verified the grant,
 * otherwise the one "not received yet" state with Check again.
 */
import { buildMandateProjection, type AgentProfile, type MandatePayload } from '@hap/core/browser';
import {
  activeDevices, b64uEncode, buildGrant, objectHash, randomBytes, signedBytes, verifyGrant, verifyReceipt,
  type ChainState, type MandateGrant,
} from '@hap/core/device-keys';
import { createGrantMembers, GRANT_FIXED_MEMBERS } from '@hap/core/mandate-grant';
import { computeMandateDiff, type MandateDiff } from '@hap/core/mandate-change';
import { Driver } from './driver';
import { giveHashes } from './give-hashes';
import { openSealedObject } from './content';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceSession } from './session';
import { errorText } from '../texts';

const { grantMembersOf } = createGrantMembers(buildMandateProjection);
const AUTHZ = /^authz_[0-9a-f-]{36}$/;
const MANDATE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalars = (v: unknown): v is Record<string, string | number> =>
  isObj(v) && Object.keys(v).length <= 64 && Object.values(v).every((x) => typeof x === 'string' ? x.length <= 4000 : typeof x === 'number' && Number.isFinite(x));

/** A give this phone checked, ready to be shown and signed. */
export interface GiveItem {
  /** The list key: `give:<mandate id>:<version>`. */
  key: string;
  mandateId: string;
  version: number;
  op: 'grant' | 'change';
  /** The label of the computer that prepared it, from this phone's verified chain. */
  preparedBy: string;
  preparedAt: number;
  title: string;
  profile: AgentProfile;
  bounds: Record<string, string | number>;
  scope: Record<string, string | number>;
  intent: string;
  payload: MandatePayload;
  /** The members the phone signs: rebuilt here. */
  members: Record<string, unknown>;
  expiresAt: number;
  /** Seconds the mandate lasts from now (shown as the duration). */
  lastsSeconds: number;
  /** A change: the version it continues, as checked against that version's grant, and the diff shown (old values crossed out). */
  previous?: { bounds: Record<string, string | number>; scope: Record<string, string | number>; intent: string; expiresAt: number; profile: AgentProfile };
  diff?: MandateDiff;
  /** A renewal: only the end date moves (checked); shown as "Extend the mandate for …". */
  renewal?: boolean;
  /** The AI proposal this give carries out (setup__create_mandate / setup__change_mandate), as the computer named it: the give is shown
   *  in that request's place, and the request is closed once it is given. Never part of what is signed. */
  proposalId?: string;
}

export type GiveCode =
  | 'give_unreadable' | 'give_not_own' | 'give_from_unknown_device' | 'give_hash_mismatch' | 'give_place_invalid'
  | 'give_expired' | 'give_version_invalid' | 'give_change_unsupported' | 'give_previous_mismatch' | 'give_renewal_is_a_change';
export type GiveCheck = { ok: true; item: GiveItem } | { ok: false; code: GiveCode; mandateId?: string };

/** A row of `GET /api/mandates/prepared`, as far as the phone reads it. */
export interface PreparedRow { mandate_id?: unknown; mandate_version?: unknown; submitted_by_key_id?: unknown; ciphertext?: unknown; device_key?: unknown }
/** A row of `GET /api/mandates/:id/grants`. */
export interface GrantRowLike { mandate_version?: unknown; op?: unknown; grant?: unknown; sig?: unknown; check?: unknown }

/**
 * Check one opened give against this phone's own verified chain (the rules in the file header). Pure apart from the hashing.
 * `grants`: the grants already stored under that mandate id (the version rule).
 */
export async function checkGive(content: Record<string, unknown>, row: PreparedRow, ctx: { chain: ChainState; ownKeyId: string; now: number; grants: GrantRowLike[] }): Promise<GiveCheck> {
  const bad = (code: GiveCode): GiveCheck => ({ ok: false, code, ...(typeof row.mandate_id === 'string' ? { mandateId: row.mandate_id } : {}) });
  const g = content.give;
  if (content.v !== 2 || !isObj(g) || content.mandate_id !== row.mandate_id || content.mandate_version !== row.mandate_version
    || typeof content.mandate_id !== 'string' || !MANDATE_ID.test(content.mandate_id) || !Number.isSafeInteger(content.mandate_version) || (content.mandate_version as number) < 1
    || !isScalars(content.scope) || typeof content.intent !== 'string' || content.intent.length > 20_000
    || (g.op !== 'grant' && g.op !== 'change') || !isObj(g.profile) || !isScalars(g.bounds) || !isObj(g.payload) || !isObj(g.place)
    || typeof g.title !== 'string' || typeof g.prepared_at !== 'number') return bad('give_unreadable');
  const mandateId = content.mandate_id;
  const version = content.mandate_version as number;
  const profile = g.profile as unknown as AgentProfile;
  const payload = g.payload as unknown as MandatePayload;
  const place = g.place as Record<string, unknown>;

  // from: a device of this phone's own chain, not this phone
  const from = typeof row.submitted_by_key_id === 'string' ? ctx.chain.devices[row.submitted_by_key_id] : undefined;
  const active = new Set(activeDevices(ctx.chain).map((d) => d.key_id));
  if (!from || !active.has(from.key_id) || from.key_id === ctx.ownKeyId) return bad('give_from_unknown_device');

  // owner: this person
  const owner = payload.mandate_owners?.[0]?.did;
  if (payload.mandate_id !== mandateId || owner !== ctx.chain.root_did || (payload.mandate_owners ?? []).length !== 1) return bad('give_not_own');

  // hashes: recomputed here from what is shown
  let h;
  try {
    h = giveHashes({ profile, bounds: g.bounds as Record<string, string | number>, scope: content.scope as Record<string, string | number>, intent: content.intent });
  } catch { return bad('give_hash_mismatch'); }
  if (payload.profile_id !== profile.id || payload.profile_hash !== h.profile || payload.bounds_hash !== h.bounds || payload.scope_hash !== h.scope
    || payload.gate_content_hashes?.intent !== h.intent || payload.execution_context_hash !== h.executionContext) return bad('give_hash_mismatch');

  // place: where the grant lives, and chain_dids exactly the owner plus every above-cap approver
  const approvers = Array.isArray(payload.above_cap_approvers) ? payload.above_cap_approvers : [];
  const dids = place.chain_dids;
  if (typeof place.authorization_id !== 'string' || !AUTHZ.test(place.authorization_id) || typeof place.group_id !== 'string' || !place.group_id
    || (place.replaces !== null && (typeof place.replaces !== 'string' || !AUTHZ.test(place.replaces)))
    || !Array.isArray(dids) || dids.some((x) => typeof x !== 'string') || !dids.includes(owner)
    || approvers.some((a) => !dids.includes(a)) || dids.some((x) => x !== owner && !approvers.includes(x))) return bad('give_place_invalid');

  // time
  if (typeof payload.expires_at !== 'number' || payload.expires_at <= ctx.now) return bad('give_expired');

  // version: a first give is v1 under an unused id; a change is shown only from a give that names the previous one (not built yet)
  const stored = ctx.grants.filter((r) => r.op === 'grant' || r.op === 'change' || r.op === 'revoke');
  let previous: GiveItem['previous'];
  let diff: MandateDiff | undefined;
  if (g.op === 'grant') {
    if (version !== 1 || stored.length > 0) return bad('give_version_invalid');
  } else {
    // A change: shown only with the version it continues, and only when that version's grant verifies against THIS phone's chain
    // and carries exactly the hashes recomputed here from the previous values the computer sent (what is crossed out is what was signed).
    // A renewal (DEC-90) is a change that moves only the end date: checked the same way, then everything but the end must be unchanged.
    const renewal = g.renewal === true;
    const pv = g.previous;
    if (!isObj(pv) || !isObj(pv.profile) || !isScalars(pv.bounds) || !isScalars(pv.scope) || typeof pv.intent !== 'string' || pv.intent.length > 20_000
      || typeof pv.expires_at !== 'number' || pv.mandate_version !== version - 1) return bad('give_previous_mismatch');
    if (stored.some((r) => r.op === 'revoke')) return bad('give_version_invalid');
    const live = stored.filter((r) => typeof r.mandate_version === 'number' && isObj(r.grant));
    const newest = live.reduce<GrantRowLike | null>((a, r) => (!a || (r.mandate_version as number) > (a.mandate_version as number) ? r : a), null);
    if (!newest || newest.mandate_version !== version - 1) return bad('give_version_invalid');
    const pg = newest.grant as Record<string, unknown>;
    const fixed = new Set(GRANT_FIXED_MEMBERS);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pg)) if (!fixed.has(k)) fields[k] = v;
    try {
      await verifyGrant({ grant: pg, sig: newest.sig, check: newest.check ?? undefined }, { chain: ctx.chain, mandateFields: fields, expect: { ops: ['grant', 'change'], mandate_id: mandateId, mandate_version: version - 1 } });
    } catch { return bad('give_previous_mismatch'); }
    let ph;
    try {
      ph = giveHashes({ profile: pv.profile as unknown as AgentProfile, bounds: pv.bounds, scope: pv.scope, intent: pv.intent });
    } catch { return bad('give_previous_mismatch'); }
    const gch = isObj(pg.gate_content_hashes) ? pg.gate_content_hashes : {};
    if (pg.profile_id !== (pv.profile as { id?: unknown }).id || pg.profile_hash !== ph.profile || pg.bounds_hash !== ph.bounds || pg.scope_hash !== ph.scope
      || gch.intent !== ph.intent || pg.expires_at !== pv.expires_at) return bad('give_previous_mismatch');
    if (renewal) {
      // The same authorization, `replaces` as it was; the same profile, limits, scope and intent as the version it continues; a later end.
      if (place.authorization_id !== pg.authorization_id || place.replaces !== (typeof pg.replaces === 'string' ? pg.replaces : null)) return bad('give_place_invalid');
      if (payload.profile_hash !== pg.profile_hash || payload.bounds_hash !== pg.bounds_hash || payload.scope_hash !== pg.scope_hash
        || payload.gate_content_hashes?.intent !== gch.intent || payload.commitment_mode !== pg.commitment_mode) return bad('give_renewal_is_a_change');
      if (payload.expires_at <= (pg.expires_at as number)) return bad('give_renewal_is_a_change');
    } else if (place.replaces !== pg.authorization_id) {
      // The change takes over from the authorization the previous version lives under.
      return bad('give_place_invalid');
    }
    previous = { bounds: pv.bounds, scope: pv.scope, intent: pv.intent, expiresAt: pv.expires_at, profile: pv.profile as unknown as AgentProfile };
    try {
      diff = computeMandateDiff({
        before: { profile: previous.profile as never, bounds: previous.bounds, scope: previous.scope, intent: previous.intent, mode: String(pg.commitment_mode ?? ''), expiresAt: previous.expiresAt },
        after: { profile: profile as never, bounds: g.bounds as Record<string, string | number>, scope: content.scope as Record<string, string | number>, intent: content.intent, mode: String(payload.commitment_mode ?? ''), expiresAt: payload.expires_at },
      });
    } catch { return bad('give_previous_mismatch'); }
  }

  let members: Record<string, unknown>;
  try {
    members = grantMembersOf(payload, { authorizationId: place.authorization_id, groupId: place.group_id, replaces: place.replaces as string | null, chainDids: [...(dids as string[])].sort() });
  } catch { return bad('give_place_invalid'); }
  return {
    ok: true,
    item: {
      key: `give:${mandateId}:${version}`, mandateId, version, op: g.op, preparedBy: from.label, preparedAt: g.prepared_at as number,
      title: (g.title as string).trim() || profile.name || profile.id, profile, bounds: g.bounds as Record<string, string | number>,
      scope: content.scope as Record<string, string | number>, intent: content.intent, payload, members,
      expiresAt: payload.expires_at, lastsSeconds: Math.max(0, payload.expires_at - ctx.now),
      ...(previous ? { previous } : {}), ...(diff ? { diff } : {}), ...(g.op === 'change' && g.renewal === true ? { renewal: true } : {}),
      ...(typeof g.proposal_id === 'string' && PROPOSAL_ID.test(g.proposal_id) ? { proposalId: g.proposal_id } : {}),
    },
  };
}

export interface GiveDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  api: AsApi;
  accounts: AccountStore;
  session: DeviceSession;
  now: () => number;
  /** How often and how long the phone looks for a computer's receipt right after the grant. */
  receiptPoll?: { tries: number; everyMs: number };
  /** After "not received": asking on by itself (tests set it short). */
  receiptLater?: { tries: number; everyMs: number };
}

/** The gives waiting for this phone, each checked; the ones that fail a check come back with their code (never shown as a give). */
export async function readGives(d: Pick<GiveDeps, 'keys' | 'api' | 'accounts' | 'session' | 'now'>): Promise<{ ok: true; items: GiveItem[]; refused: GiveCheck[] } | { ok: false; code: string }> {
  const s = d.session.current();
  const bearer = d.session.bearer();
  const account = await d.accounts.read();
  if (!s || !bearer || !account) return { ok: false, code: 'session_ended' };
  const r = await d.api.prepared(bearer);
  if (!r.ok) return { ok: false, code: r.status === 401 ? 'session_ended' : r.code };
  const items: GiveItem[] = [];
  const refused: GiveCheck[] = [];
  for (const raw of Array.isArray(r.data.prepared) ? r.data.prepared : []) {
    const row = (isObj(raw) ? raw : {}) as PreparedRow;
    let content: Record<string, unknown>;
    try { content = await openSealedObject(row.ciphertext, row.device_key, d.keys); } catch { refused.push({ ok: false, code: 'give_unreadable' }); continue; }
    // A v1 body is a mandate's body (granted on a computer, waiting for its body window), not a give: nothing to do here.
    if (content.v === 1) continue;
    const grants = typeof row.mandate_id === 'string' ? await d.api.grants(row.mandate_id, bearer) : null;
    const rows = grants && grants.ok && Array.isArray(grants.data.grants) ? grants.data.grants.filter(isObj) as GrantRowLike[] : [];
    const c = await checkGive(content, row, { chain: s.chain, ownKeyId: account.key_id, now: d.now(), grants: rows });
    if (c.ok) items.push(c.item); else refused.push(c);
  }
  items.sort((a, b) => a.preparedAt - b.preparedAt);
  return { ok: true, items, refused };
}

/** Has one of this person's computers answered this grant with a receipt that verifies against the phone's chain? */
export async function receivedBy(d: Pick<GiveDeps, 'api' | 'session'>, grant: MandateGrant): Promise<string | null> {
  const s = d.session.current();
  const bearer = d.session.bearer();
  if (!s || !bearer) return null;
  const r = await d.api.receipts(grant.mandate_id, bearer);
  if (!r.ok || !Array.isArray(r.data.receipts)) return null;
  for (const e of r.data.receipts) {
    if (!isObj(e)) continue;
    try {
      const rec = await verifyReceipt({ receipt: e.receipt, sig: e.sig }, { chain: s.chain, grant });
      const dev = s.chain.devices[rec.key_id];
      if (dev && dev.kind === 'gateway') return dev.label;
    } catch { /* a receipt that does not verify counts for nothing */ }
  }
  return null;
}

export type GiveState =
  | { step: 'idle' }
  | { step: 'review'; item: GiveItem }
  | { step: 'checking'; item: GiveItem; error?: string }
  | { step: 'sending'; item: GiveItem }
  | { step: 'signed'; item: GiveItem; receivedBy: string }
  | { step: 'not_received'; item: GiveItem; grant: MandateGrant; checking: boolean; checkedOnce: boolean }
  | { step: 'failed'; item: GiveItem | null; error: string };

/** How long the phone waits for the computer's receipt before it says "not received yet": a minute, asked every 2 seconds. */
export const GIVE_RECEIPT_WAIT = { tries: 30, everyMs: 2000 };
/** After that, it asks on by itself every 5 seconds for ten minutes. */
export const GIVE_RECEIPT_LATER = { tries: 120, everyMs: 5000 };

export class GiveDriver extends Driver<GiveState> {
  private gen = 0;

  constructor(private readonly d: GiveDeps) {
    super({ step: 'idle' });
  }

  open(item: GiveItem): void {
    this.gen++;
    this.set({ step: 'review', item });
  }

  close(): void {
    this.gen++;
    this.set({ step: 'idle' });
  }

  /** Cancel while the touch is asked (or after it failed): back to the review; a late answer sends nothing. */
  cancelTouch(): void {
    const st = this.state;
    if (st.step !== 'checking') return;
    this.gen++;
    this.set({ step: 'review', item: st.item });
  }

  /** The touch over exactly the grant, then sign and store it. Also "Try again" after a failed touch. */
  async give(): Promise<void> {
    const st = this.state;
    if (!(st.step === 'review' || (st.step === 'checking' && st.error))) return;
    const item = st.item;
    const gen = ++this.gen;
    this.set({ step: 'checking', item });
    const d = this.d;
    try {
      const s = d.session.current();
      const bearer = d.session.bearer();
      const account = await d.accounts.read();
      if (!s || !bearer || !account) { this.set({ step: 'failed', item, error: errorText('session_ended') }); return; }
      if (item.expiresAt <= d.now()) { this.set({ step: 'failed', item, error: errorText('give_expired') }); return; }
      const grant = buildGrant({
        op: item.op, owner_did: account.root_did, key_id: account.key_id, chain_seq: s.chain.head.seq, chain_head: s.chain.head.hash,
        mandate_id: item.mandateId, mandate_version: item.version, granted_at: d.now(), nonce: b64uEncode(randomBytes(16)),
      }, item.members) as MandateGrant;
      const proof = await d.check.prove(account.check.cred_id, await objectHash(grant));
      if (gen !== this.gen) return;
      this.set({ step: 'sending', item });
      const sig = b64uEncode(await d.keys.sign(signedBytes(grant)));
      // The same check the Authority Server and the computer make, here first.
      await verifyGrant({ grant, sig, check: proof }, { chain: s.chain, mandateFields: item.members, expect: { ops: [item.op], mandate_id: item.mandateId, mandate_version: item.version } });
      const res = await d.api.postGrant(item.mandateId, { grant, sig, check: proof }, bearer);
      d.session.noteUse();
      if (gen !== this.gen) return;
      if (!res.ok) {
        this.set({ step: 'failed', item, error: errorText(res.status === 0 ? 'as_unreachable' : res.code) });
        return;
      }
      await this.waitForReceipt(item, grant, gen);
    } catch (e) {
      if (gen !== this.gen) return;
      if (e instanceof CheckError) { this.set({ step: 'checking', item, error: errorText(e.code === 'failed' ? 'check_failed' : e.code) }); return; }
      this.set({ step: 'failed', item, error: errorText('generic') });
    }
  }

  /**
   * The computer takes a phone's grant in on its own (the gateway checks waiting gives every 5 seconds, then requests the mandate and
   * answers with its receipt): usually 5 to 15 seconds. Until then the phone keeps "Signing…" and asks every 2 seconds; only after a
   * minute without a receipt does it say the computer has not received it (dev lane 2026-11-23: after 4 seconds it said so, the
   * person tried again, and the gateway had it a few seconds later). Then it goes on asking by itself for ten minutes, so the state
   * turns to "received" when the computer is opened again, without a tap.
   */
  private async waitForReceipt(item: GiveItem, grant: MandateGrant, gen: number): Promise<void> {
    const poll = this.d.receiptPoll ?? GIVE_RECEIPT_WAIT;
    for (let i = 0; i < poll.tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, poll.everyMs));
      if (gen !== this.gen) return;
      const by = await receivedBy(this.d, grant);
      if (by) { this.set({ step: 'signed', item, receivedBy: by }); return; }
    }
    if (gen !== this.gen) return;
    this.set({ step: 'not_received', item, grant, checking: false, checkedOnce: false });
    const later = this.d.receiptLater ?? GIVE_RECEIPT_LATER;
    for (let i = 0; i < later.tries; i++) {
      await new Promise((r) => setTimeout(r, later.everyMs));
      const st = this.state;
      if (gen !== this.gen || st.step !== 'not_received') return;
      if (st.checking) continue;
      const by = await receivedBy(this.d, grant);
      if (gen !== this.gen || this.state.step !== 'not_received') return;
      if (by) { this.set({ step: 'signed', item, receivedBy: by }); return; }
    }
  }

  /** "Check again" in the not-received state. */
  async checkAgain(): Promise<void> {
    const st = this.state;
    if (st.step !== 'not_received' || st.checking) return;
    const gen = this.gen;
    this.set({ ...st, checking: true });
    const by = await receivedBy(this.d, st.grant);
    if (gen !== this.gen) return;
    if (by) this.set({ step: 'signed', item: st.item, receivedBy: by });
    else this.set({ ...st, checking: false, checkedOnce: true });
  }
}
