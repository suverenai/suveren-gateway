/**
 * A mandate of a chain account is honoured only with a grant its owner's device signed (device-keys plan 4.4,
 * section 7 "new mandate-grant check"; build step 13, computer part).
 *
 * For every mandate blob the Authority Server serves this gateway:
 *   - the OWNER is the DID the signed payload names, never an account id; their chain is verified here from the
 *     genesis on with hap-core against that DID and the head this gateway pinned (lib/device-decisions.ts
 *     `verifiedChain`); a rolled-back or forked chain refuses;
 *   - the grant is one the Authority Server CARRIES; hap-core `verifyGrant` checks it against that chain: the
 *     device's signature, an active device whose check key answered over exactly this grant (a grant without the
 *     check, or with a check over another object, is `CHECK_REQUIRED`), the named chain head, and EVERY member equal to
 *     the members this gateway rebuilds from the SIGNED mandate (`@hap/core/mandate-grant`, the Authority Server's own
 *     derivation). Three members the payload cannot carry (`authorization_id`, `group_id`, `replaces`) and the list of
 *     chain DIDs are the owner's statement and are sanity-checked, not rebuilt: the authorization is the one asked
 *     for, every approver of the payload has a chain (DEC-52, 20.3);
 *   - the highest version verified per mandate is remembered by the control plane; a lower one is refused (the Authority
 *     Server serving an older version again), and a revoke is final;
 *   - a mandate without a grant, or whose grant does not verify, is NOT honoured: no fallback to the unsigned mandate
 *     exists. Its blob is dropped from what the gateway gates with, and no decision is offered under it.
 *   - the owner's own gateway then answers the grant with its signed receipt (the control plane signs and sends it).
 *
 * A gateway with the switch off, or without a device chain of its own, is skipped at once and works exactly as before.
 * Refusals are neutral codes with a short text that names the reason; they never carry a signature, a nonce or a key.
 */

import { decodeMandateBlob, buildMandateProjection, getProfile, computeProfileHash, type MandatePayload } from '@hap/core';
import { createGrantMembers, GRANT_FIXED_MEMBERS } from '@hap/core/mandate-grant';
import {
  deviceKeys, deviceKeysEnabled, verifiedChain, GrantRefused, CpRefused, BodyRefused,
  type DeviceCpClient, type ChainReader,
} from './device-decisions';
import { checkBody, type BodyHold } from './mandate-bodies';

const { grantMembersOf } = createGrantMembers(buildMandateProjection);

export interface GrantedBlob {
  blob: string;
  /** The version of the grant the blob stands on, and its hash. */
  version: number;
  grantHash: string;
  ownerDid: string;
  mandateId: string;
  payload: MandatePayload;
  /** This gateway has not answered this version with its receipt yet (the control plane says so). */
  receiptNeeded: boolean;
  /** The group the owner SIGNED into the grant: what the cache uses as the mandate's group once the grant verified. */
  groupId: string;
}

export type GrantCheck =
  | { ok: true; skipped: true }
  | { ok: true; skipped?: false; granted: GrantedBlob[] }
  | { ok: false; code: string; text: string };

const refuse = (code: string, text: string): GrantCheck => ({ ok: false, code, text });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const AUTHZ = /^authz_[0-9a-f-]{36}$/;
const MANDATE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,128}$/;

export interface GrantGateDeps extends ChainReader {
  sp: ChainReader['sp'] & { getAuthorizationSummary?(id: string): Promise<{ group_id?: string | null } | null>; getMandateGrants(mandateId: string): Promise<Array<{ mandate_version: number; op: string; grant: unknown; sig: unknown; check: unknown }>> };
  cp: DeviceCpClient;
  env?: NodeJS.ProcessEnv;
  /**
   * The hash of this gateway's OWN copy of a profile (undefined when it holds none). A mandate whose `profile_hash` differs from it
   * is refused: the profile in the grant is the one the person was shown.
   */
  localProfileHash?: (profileId: string) => string | undefined;
  /**
   * May a mandate of ANOTHER person (one this person confirmed by identity code) be honoured? Only on the decision path (a colleague's
   * proposal an approver decides on). The gate that admits mandates for this gateway's own gating honours its own person's alone.
   */
  allowConfirmedOwners?: boolean;
  /**
   * Switch on, this gateway has no chain: does the Authority Server know a chain for this account? Its answer can only ADD a
   * refusal (`device_not_set_up_here`); an error or "no" leaves the gateway working as before.
   */
  accountHasChain?: () => Promise<boolean>;
  /**
   * Where a mandate's scope and intent live on this computer (plan 20.19). A mandate is honoured only when what is held matches the
   * hashes of its grant, or a sealed body fetched, opened by this computer's own key and matching them is kept here. Unset: the
   * check is skipped: only for the callers that re-verify a grant for a DECISION (commitments, decision facts) and gate nothing with
   * scope; the gate of the attestation cache (shared-state.ts), where a mandate enters what is gated with, always sets it.
   */
  bodies?: BodyHold;
}

