/**
 * TR5/TR7 (work-plan "Added 2026-10-14 — Team: permissions, above-cap
 * approval, read limits"; direction: content/0.7/review.md "Group roles:
 * who may grant, who approves above the cap" and "A group can cap reads and
 * capability switches") — the gateway-side mirror of suveren-as's
 * profile-config-store.ts `effectiveCapKind`/`enumExceedsCap`, used by
 * BoundsEditor (the mandate editor) and ApproverProposalCard (the approval
 * card) so the two UIs can never disagree about what kind a cap actually is.
 *
 * Not imported from suveren-as (different package, different runtime) —
 * kept in lockstep by hand, same footing as sp-client.ts's own `ProfileConfig`
 * mirror.
 *
 * Wire shape (see sp-client.ts's `ProfileConfig` doc comment,
 * suveren-as fix/profile-config-compat): a cap's VALUE lives in
 * `config.caps[field]` (plain number | string); its stored KIND lives in
 * the separate `config.capKinds[field]`, absent when the admin saved it
 * before TR5 shipped — never assume `caps[field]` is an object.
 */
import type { ProfileConfig, CapKind } from './sp-client';

/** The minimal shape of a profile bounds field this module reads — same
 *  loose-JSON contract as suveren-as's `CapFieldShape`. Never assumes a
 *  concrete field NAME. */
export interface CapFieldShape {
  enforcedBy?: string;
  displayName?: string;
  boundType?: { kind?: string; of?: string; values?: readonly string[] };
}

/**
 * The cap kind the admin chose and saved, before any of the three forcing
 * overrides below apply. Falls back to "approval when approvers exist, else
 * hard" when `capKinds` carries no entry for this field — the behaviour of
 * an AS from before TR5 (or a cap set before TR5 shipped), per the task's
 * own task brief decision 2026-10-14 ("hard/soft per cap, default when
 * approvers exist").
 */
export function storedCapKind(config: Pick<ProfileConfig, 'approvers' | 'capKinds'>, field: string): CapKind {
  const stored = config.capKinds?.[field];
  if (stored) return stored;
  return config.approvers.length > 0 ? 'approval' : 'hard';
}

/**
 * The EFFECTIVE kind a cap is enforced as — overriding the admin's stored
 * choice in the cases nobody may choose around (mirrors suveren-as's
 * `effectiveCapKind`):
 *   1. no approvers at all configured for this profile → every cap is hard;
 *   2. the field is `enforcedBy: "gatekeeper"` (a read limit — reads carry
 *      no ticket, so nothing could ever clear an approval one read at a
 *      time);
 *   3. the field's `boundType.kind === 'enum'` (a capability switch — there
 *      is no per-call amount to approve one unit of).
 * `caps`/`capKinds` entirely absent for this field (no cap configured at
 * all) still resolves to a kind — callers that only care "is THIS field
 * capped" should check `config.caps?.[field] !== undefined` separately.
 */
export function effectiveCapKind(
  config: Pick<ProfileConfig, 'approvers' | 'capKinds'>,
  fieldDef: CapFieldShape | undefined,
  field: string,
): CapKind {
  if (config.approvers.length === 0) return 'hard';
  if (fieldDef?.enforcedBy === 'gatekeeper') return 'hard';
  if (fieldDef?.boundType?.kind === 'enum') return 'hard';
  return storedCapKind(config, field);
}

/**
 * Compare an enum cap against a requested value — mirrors suveren-as's
 * `enumExceedsCap`. Every shipped profile orders a capability-flag enum's
 * `values` MOST PERMISSIVE first, most restrictive last (e.g.
 * `read_access: ["unlimited", "none"]`) — "exceeds" means the requested
 * value is EARLIER (more permissive) than the cap.
 */
export function enumExceedsCap(values: readonly string[], cap: string, requested: string): boolean {
  const capIndex = values.indexOf(cap);
  const reqIndex = values.indexOf(requested);
  if (capIndex === -1 || reqIndex === -1) return false;
  return reqIndex < capIndex;
}

/** True when `field` carries a team cap at all (regardless of kind). */
export function isCapped(config: Pick<ProfileConfig, 'caps'>, field: string): boolean {
  return config.caps?.[field] !== undefined;
}

/**
 * Does `requested` exceed the team's cap on `field`, and if so, what kind is
 * it enforced as? Returns null when the field carries no cap, or the
 * requested value does not exceed it.
 */
export function capViolation(
  config: Pick<ProfileConfig, 'approvers' | 'caps' | 'capKinds'>,
  field: string,
  fieldDef: CapFieldShape | undefined,
  requested: number | string | undefined,
): { cap: number | string; kind: CapKind } | null {
  const cap = config.caps?.[field];
  if (cap === undefined || requested === undefined) return null;
  const kind = effectiveCapKind(config, fieldDef, field);
  let exceeds = false;
  if (typeof cap === 'number' && typeof requested === 'number') {
    exceeds = requested > cap;
  } else if (typeof cap === 'string' && typeof requested === 'string') {
    exceeds = enumExceedsCap(fieldDef?.boundType?.values ?? [], cap, requested);
  }
  return exceeds ? { cap, kind } : null;
}

/**
 * The reason an above-cap proposal exists, for the approval card's "Above
 * the team limit: <field> <value> (limit <cap>)." line — built ONLY from
 * real data (never invented):
 *   - the team's OWN cap, fetched fresh from `GET
 *     /api/groups/:id/profile-config/:profileId` (any team member may
 *     read it);
 *   - the proposal's own `executionContext`, which the gateway already put
 *     on the wire filtered to exactly the fields a `per_transaction`/
 *     `cumulative_sum` bound's `boundType.of` names (tool-proxy.ts's
 *     `wireExecutionContext`) — readable to the AS by design (PE1
 *     decision 1), so readable here too.
 *
 * A `cumulative_count` cap (e.g. "emails per day") carries NO per-call
 * value on the wire at all — there is nothing to show as `value` for it,
 * and this never fabricates one. With exactly one approval-kind cap
 * configured for the profile, that is still named (field + cap, no value);
 * with more than one and no executionContext match, returns null rather
 * than guess which one triggered this specific proposal.
 */
export interface AboveCapReason {
  field: string;
  fieldLabel: string;
  cap: number | string;
  /** Only present when the proposal's own executionContext carries it. */
  value?: number | string;
}

export function findAboveCapViolation(
  executionContext: Record<string, unknown>,
  config: Pick<ProfileConfig, 'approvers' | 'caps' | 'capKinds'>,
  fields: Record<string, CapFieldShape>,
): AboveCapReason | null {
  const approvalCaps = Object.entries(config.caps ?? {}).filter(
    ([field]) => effectiveCapKind(config, fields[field], field) === 'approval',
  );
  if (approvalCaps.length === 0) return null;

  const labelFor = (field: string): string => fields[field]?.displayName ?? field;

  for (const [field, cap] of approvalCaps) {
    const fieldDef = fields[field];
    const bt = fieldDef?.boundType;
    const of = bt?.kind === 'per_transaction' || bt?.kind === 'cumulative_sum' ? bt.of : undefined;
    const raw = of ? executionContext[of] : undefined;
    if (typeof cap === 'number' && typeof raw === 'number' && raw > cap) {
      return { field, fieldLabel: labelFor(field), cap, value: raw };
    }
  }

  if (approvalCaps.length === 1) {
    const [field, cap] = approvalCaps[0];
    return { field, fieldLabel: labelFor(field), cap };
  }
  return null;
}
