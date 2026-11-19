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
 * Identity codes at the join (DEC-73, option B). NOT BUILT: needs the Authority Server and hap-core part of DEC-73
 * (the admin's signed list, the join request carrying both sides' codes). Nothing implements this yet; the screens are
 * built against it and the gateway page passes `null` until it exists.
 */
export interface JoinCompareApi {
  /** Both codes (digits only) for one pending join, computed by this gateway from the two DIDs. */
  load(joinId: string): Promise<{ memberName: string; adminName: string; teamName: string; yourCode: string; theirCode: string }>;
  /** Admin: the codes match; signs the admin's list entry with a device. */
  confirm(joinId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Either side: the codes differ. Nothing is signed or remembered. */
  differ(joinId: string): Promise<void>;
}