export interface GrantGateInput {
  authorizationId: string;
  attestations: ReadonlyArray<{ blob: string }>;
  /** The group the Authority Server says the authorization belongs to, when this gateway knows it; the grant's own must agree. */
  groupId?: string;
}

/** What a caller holds to check a mandate with. Required wherever a mandate is read for gating or for a decision: a missing gate is a compile error, never a skipped check. */
export type GrantGate = (i: GrantGateInput) => Promise<GrantCheck>;

export function makeGrantGate(deps: Omit<GrantGateDeps, 'localProfileHash' | 'accountHasChain'>): GrantGate {
  const sp = deps.sp as GrantGateDeps['sp'] & { getSessionDid?: () => Promise<string | null> };
  // A definite NO is remembered for five minutes. An error is not an answer: it is not cached and it refuses (see checkMandateGrant).
  let no: number | null = null;
  const accountHasChain = async (): Promise<boolean> => {
    if (no !== null && Date.now() - no < 5 * 60_000) return false;
    const did = await sp.getSessionDid?.();          // throws on any failure
    if (!did) throw new Error('no session did');
    const has = (await sp.getDeviceChain(did)) !== null;   // throws on any failure; null = the Authority Server has none
    if (!has) no = Date.now();
    return has;
  };
  const localProfileHash = (id: string): string | undefined => { try { const p = getProfile(id); return p ? computeProfileHash(p) : undefined; } catch { return undefined; } };
  return i => checkMandateGrant({ ...deps, localProfileHash, accountHasChain }, i);
}

