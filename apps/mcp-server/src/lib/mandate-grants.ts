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

import { decodeMandateBlob, buildMandateProjection, type MandatePayload } from '@hap/core';
import { createGrantMembers } from '@hap/core/mandate-grant';
import {
  deviceKeys, deviceKeysEnabled, verifiedChain, GrantRefused,
  type DeviceCpClient, type ChainReader,
} from './device-decisions';

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
  sp: ChainReader['sp'] & { getMandateGrants(mandateId: string): Promise<Array<{ mandate_version: number; op: string; grant: unknown; sig: unknown; check: unknown }>> };
  cp: DeviceCpClient;
  env?: NodeJS.ProcessEnv;
}

export interface GrantGateInput {
  authorizationId: string;
  attestations: ReadonlyArray<{ blob: string }>;
  /** The group the Authority Server says the authorization belongs to, when this gateway knows it; the grant's own must agree. */
  groupId?: string;
}

/** What a caller holds to check a mandate with. Required wherever a mandate is read for gating or for a decision: a missing gate is a compile error, never a skipped check. */
export type GrantGate = (i: GrantGateInput) => Promise<GrantCheck>;

/** `protectedDids` is read at every check: the signed identities of the mandates cached right now (their pins are never evicted). */
export function makeGrantGate(deps: Omit<GrantGateDeps, 'protectedDids'> & { protectedDids?: () => string[] }): GrantGate {
  return i => checkMandateGrant({ ...deps, protectedDids: deps.protectedDids?.() }, i);
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
  if (own.state === 'none') return { ok: true, skipped: true };
  if (own.state !== 'present') return refuse('device_chain_unreadable', 'this gateway\'s stored device chain cannot be read.');
  if (typeof i.authorizationId !== 'string' || !i.authorizationId) return refuse('mandate_unavailable', 'the authorization is not one this gateway can name.');

  const dk = await deviceKeys();
  const granted: GrantedBlob[] = [];
  let firstRefusal: GrantCheck | undefined;
  for (const a of i.attestations ?? []) {
    let payload: MandatePayload;
    try { payload = decodeMandateBlob(a.blob).payload; } catch { continue; } // undecodable: names nobody, honoured by nobody
    const r = await oneBlob(d, dk, i, a.blob, payload);
    if (r.ok) granted.push(r.blob); else firstRefusal ??= r.check;
  }
  if (granted.length === 0) return firstRefusal ?? refuse('mandate_unavailable', 'the signed mandate is not available, so what was granted is not known.');
  // The newest version wins: blobs of an older version are not used once a newer one verified (the same rule the Authority Server holds).
  const top = Math.max(...granted.map(g => g.version));
  const live = granted.filter(g => g.version === top);
  // Receipt (DEC-23): the owner's own gateway answers a verified grant once. A failure is not a refusal: asked again on the next check.
  for (const g of live) {
    if (own.rootDid !== g.ownerDid || !g.receiptNeeded) continue;
    try { await d.cp.sendReceipt(g.mandateId, g.version, g.grantHash); } catch { /* not a refusal: asked again on the next check */ }
  }
  return { ok: true, granted: live };
}

async function oneBlob(
  d: GrantGateDeps, dk: Awaited<ReturnType<typeof deviceKeys>>, i: GrantGateInput, blob: string, payload: MandatePayload,
): Promise<{ ok: true; blob: GrantedBlob } | { ok: false; check: GrantCheck }> {
  const no = (code: string, text: string) => ({ ok: false as const, check: refuse(code, text) });
  const ownerDid = payload.mandate_owners?.[0]?.did;
  const mandateId = payload.mandate_id;
  if (typeof ownerDid !== 'string' || !DID.test(ownerDid) || typeof mandateId !== 'string' || !MANDATE_ID.test(mandateId)) return no('mandate_unavailable', 'the signed mandate names no owner or no mandate id.');
  if (payload.version !== '0.8') return no('mandate_not_granted', 'a mandate of an account with a device chain is granted under protocol 0.8; this one is not.');
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
  if (rows.some(r => r.op === 'revoke')) return no('mandate_revoked', 'this mandate was revoked with a device signature; a revocation is final.');
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
        return no('device_state_unavailable', 'the control plane could not record the grant it verified.');
      }
      return { ok: true, blob: { blob, version: c.mandate_version, grantHash, ownerDid, mandateId, payload, receiptNeeded } };
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
