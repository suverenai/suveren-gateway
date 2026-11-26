/**
 * Ending a mandate on the phone (device-keys plan 4.4 "Who signs": a `revoke` may be signed by any active device, without a check;
 * mockup B2, DEC-88). Final: a revoked mandate stays revoked.
 *
 * The list is this person's own authorizations (`GET /api/mandates/mine`), each checked the way a card is: the signed mandate under the
 * pinned Authority Server key, the owner is this person, and the newest grant of exactly that mandate verifies against THIS phone's
 * chain (grant-check.ts). Only those are offered. The revoke names the members of that verified grant (what the owner granted, not what
 * the Authority Server says) and is signed with the phone's device key; no touch (S13 screen 4: "You do not need your touch").
 */
import { profileIdentity } from '@suveren/approval-card/lib/profile-identity';
import {
  b64uEncode, buildGrant, randomBytes, signedBytes, verifyGrant, verifyReceipt, type MandateGrant,
} from '@hap/core/device-keys';
import { GRANT_FIXED_MEMBERS } from '@hap/core/mandate-grant';
import type { MandatePayload } from '@hap/core/browser';
import { Driver } from './driver';
import { verifyMandateBlob } from './mandate-check';
import { checkGrant, grantRowsOf } from './grant-check';
import type { DeviceKeyStore } from './key-store';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceSession } from './session';
import { errorText } from '../texts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface OwnMandate {
  authorizationId: string;
  mandateId: string;
  version: number;
  title: string;
  expiresAt: number;
  /** The commitment of the signed mandate (`review` / `automatic` / `review_above_cap`): the badge in the list. */
  mode: string | null;
  /** The members of the newest verified grant: what the revoke names. */
  fields: Record<string, unknown>;
  /** The device of this chain that gave that grant, when it is not this phone (the notice "given on …", mockup F2); else null. */
  givenOn: string | null;
  givenAt: number | null;
  /**
   * On-hold mockup v2, case 2: given on THIS phone at least 10 minutes ago (and within the last day), and none of the person's
   * computers has answered with a receipt that verifies: that computer's name. Null otherwise.
   */
  notReceivedBy?: string | null;
  /** When this phone gave it (seconds), for "Given N minutes ago"; set together with `notReceivedBy`. */
  givenHereAt?: number | null;
}

/**
 * A mandate of this person the phone cannot honour after its own check (On-hold mockup v2): the check's code, mapped by the shared
 * `heldReason`. Only own mandates whose signed copy verifies under the pinned Authority Server key; anything else says nothing.
 */
export interface HeldOwn { authorizationId: string; title: string; profileName: string; code: string }

/** How long after the phone's own give the "not received yet" note may appear (mockup v2, case 2: a proposal). */
export const NOT_RECEIVED_NOTE_AFTER_S = 600;

/** A mandate of this person that another device of the chain ended (the notice "ended on …", mockup F2): the revoke verified here. */
export interface EndedElsewhere { title: string; by: string; at: number }

export interface EndDeps { keys: DeviceKeyStore; api: AsApi; accounts: AccountStore; session: DeviceSession; now: () => number }

