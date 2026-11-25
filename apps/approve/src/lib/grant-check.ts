/**
 * The owner's grant of a mandate, checked on the phone before it offers a decision (device-keys plan 4.4; the same rule the gateway runs
 * before it gates with a mandate, apps/mcp-server/src/lib/mandate-grants.ts).
 *
 * The phone decides only on its own person's mandates (card check 6), so the owner's chain is this phone's own verified chain. For the
 * mandate the card chose:
 *   - a `revoke` that verifies (any active device of the owner signed it) ends the mandate: no buttons;
 *   - otherwise the newest `grant` / `change` that verifies FOR EXACTLY THIS MANDATE is required: hap-core `deviceKeys.verifyGrant`
 *     against the chain (the device's signature, an active device whose check key answered over exactly this grant, the named head),
 *     with every member equal to the members rebuilt here from the SIGNED mandate (hap-core's own `buildMandateProjection`, through the
 *     same `createGrantMembers` the gateway uses);
 *   - the three members a payload cannot carry (`authorization_id`, `group_id`, `replaces`) and `chain_dids` are the owner's own
 *     statement: the authorization must be the request's, the rest must look like what they are, `chain_dids` must hold the owner,
 *     every above-cap approver and nobody else.
 * A mandate with no grant that verifies is not one the phone decides under.
 *
 * KNOWN GAP (listed, not hidden): the phone does not pin the highest grant version it saw, so a server serving an OLDER grant that
 * still verifies for the mandate it serves is not noticed here. The gateway that runs the action pins it and refuses.
 */
import { buildMandateProjection, type MandatePayload } from '@hap/core/browser';
import { verifyGrant, type ChainState } from '@hap/core/device-keys';
import { createGrantMembers, GRANT_FIXED_MEMBERS } from '@hap/core/mandate-grant';

const { grantMembersOf } = createGrantMembers(buildMandateProjection);

export type GrantCode = 'mandate_not_granted' | 'mandate_revoked' | 'grant_invalid';
export type GrantVerdict = { ok: true; version: number } | { ok: false; code: GrantCode };

export interface GrantRow { mandate_version: number; op: string; grant: unknown; sig: unknown; check: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const AUTHZ = /^authz_[0-9a-f-]{36}$/;
const isDkError = (e: unknown): boolean => e instanceof Error && e.name === 'DeviceKeysError';

/** The rows of `GET /api/mandates/:id/grants` the check reads; anything else in the answer is dropped. */
export function grantRowsOf(answer: unknown): GrantRow[] | null {
  const list = isObj(answer) ? answer.grants : undefined;
  if (!Array.isArray(list)) return null;
  return list.filter((g): g is GrantRow => isObj(g) && Number.isSafeInteger(g.mandate_version) && typeof g.op === 'string');
}

export async function checkGrant(i: { payload: MandatePayload; authorizationId: string; chain: ChainState; rows: GrantRow[] }): Promise<GrantVerdict> {
  const { payload, chain } = i;
  const ownerDid = payload.mandate_owners?.[0]?.did;
  if (typeof ownerDid !== 'string' || ownerDid !== chain.root_did) return { ok: false, code: 'grant_invalid' };
  const mandateId = payload.mandate_id;

  // A revoke counts only when it verifies; then it is final.
  for (const r of i.rows.filter((x) => x.op === 'revoke' && isObj(x.grant))) {
    const fields: Record<string, unknown> = {};
    const fixed = new Set(GRANT_FIXED_MEMBERS);
    for (const [k, v] of Object.entries(r.grant as Record<string, unknown>)) if (!fixed.has(k)) fields[k] = v;
    try {
      await verifyGrant({ grant: r.grant, sig: r.sig, check: r.check ?? undefined }, {
        chain, mandateFields: fields, expect: { ops: ['revoke'], mandate_id: mandateId, mandate_version: r.mandate_version },
      });
      return { ok: false, code: 'mandate_revoked' };
    } catch (e) {
      if (!isDkError(e)) throw e;
    }
  }

  const candidates = i.rows.filter((r) => (r.op === 'grant' || r.op === 'change') && isObj(r.grant)).sort((x, y) => y.mandate_version - x.mandate_version);
  if (candidates.length === 0) return { ok: false, code: 'mandate_not_granted' };
  const approvers = Array.isArray(payload.above_cap_approvers) ? payload.above_cap_approvers : [];
  for (const c of candidates) {
    const g = c.grant as Record<string, unknown>;
    const groupId = g.group_id;
    const replaces = g.replaces ?? null;
    const chainDids = g.chain_dids;
    if (typeof groupId !== 'string' || !groupId || (replaces !== null && (typeof replaces !== 'string' || !AUTHZ.test(replaces)))
      || !Array.isArray(chainDids) || chainDids.some((x) => typeof x !== 'string')) continue;
    if (g.authorization_id !== i.authorizationId) continue;
    const dids = chainDids as string[];
    if (!dids.includes(ownerDid) || approvers.some((a) => !dids.includes(a)) || dids.some((x) => x !== ownerDid && !approvers.includes(x))) continue;
    let members: Record<string, unknown>;
    try {
      members = grantMembersOf(payload, { authorizationId: i.authorizationId, groupId, replaces: replaces as string | null, chainDids: [...dids].sort() });
    } catch { continue; }
    try {
      await verifyGrant({ grant: c.grant, sig: c.sig, check: c.check ?? undefined }, {
        chain, mandateFields: members, expect: { ops: [c.op as 'grant' | 'change'], mandate_id: mandateId, mandate_version: c.mandate_version },
      });
      return { ok: true, version: c.mandate_version };
    } catch (e) {
      if (!isDkError(e)) throw e;
    }
  }
  return { ok: false, code: 'mandate_not_granted' };
}
