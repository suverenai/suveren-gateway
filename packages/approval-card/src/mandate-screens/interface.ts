/**
 * What the step-13 screens read from the gateway, as plain data. The pages and the phone app fill these from the gateway's
 * own routes; the components take nothing else, so the AI can never add text that reaches the person here.
 */

/** Why this gateway holds a mandate back (a gateway code, mapped by {@link heldReason}). */
export type HeldReason = 'not_received' | 'check_required' | 'owner_unknown' | 'changed' | 'revoked' | 'on_hold';

export interface HeldBackMandate {
  mandateId: string;
  /** The area's name (the gateway reads it from the profile). */
  profileName: string;
  /** The owner's name as the gateway knows it (team member list); null when it does not know one. */
  ownerName: string | null;
  ownerIsYou: boolean;
  reason: HeldReason;
  /** The admin who confirms colleagues, for `owner_unknown`; null when unknown. */
  adminName: string | null;
}

/**
 * Gateway code (the MCP server's verdict, GET /api/mandate/held-back) -> reason. The codes are the gateway's own:
 * `mandate_body_not_received` and `mandate_not_granted` (nothing, or no grant, has reached this computer yet), `grant_check_required`
 * (the grant has no check), `owner_unknown` / `owner_not_this_person` (the owner is not someone this person confirmed), `mandate_revoked`.
 * `mandate_body_mismatch` / `grant_mismatch`: what arrived does not match what the owner granted. Every other code is a neutral
 * "on hold" (maintainer, 2026-11-24: an unknown reason must never claim a mismatch). (`no_grant`, `CHECK_REQUIRED`, `check_required`
 * are older spellings, kept.)
 */
export function heldReason(code: string): HeldReason {
  if (code === 'mandate_body_not_received' || code === 'no_grant') return 'not_received';
  if (code === 'grant_check_required' || code === 'mandate_not_granted' || code === 'CHECK_REQUIRED' || code === 'check_required') return 'check_required';
  if (code === 'owner_unknown' || code === 'owner_not_this_person') return 'owner_unknown';
  if (code === 'mandate_revoked') return 'revoked';
  if (code === 'mandate_body_mismatch' || code === 'grant_mismatch') return 'changed';
  return 'on_hold';
}

/** The result of ending a mandate, from the device-signed revoke route (POST /api/mandate/revoke). */
export type EndResult =
  | { ok: true }
  | { ok: false; code: 'already_ended' | 'unknown' | 'offline' | 'other' };

/** One term of a team's rules for an area, as the gateway read them. Labels come from the gateway, never from the AI. */
export interface TeamTerms {
  /** Approver labels (name, else the account's email or id). */
  approvers: string[];
  approvals: number;
  /** Team limits per field: label, value and unit text. */
  limits: Array<{ field: string; label: string; value: number; unit?: string }>;
}

/**
 * Identity codes at the join (DEC-73, design 20.21.5). The gateway computes and compares; the screens only show the
 * person's OWN code and send the code they typed. The control plane (apps/control-plane/src/lib/team-join.ts) implements this
 * for the gateway page; the phone app uses the same shapes. A refusal is a neutral `code` the host maps with {@link joinErrorText}.
 */
export type JoinCheck = { match: true } | { match: false; triesLeft: number };
export type JoinResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; triesLeft?: number };

export interface MemberJoinApi {
  /** The member's own code and where this side stands (survives a reload: the gateway remembers). */
  view(teamId: string): Promise<JoinResult<{ yourCode: string; triesLeft: number; compared: boolean; anchored: boolean }>>;
  /** The admin's code as typed; compared by the gateway with the one it computes from the admin's DID. */
  check(teamId: string, code: string): Promise<JoinResult<JoinCheck>>;
  /** The touch: signs the anchor. Only after a match. */
  anchor(teamId: string): Promise<JoinResult>;
}

export interface JoinRequestView {
  userId: string;
  /** From the sign-up; not checked. */
  memberName: string;
  hasDid: boolean;
  triesLeft: number;
  compared: boolean;
  anchor: 'none' | 'ok' | 'invalid';
}

export interface AdminJoinApi {
  view(teamId: string): Promise<JoinResult<{ yourCode: string; requests: JoinRequestView[] }>>;
  check(teamId: string, userId: string, code: string): Promise<JoinResult<JoinCheck>>;
  /** The touch: signs member list version n+1. Only after a match and with the member's anchor verified. */
  add(teamId: string, userId: string): Promise<JoinResult<{ version: number }>>;
}

/**
 * Changes of a team's member list after the join (DEC-73 step 5): remove, new identity, re-sign, hand-over, take-over.
 * The control plane (apps/control-plane/src/lib/team-changes.ts) answers these shapes; the phone app can use the same.
 */
export type RemoveReason = 'left' | 'removed' | 'not_member';
export interface RemoveOfferView { did: string; name: string; reason: RemoveReason }
export interface ReplaceOfferView { oldDid: string; newDid: string | null; name: string; userId: string; triesLeft: number; compared: boolean; anchor: 'none' | 'ok' | 'invalid' }
export interface HandoverStateView { you: 'old_admin' | 'new_admin'; stage: 'named' | 'signed'; newAdminName: string | null }
export interface AdminChangesView {
  role: 'admin'; version: number; yourCode: string;
  remove: RemoveOfferView[]; replace: ReplaceOfferView[]; resign: boolean; handover: HandoverStateView | null;
  candidates: Array<{ did: string; name: string }>;
}
export interface MemberChangesView { role: 'member'; adminChanged: boolean; adminGone: boolean; handover: HandoverStateView | null }
export type TeamChangesView = AdminChangesView | MemberChangesView;

export interface TeamChangesApi {
  view(teamId: string): Promise<{ ok: true; changes: TeamChangesView } | { ok: false; code: string }>;
  /** The touch: list without that person. */
  remove(teamId: string, did: string): Promise<JoinResult<{ version: number }>>;
  /** The NEW identity's code as typed; compared by the gateway. */
  replaceCheck(teamId: string, userId: string, oldDid: string, code: string): Promise<JoinResult<JoinCheck>>;
  /** The touch: the list with the old DID replaced by the new one. */
  replace(teamId: string, userId: string, oldDid: string): Promise<JoinResult<{ version: number }>>;
  /** The touch: the same members again, signed by a device that stays. */
  resign(teamId: string): Promise<JoinResult<{ version: number }>>;
  /** The old admin names the new admin (no touch). */
  handoverOffer(teamId: string, did: string): Promise<JoinResult>;
  /** The new admin builds and signs the list (touch). */
  handoverBuild(teamId: string): Promise<JoinResult<{ version: number }>>;
  /** The old admin adds her signature (touch). */
  handoverSign(teamId: string): Promise<JoinResult<{ version: number }>>;
  handoverWithdraw(teamId: string): Promise<JoinResult>;
}