/** This person's mandates the phone can end: each one checked (the file header). */
export async function readOwnMandates(d: EndDeps): Promise<{ ok: true; items: OwnMandate[]; ended: EndedElsewhere[]; held: HeldOwn[] } | { ok: false; code: string }> {
  const s = d.session.current();
  const bearer = d.session.bearer();
  const account = await d.accounts.read();
  if (!s || !bearer || !account) return { ok: false, code: 'session_ended' };
  const mine = await d.api.mine(bearer);
  if (!mine.ok) return { ok: false, code: mine.status === 401 ? 'session_ended' : mine.code };
  const items: OwnMandate[] = [];
  const ended: EndedElsewhere[] = [];
  const held: HeldOwn[] = [];
  // The gateway's Mandates page title: the mandate's own title, else the area's display name (the shared profileIdentity fallback chain).
  const titleOf = (row: Record<string, unknown>) => typeof row.title === 'string' && row.title.trim() ? row.title.trim() : (typeof row.profileId === 'string' ? profileIdentity(row.profileId).name : 'a mandate');
  for (const row of Array.isArray(mine.data.mandates) ? mine.data.mandates : []) {
    if (!isObj(row) || typeof row.authorization_id !== 'string') continue;
    if (row.status === 'revoked') {
      const e = await endedElsewhere(d, row, titleOf(row), { chain: s.chain, ownKeyId: account.key_id, rootDid: account.root_did, bearer, asKey: account.as_key });
      if (e) ended.push(e);
      continue;
    }
    if (row.status === 'expired') continue;
    const authorizationId = row.authorization_id;
    const m = await d.api.mandates(authorizationId, bearer);
    if (!m.ok || m.data.revoked) continue;
    let full: MandatePayload | null = null;
    for (const e of Array.isArray(m.data.mandates) ? m.data.mandates : []) {
      if (!isObj(e) || typeof e.blob !== 'string') continue;
      const v = await verifyMandateBlob(e.blob, account.as_key, d.now());
      if (v.ok && (!full || v.full.issued_at > full.issued_at)) full = v.full;
    }
    if (!full || full.mandate_owners?.[0]?.did !== account.root_did) continue;
    const g = await d.api.grants(full.mandate_id, bearer);
    const rows = g.ok ? grantRowsOf(g.data) : null;
    if (!rows) continue;
    const heldAs = (code: string) => held.push({ authorizationId, title: titleOf(row), profileName: typeof row.profileId === 'string' ? profileIdentity(row.profileId).name : 'a mandate', code });
    if (rows.length === 0) { heldAs('mandate_not_granted'); continue; }
    const verdict = await checkGrant({ payload: full, authorizationId, chain: s.chain, rows }).catch(() => null);
    if (!verdict) continue;
    if (!verdict.ok) { heldAs(verdict.code); continue; }
    const granted = rows.find((r) => r.mandate_version === verdict.version && (r.op === 'grant' || r.op === 'change') && isObj(r.grant));
    if (!granted) continue;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(granted.grant as Record<string, unknown>)) if (!(GRANT_FIXED_MEMBERS as readonly string[]).includes(k)) fields[k] = v;
    const title = titleOf(row);
    const g0 = granted.grant as Record<string, unknown>;
    const by = typeof g0.key_id === 'string' && g0.key_id !== account.key_id ? s.chain.devices[g0.key_id] ?? null : null;
    // Given here: has a computer taken it in? Asked only between 10 minutes and a day after the give (mockup v2, case 2).
    let notReceivedBy: string | null = null;
    let givenHereAt: number | null = null;
    const at = typeof g0.granted_at === 'number' ? g0.granted_at : null;
    const age = at === null ? -1 : d.now() - at;
    if (g0.key_id === account.key_id && age >= NOT_RECEIVED_NOTE_AFTER_S && age < 86400) {
      const r = await d.api.receipts(full.mandate_id, bearer).catch(() => null);
      let received = false;
      for (const e of r && r.ok && Array.isArray(r.data.receipts) ? r.data.receipts : []) {
        if (!isObj(e)) continue;
        try { const rec = await verifyReceipt({ receipt: e.receipt, sig: e.sig }, { chain: s.chain, grant: g0 as unknown as MandateGrant }); if (s.chain.devices[rec.key_id]?.kind === 'gateway') { received = true; break; } } catch { /* counts for nothing */ }
      }
      if (r && r.ok && !received) {
        const computer = Object.values(s.chain.devices).find((x) => x.kind === 'gateway' && x.removed_seq == null);
        if (computer) { notReceivedBy = computer.label; givenHereAt = at; }
      }
    }
    items.push({
      authorizationId, mandateId: full.mandate_id, version: verdict.version, title, expiresAt: full.expires_at, mode: typeof full.commitment_mode === 'string' ? full.commitment_mode : null, fields,
      givenOn: by ? by.label : null, givenAt: by && typeof g0.granted_at === 'number' ? g0.granted_at : null,
      notReceivedBy, givenHereAt,
    });
  }
  items.sort((a, b) => a.expiresAt - b.expiresAt);
  return { ok: true, items, ended, held };
}

/**
 * "Ended on <device>": only for a revoke that verifies against THIS phone's chain, signed by another active device of it, for this
 * person's own mandate (the signed mandate under the pinned Authority Server key). A revoke row that does not verify says nothing.
 */
