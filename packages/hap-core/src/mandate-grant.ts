/**
 * The members a mandate grant carries besides its fixed ones (device-keys plan 4.4, 20.3; build step 13).
 *
 * One place for both sides: the control plane builds the grant it signs from the mandate it is about to
 * request, and the MCP server rebuilds the same members from the mandate the Authority Server signed before
 * it honours it. They are, generically, the members of the v0.8 owner-signature projection (hap-core
 * `buildMandateProjection`; a member the mandate lacks is `null`), plus `authorization_id`, `group_id`,
 * `replaces` and `chain_dids`. The names are DERIVED from the projection, never listed by hand, and the
 * derivation is the Authority Server's own (suveren-as lib/device-keys/mandate-grants.ts, PR #141): the
 * two lists must be equal or the Authority Server refuses the grant.
 *
 * Pure: no node imports and no runtime import of hap-core. The shipped bundle compiles this file into each app
 * (tsup `noExternal`), where `@humanagencyp/hap-core` is not a dependency of its own, only the `@hap/core` alias:
 * so the caller hands in hap-core's `buildMandateProjection` (`createGrantMembers(buildMandateProjection)`).
 */
import type { buildMandateProjection as BuildProjection, MandatePayload } from '@humanagencyp/hap-core';

/** Names the projection shares with the grant's fixed members, or that only an owner signature carries. */
const NOT_FROM_PROJECTION = new Set(['typ', 'owner_did', 'nonce', 'binding', 'signing_surface']);
/** Members the grant adds to the projection's. */
const EXTRA_MEMBERS = ['authorization_id', 'group_id', 'chain_dids', 'replaces'] as const;
/** The fixed members of every grant (hap-core `buildGrant`). `sig`, `sigs` and `checks` are never members. */
export const GRANT_FIXED_MEMBERS: readonly string[] = ['typ', 'v', 'op', 'owner_did', 'key_id', 'chain_seq', 'chain_head', 'mandate_id', 'mandate_version', 'granted_at', 'nonce'];

type ProjectionEntry = Parameters<typeof BuildProjection>[1];
const entryFor = (did: string): ProjectionEntry => ({ did, nonce: 'n', binding: 'b', signing_surface: 's' }) as unknown as ProjectionEntry;

function dummyPayload(full: boolean): MandatePayload {
  const base = {
    mandate_id: 'm', version: '0.8', profile_id: 'p', profile_hash: 'h', bounds_hash: 'h', scope_hash: 'h',
    execution_context_hash: 'h', gate_content_hashes: {}, issuer: 'i', mandate_owners: [{ did: 'did:key:z' }],
    commitment_mode: full ? 'review_above_cap' : 'review', issued_at: 0, expires_at: 0,
  };
  return (full
    ? { ...base, intent_disclosure_hash: 'h', disclose_fields: [], above_cap_caps: {}, above_cap_approvers: [], above_cap_approvals: 1 }
    : base) as unknown as MandatePayload;
}


/** What a grant says about where the mandate lives, which the signed mandate does not carry. */
export interface GrantPlacement {
  authorizationId: string;
  groupId: string;
  /** The authorization this one takes over from, or null. */
  replaces: string | null;
  /** The DIDs among the owner and the approvers that have a device chain (20.3), sorted, each once. */
  chainDids: readonly string[];
}

/**
 * The two functions, bound to hap-core's projection builder. Use once per process:
 * `const { grantFieldKeys, grantMembersOf } = createGrantMembers(buildMandateProjection)`.
 */
export function createGrantMembers(buildMandateProjection: typeof BuildProjection): {
  grantFieldKeys: () => readonly string[];
  grantMembersOf: (payload: MandatePayload, placement: GrantPlacement) => Record<string, unknown>;
} {
  const projectionKeys = (full: boolean): string[] =>
    Object.keys(buildMandateProjection(dummyPayload(full), entryFor('did:key:z'))).filter(k => !NOT_FROM_PROJECTION.has(k));
  let cache: readonly string[] | null = null;

  /** Every member (besides the fixed ones) a grant carries, sorted. */
  const grantFieldKeys = (): readonly string[] => (cache ??= [...projectionKeys(true), ...EXTRA_MEMBERS].sort());

  /**
   * The members of the grant for this mandate payload: the owner-signature projection (null for a member the
   * mandate lacks) plus the placement. Throws when the payload names no owner.
   */
  const grantMembersOf = (payload: MandatePayload, placement: GrantPlacement): Record<string, unknown> => {
    const ownerDid = payload.mandate_owners?.[0]?.did;
    if (!ownerDid) throw new Error('the mandate names no owner');
    const projection = buildMandateProjection(payload, entryFor(ownerDid)) as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of grantFieldKeys()) {
      if ((EXTRA_MEMBERS as readonly string[]).includes(k)) continue;
      out[k] = projection[k] === undefined ? null : projection[k];
    }
    out.authorization_id = placement.authorizationId;
    out.group_id = placement.groupId;
    out.chain_dids = [...placement.chainDids];
    out.replaces = placement.replaces;
    return out;
  };
  return { grantFieldKeys, grantMembersOf };
}