export async function checkMandateGrant(d: GrantGateDeps, i: GrantGateInput): Promise<GrantCheck> {
  if (!deviceKeysEnabled(d.env)) return { ok: true, skipped: true };
  let own: Awaited<ReturnType<DeviceCpClient['chainState']>>;
  try {
    own = await d.cp.chainState();
  } catch {
    // Switch on and the control plane silent: it is not known whether this gateway has a chain. Fail closed.
    return refuse('device_state_unavailable', 'the control plane did not say whether this gateway has a device chain.');
  }
  if (own.state === 'none') {
    // An account that has a chain at the Authority Server, on a gateway that never set it up: its mandates stand on grants this
    // gateway cannot check. The Authority Server's word can only add this refusal.
    const notHere = refuse('device_not_set_up_here', 'this account has device keys, but this computer has not been set up with them, so its mandates cannot be checked here.');
    // Sticky: once a chain was ever reported for this account on this computer, "no chain here" never comes back (a wiped chain slot
    // is not a way out). The remaining limit: an Authority Server that denies a chain this gateway never heard of.
    try { if (await d.cp.chainSeen()) return notHere; } catch { return refuse('device_state_unavailable', 'the control plane did not say whether a device chain was ever set up here.'); }
    if (d.accountHasChain) {
      let has: boolean;
      try { has = await d.accountHasChain(); } catch { return refuse('device_state_unavailable', 'the Authority Server did not say whether this account has device keys.'); }
      if (has) { try { await d.cp.markChainSeen(); } catch { /* refused anyway */ } return notHere; }
    }
    return { ok: true, skipped: true };
  }
  if (own.state !== 'present') return refuse('device_chain_unreadable', 'this gateway\'s stored device chain cannot be read.');
  // Remembered (best effort): from now on this gateway is never read as "no chain here".
  try { await d.cp.markChainSeen(); } catch { /* the chain is present; only the memory failed */ }
  if (typeof own.rootDid !== 'string') return refuse('device_state_unavailable', 'this gateway\'s own identity could not be read.');
  if (typeof i.authorizationId !== 'string' || !i.authorizationId) return refuse('mandate_unavailable', 'the authorization is not one this gateway can name.');

  const dk = await deviceKeys();
  // The group: what the caller knows, else what the Authority Server says (the grant's own member must agree; unknown refuses a team grant).
  if (i.groupId === undefined) {
    try { const g = (await d.sp.getAuthorizationSummary?.(i.authorizationId))?.group_id; if (typeof g === 'string' && g) i = { ...i, groupId: g }; } catch { /* stays unknown */ }
  }
  const granted: GrantedBlob[] = [];
  let firstRefusal: GrantCheck | undefined;
  for (const a of i.attestations ?? []) {
    let payload: MandatePayload;
    try { payload = decodeMandateBlob(a.blob).payload; } catch { continue; } // undecodable: names nobody, honoured by nobody
    const r = await oneBlob(d, dk, i, a.blob, payload, own.rootDid);
    if (r.ok) granted.push(r.blob); else firstRefusal ??= r.check;
  }
  if (granted.length === 0) return firstRefusal ?? refuse('mandate_unavailable', 'the signed mandate is not available, so what was granted is not known.');
  // The newest version wins PER MANDATE: blobs of an older version of the same mandate are not used once a newer one verified.
  const top = new Map<string, number>();
  for (const g of granted) top.set(g.mandateId, Math.max(top.get(g.mandateId) ?? 0, g.version));
  const live = granted.filter(g => g.version === top.get(g.mandateId));
  // The body (plan 20.19), on the owner's own computers (only they are recipients of the sealed body; an approver's gateway gates
  // nothing of the owner's with scope and decides on the proposal's content): scope and intent must be the ones the grant signed, held here or fetched sealed and opened by this computer.
  // A mandate whose body is not here and cannot be fetched and checked is not honoured, and no receipt answers it (a receipt says "received").
  const received: GrantedBlob[] = [];
  for (const g of live) {
    const b = own.rootDid === g.ownerDid ? await ensureBody(d, i.authorizationId, g) : { ok: true as const };
    if (b.ok) received.push(g); else firstRefusal ??= b.check;
  }
  if (received.length === 0) return firstRefusal ?? refuse('mandate_body_not_received', 'the sealed mandate has not reached this computer yet.');
  // Receipt (DEC-23): the owner's own gateway answers a verified grant once. A failure is not a refusal: asked again on the next check.
  for (const g of received) {
    if (own.rootDid !== g.ownerDid || !g.receiptNeeded) continue;
    try { await d.cp.sendReceipt(g.mandateId, g.version, g.grantHash); } catch { /* not a refusal: asked again on the next check */ }
  }
  return { ok: true, granted: received };
}

/** Scope and intent of a verified mandate are present on this computer and are the ones its grant signed, or this says why not. */
async function ensureBody(d: GrantGateDeps, authorizationId: string, g: GrantedBlob): Promise<{ ok: true } | { ok: false; check: GrantCheck }> {
  if (!d.bodies) return { ok: true };
  const no = (code: string, text: string) => ({ ok: false as const, check: refuse(code, text) });
  const held = d.bodies.held(authorizationId);
  // What this computer holds counts only while it matches what the owner signed: a changed scope or intent is a new body to fetch.
  if (held && checkBody(g.payload, { scope: held.scope ?? {}, intent: held.intent }).ok) return { ok: true };
  let opened: Awaited<ReturnType<DeviceCpClient['openBody']>>;
  try {
    opened = await d.cp.openBody(g.mandateId, g.version, g.grantHash);
  } catch (e) {
    if (e instanceof BodyRefused) {
      if (e.code === 'body_not_received') return no('mandate_body_not_received', 'the sealed mandate has not reached this computer yet.');
      return no('mandate_body_refused', `the sealed mandate cannot be used on this computer (${e.code}).`);
    }
    return no('body_unavailable', 'the sealed mandate could not be fetched just now.');
  }
  // Before anything of it is used: the hashes the owner's grant signed.
  const verdict = checkBody(g.payload, opened);
  if (!verdict.ok) return no('mandate_body_mismatch', `the sealed mandate does not match what its owner granted (${verdict.why}).`);
  try { d.bodies.keep(authorizationId, g.payload, opened); } catch { return no('body_unavailable', 'the sealed mandate could not be kept on this computer.'); }
  return { ok: true };
}