async function endedElsewhere(
  d: EndDeps, row: Record<string, unknown>, title: string,
  ctx: { chain: import('@hap/core/device-keys').ChainState; ownKeyId: string; rootDid: string; bearer: string; asKey: Parameters<typeof verifyMandateBlob>[1] },
): Promise<EndedElsewhere | null> {
  const m = await d.api.mandates(row.authorization_id as string, ctx.bearer);
  if (!m.ok) return null;
  let mandateId: string | null = null;
  for (const e of Array.isArray(m.data.mandates) ? m.data.mandates : []) {
    if (!isObj(e) || typeof e.blob !== 'string') continue;
    // an ended mandate may be past its end: read who owns it and its id, the signature still checked
    const v = await verifyMandateBlob(e.blob, ctx.asKey, 0);
    if (v.ok && v.full.mandate_owners?.[0]?.did === ctx.rootDid) { mandateId = v.full.mandate_id; break; }
  }
  if (!mandateId) return null;
  const g = await d.api.grants(mandateId, ctx.bearer);
  const rows = g.ok ? grantRowsOf(g.data) : null;
  if (!rows) return null;
  for (const r of rows) {
    if (r.op !== 'revoke' || !isObj(r.grant) || typeof r.mandate_version !== 'number') continue;
    const rg = r.grant as Record<string, unknown>;
    if (rg.key_id === ctx.ownKeyId) continue;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rg)) if (!(GRANT_FIXED_MEMBERS as readonly string[]).includes(k)) fields[k] = v;
    try {
      await verifyGrant({ grant: rg, sig: r.sig, check: r.check ?? undefined }, { chain: ctx.chain, mandateFields: fields, expect: { ops: ['revoke'], mandate_id: mandateId, mandate_version: r.mandate_version } });
    } catch { continue; }
    const by = typeof rg.key_id === 'string' ? ctx.chain.devices[rg.key_id] : undefined;
    if (!by) continue;
    return { title, by: by.label, at: typeof rg.granted_at === 'number' ? rg.granted_at : 0 };
  }
  return null;
}

export type EndState =
  | { step: 'idle' }
  | { step: 'confirm'; item: OwnMandate }
  | { step: 'sending'; item: OwnMandate }
  | { step: 'done'; item: OwnMandate }
  | { step: 'failed'; item: OwnMandate; error: string };

export class EndDriver extends Driver<EndState> {
  constructor(private readonly d: EndDeps) {
    super({ step: 'idle' });
  }

  open(item: OwnMandate): void { this.set({ step: 'confirm', item }); }
  close(): void { this.set({ step: 'idle' }); }

  /** Sign the revoke of the newest verified grant and store it. No touch. */
  async end(): Promise<void> {
    const st = this.get();
    if (st.step !== 'confirm' && st.step !== 'failed') return;
    const item = st.item;
    this.set({ step: 'sending', item });
    const d = this.d;
    try {
      const s = d.session.current();
      const bearer = d.session.bearer();
      const account = await d.accounts.read();
      if (!s || !bearer || !account) { this.set({ step: 'failed', item, error: errorText('session_ended') }); return; }
      const grant = buildGrant({
        op: 'revoke', owner_did: account.root_did, key_id: account.key_id, chain_seq: s.chain.head.seq, chain_head: s.chain.head.hash,
        mandate_id: item.mandateId, mandate_version: item.version, granted_at: d.now(), nonce: b64uEncode(randomBytes(16)),
      }, item.fields) as MandateGrant;
      const sig = b64uEncode(await d.keys.sign(signedBytes(grant)));
      await verifyGrant({ grant, sig }, { chain: s.chain, mandateFields: item.fields, expect: { ops: ['revoke'], mandate_id: item.mandateId, mandate_version: item.version } });
      const res = await d.api.postGrant(item.mandateId, { grant, sig }, bearer);
      d.session.noteUse();
      if (!res.ok) { this.set({ step: 'failed', item, error: errorText(res.status === 0 ? 'as_unreachable' : 'end_failed') }); return; }
      this.set({ step: 'done', item });
    } catch {
      this.set({ step: 'failed', item, error: errorText('end_failed') });
    }
  }
}
