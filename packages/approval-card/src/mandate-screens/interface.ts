/**
 * What the step-13 screens read from the gateway, as plain data. The pages and the phone app fill these from the gateway's
 * own routes; the components take nothing else, so the AI can never add text that reaches the person here.
 */

/** Why this gateway holds a mandate back (a gateway code, mapped by {@link heldReason}). */
export type HeldReason = 'not_received' | 'check_required' | 'owner_unknown' | 'changed' | 'revoked';

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
 * Any other grant or body code means what arrived does not match what the owner granted. (`no_grant`, `CHECK_REQUIRED`, `check_required`
 * are older spellings, kept.)
 */
export function heldReason(code: string): HeldReason {
  if (code === 'mandate_body_not_received' || code === 'no_grant') return 'not_received';
  if (code === 'grant_check_required' || code === 'mandate_not_granted' || code === 'CHECK_REQUIRED' || code === 'check_required') return 'check_required';
  if (code === 'owner_unknown' || code === 'owner_not_this_person') return 'owner_unknown';
  if (code === 'mandate_revoked') return 'revoked';
  return 'changed';
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