async function oneBlob(
  d: GrantGateDeps, dk: Awaited<ReturnType<typeof deviceKeys>>, i: GrantGateInput, blob: string, payload: MandatePayload, ownRootDid: string,
): Promise<{ ok: true; blob: GrantedBlob } | { ok: false; check: GrantCheck }> {
  const no = (code: string, text: string) => ({ ok: false as const, check: refuse(code, text) });
  const ownerDid = payload.mandate_owners?.[0]?.did;
  const mandateId = payload.mandate_id;
  if (typeof ownerDid !== 'string' || !DID.test(ownerDid) || typeof mandateId !== 'string' || !MANDATE_ID.test(mandateId)) return no('mandate_unavailable', 'the signed mandate names no owner or no mandate id.');
  if (payload.version !== '0.8') return no('mandate_not_granted', 'a mandate of an account with a device chain is granted under protocol 0.8; this one is not.');
  // 0. WHO the owner is is not the Authority Server's to say. The payload it signed names a DID; a chain it serves for that DID
  //    proves nothing (a rogue server makes its own root, chain and check key, and a grant that verifies). Only this person's own
  //    identity, or one whose identity code they compared and accepted, is an owner this gateway honours a mandate for.
  if (ownerDid !== ownRootDid) {
    if (!d.allowConfirmedOwners) return no('owner_not_this_person', 'this gateway gates for its own person; a mandate of someone else is not honoured here.');
    let known = false;
    try { known = await d.cp.ownerConfirmed(ownerDid); } catch { return no('device_state_unavailable', 'the control plane did not say whether this owner was confirmed.'); }
    if (!known) return no('owner_unknown', 'the owner of this mandate is not this person and has not been confirmed by comparing their identity code.');
  }
  // The profile in the mandate is the one this gateway holds, when it holds one.
  const mine = d.localProfileHash?.(payload.profile_id);
  if (mine && mine !== payload.profile_hash) return no('profile_hash_mismatch', 'the mandate names another version of its profile than this gateway holds.');
  // 1. the owner's chain, verified here (the same rule as for an approver's)
  const chain = await verifiedChain(d, dk, ownerDid);
  if (!chain.ok) {
    return { ok: false, check: chain.check.ok ? refuse('chain_unavailable', 'the owner\'s device chain could not be read.') : (chain.check.code === 'approver_has_no_chain' ? refuse('owner_has_no_chain', 'the owner of this mandate has no device chain, so no grant can exist: an account is never on both (a mandate without a grant is not honoured).') : chain.check) };
  }

  // 2. the grants the Authority Server carries for this mandate
  let rows: Awaited<ReturnType<GrantGateDeps['sp']['getMandateGrants']>>;
  try {
    rows = await d.sp.getMandateGrants(mandateId);
  } catch {
    return no('grants_unavailable', 'the Authority Server did not give the grants of this mandate.');
  }
  // A revoke row counts only when it VERIFIES (a device of the owner signed it); it is then recorded, and it is final. A row that
  // does not verify is ignored: it neither refuses nor is honoured.
  for (const r of rows.filter(x => x.op === 'revoke' && isObj(x.grant) && Number.isSafeInteger(x.mandate_version))) {
    const g = r.grant as Record<string, unknown>;
    const fixed = new Set(GRANT_FIXED_MEMBERS);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(g)) if (!fixed.has(k)) fields[k] = v;
    try {
      const verified = await dk.verifyGrant({ grant: r.grant, sig: r.sig, check: r.check ?? undefined }, {
        chain: chain.state, mandateFields: fields, expect: { ops: ['revoke'], mandate_id: mandateId, mandate_version: r.mandate_version },
      });
      try { await d.cp.observeGrant(mandateId, r.mandate_version, await dk.grantHash(verified), 'revoke'); } catch { /* the revoke still refuses below */ }
      return no('mandate_revoked', 'this mandate was revoked with a device signature; a revocation is final.');
    } catch (e) {
      if (!(e instanceof Error && e.name === 'DeviceKeysError')) throw e;
    }
  }
  const candidates = rows.filter(r => (r.op === 'grant' || r.op === 'change') && isObj(r.grant) && Number.isSafeInteger(r.mandate_version)).sort((x, y) => y.mandate_version - x.mandate_version);
  if (candidates.length === 0) return no('mandate_not_granted', 'this mandate has no grant: the Authority Server signed it, but its owner\'s device did not.');

  // 3. the newest grant that verifies for exactly this mandate
  const approvers = Array.isArray(payload.above_cap_approvers) ? payload.above_cap_approvers : [];
  let lastCode = 'mandate_not_granted';
  for (const c of candidates) {
    const g = c.grant as Record<string, unknown>;
    // the three members a payload cannot carry are the owner's own statement; they must look like what they are
    const groupId = g.group_id;
    const replaces = g.replaces ?? null;
    const chainDids = g.chain_dids;
    if (typeof groupId !== 'string' || !groupId || (replaces !== null && (typeof replaces !== 'string' || !AUTHZ.test(replaces))) || !Array.isArray(chainDids) || chainDids.some(x => typeof x !== 'string')) { lastCode = 'grant_invalid'; continue; }
    if (g.authorization_id !== i.authorizationId) { lastCode = 'grant_other_authorization'; continue; }
    if (i.groupId !== undefined && i.groupId !== groupId) { lastCode = 'grant_other_team'; continue; }
    const dids = chainDids as string[];
    // A team grant (it names approvers) is checked against the group the grant names AND the one this gateway knows; unknown refuses.
    if (i.groupId === undefined && dids.length > 1) { lastCode = 'group_unknown'; continue; }
    if (!dids.includes(ownerDid) || approvers.some(a => !dids.includes(a)) || dids.some(x => x !== ownerDid && !approvers.includes(x))) { lastCode = 'chain_dids_invalid'; continue; }
    let members: Record<string, unknown>;
    try {
      members = grantMembersOf(payload, { authorizationId: i.authorizationId, groupId, replaces, chainDids: [...dids].sort() });
    } catch { lastCode = 'mandate_unavailable'; continue; }
    try {
      const verified = await dk.verifyGrant({ grant: c.grant, sig: c.sig, check: c.check ?? undefined }, {
        chain: chain.state, mandateFields: members, expect: { ops: [c.op as 'grant' | 'change'], mandate_id: mandateId, mandate_version: c.mandate_version },
      });
      const grantHash = await dk.grantHash(verified);
      // 4. the highest verified version is remembered; a lower one is refused (an older grant served again), a revoke is final
      let receiptNeeded = false;
      try {
        ({ receiptNeeded } = await d.cp.observeGrant(mandateId, c.mandate_version, grantHash, c.op as 'grant' | 'change'));
      } catch (e) {
        if (e instanceof GrantRefused) {
          if (e.reason === 'revoked') return no('mandate_revoked', 'this mandate was revoked with a device signature; a revocation is final.');
          return no('grant_version_refused', 'an older version of this mandate\'s grant was served than the highest this gateway verified.');
        }
        // The control plane looked and said no (it verified the grant itself): a refusal, not a failure to ask.
        if (e instanceof CpRefused) return no(e.code, `the control plane refused this grant (${e.code}).`);
        return no('device_state_unavailable', 'the control plane could not record the grant it verified.');
      }
      return { ok: true, blob: { blob, version: c.mandate_version, grantHash, ownerDid, mandateId, payload, receiptNeeded, groupId } };
    } catch (e) {
      if (!(e instanceof Error && e.name === 'DeviceKeysError')) throw e;
      lastCode = `grant_${(e as Error & { code: string }).code.toLowerCase()}`;
    }
  }
  return no(lastCode, `no grant of this mandate holds for the mandate as signed (${lastCode.replace(/^grant_/, '').replace(/_/g, ' ')}).`);
}

/**
 * What the resync of a stored gate does with an authorization after `syncAuthorization`: `synced` (it came back), `withheld` (the
 * Authority Server serves it but its owner's grant does not verify NOW: nothing is honoured, the stored gate content, the
 * intent, is kept so that a grant that arrives later gates again), or `orphan` (the Authority Server no longer serves it, or it
 * was revoked there: an explicit, permanent ending, so the stored gate goes).
 */
export function resyncVerdict(cache: { withheldReason(id: string): unknown }, authorizationId: string, synced: boolean): 'synced' | 'withheld' | 'orphan' {
  if (synced) return 'synced';
  return cache.withheldReason(authorizationId) ? 'withheld' : 'orphan';
}
