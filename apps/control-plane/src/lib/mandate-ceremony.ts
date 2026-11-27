/**
 * Creating a mandate on behalf of the signed-in person, from the gateway itself —
 * the same steps the sign page runs in the browser when the person clicks "Sign
 * mandate" (apps/ui/src/pages/AgentReviewPage.tsx handleCommit):
 *
 *   resolve workspace + profile → check rights, limits, scope, mode, duration →
 *   hash → encrypt the intent for the team's approvers → the Authority Server
 *   signs under the person's account → deliver the intent to the MCP server.
 *
 * Used by the `setup__create_mandate` tool (simulation setup S8): the AI proposes,
 * a person approves the proposal, and only then does this run. `check` runs the
 * same validation without creating anything, so the tool can refuse a proposal
 * that could never be created BEFORE a person is asked to approve it.
 *
 * Every Authority Server call goes through the injected `as` — the caller's
 * server-side session — so the AS applies all of its own checks again (team
 * authority gate, commitment modes, bounds against the profile, TTL). The checks
 * here are for a clear refusal up front, never the only line.
 */
import {
  allowedCommitmentModes,
  computeBoundsHash,
  computeScopeHash,
  computeIntentHash,
  computeExecutionContextHash,
  computeProfileHash,
  isCommitmentModeAllowed,
  validateBoundsParams,
  validateScopeParams,
  SUPPORTED_VERSIONS,
  type AgentProfile,
} from '@hap/core';
import { readRefusal } from '@hap/core/refusal';
import { carryValues, computeMandateDiff, diffIsEmpty, type MandateDiff } from '@hap/core/mandate-change';
import { atLeastOneBuildRefusal, unmetForMandate } from '@hap/core/scope-rules';
import type { MandateGrants, Issued, IssueInput, PreparedGrant, PhoneGive, PhonePrevious } from './mandate-grants';
import { createHash } from 'node:crypto';
import { canonicalize } from '@hap/core';
import { GrantRefusal } from './mandate-grants';

export interface MandateRequest {
  /**
   * Team id or name, or `"personal"`; absent = resolve via
   * {@link delegationWorkspace} (the workspace of the caller's own
   * Delegation mandate, else personal). `setup__create_mandate` (WS3,
   * work-plan "Added 2026-10-11 — an account is Personal OR in one team")
   * no longer sends this at all, so for that caller it is always absent —
   * which, since an account is active in only one workspace at a time,
   * always resolves to that active workspace. Kept here (not removed) for
   * any other direct caller of this module that still wants to name one
   * explicitly; the Authority Server re-checks membership either way.
   */
  team?: string;
  /**
   * With no `team`: the profile (short name) of the caller's own mandate whose
   * workspace the new mandate goes to — the Setup built-in sends its own
   * profile, declared once in the gateway (builtins/setup.ts). Absent too: the
   * personal workspace. Never a profile name written here.
   */
  workspaceOf?: string;
  /** Full profile id, or the short name ("sales") for its newest version. */
  profile: string;
  /** Limits (bounds), without `profile` — added here. */
  limits: Record<string, unknown>;
  /** Scope (context). */
  scope?: Record<string, unknown>;
  intent: string;
  mode: string;
  /** Lifetime in hours; absent = the profile's default. */
  durationHours?: number;
  /** Lifetime in seconds — the sign page's own unit. Wins over `durationHours`. */
  ttlSeconds?: number;
  title?: string;
  /** Show the owner's verified name on actions under this mandate (the sign page's checkbox). */
  discloseIdentity?: boolean;
  /** Discovered display names per scope field (value → label). Local only, never signed. */
  contextLabels?: Record<string, Record<string, string>>;
  /** Replace this mandate: after the new one is signed and delivered, it is revoked. */
  replaces?: string;
  /**
   * NOT USED any more (DEC-73): colleagues come from the team's verified member list (lib/team-trust.ts). Was, on a gateway with a device chain: the DIDs of approvers whose identity code the person
   * compared on the screen.
   */
  confirmedApproverDids?: string[];
}

export interface AsResponse { status: number; body: any }
export type AsCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<AsResponse>;

export interface EncryptedIntent {
  intentCiphertext: string;
  encryptedKeys: Record<string, { ct: string; enc: string }>;
  approversFrozen: string[];
  intentDisclosureHash: string;
}

export interface CeremonyDeps {
  as: AsCall;
  /** The signed-in person (from the login response); null when locked. */
  user: { id: string; did: string } | null;
  encrypt: (intent: string, recipients: Array<{ userId: string; publicKey: string }>) => Promise<EncryptedIntent>;
  deliverGateContent: (args: {
    authorizationId: string;
    boundsHash: string;
    contextHash: string;
    context: Record<string, string | number>;
    contextLabels?: Record<string, Record<string, string>>;
    gateContent: { intent: string };
    path?: string;
  }) => Promise<void>;
  newAuthorizationId: () => string;
  /** Drop a revoked mandate from the MCP server's list now rather than at next login. */
  resyncGates?: () => Promise<unknown>;
  /**
   * Present only on a gateway with SUVEREN_DEVICE_KEYS=on. With a device chain, a mandate is granted on this computer
   * with its check before the Authority Server is asked to sign it (device-keys plan 4.4). Absent or without a chain:
   * the steps below are exactly the ones of every earlier release.
   */
  grants?: MandateGrants;
  /**
   * Where a give on this computer is (device-chain ceremony only), so the page never waits in silence: `touched` once the person's touch
   * was given, `requesting` while the Authority Server is asked, `delivering` while the gate content reaches this gateway. No content.
   */
  progress?: (stage: 'touched' | 'requesting' | 'delivering') => void;
  /** Told the moment the Authority Server ACCEPTED a mandate request of a device-chain ceremony: from here a retry would make a second live mandate. */
  onIssued?: (info: { mandateId: string }) => void;
  /** The mandate id a NEW mandate must get (chosen when the approval was claimed); undefined: the grant picks one. */
  newMandateId?: () => string | undefined;
  /** This computer's copy of a mandate it holds (limits, scope, intent, end): what a change on the phone shows as the previous version. */
  signedMandate?: (authorizationId: string) => Promise<SignedMandate | null>;
  /**
   * The replaced-mandates record on the MCP server (replaced-mandates.ts): once
   * recorded, the old mandate is no longer honoured on this gateway, and the
   * record is the revoke outbox (replaced-revoke-retry.ts).
   */
  replaced?: {
    record: (authorizationId: string, replacedBy: string) => Promise<void>;
    noteAttempt: (authorizationId: string, error?: string) => Promise<void>;
    clear: (authorizationId: string) => Promise<void>;
  };
}

/** What happened to the replaced mandate after its replacement was delivered. */
export interface RetireResult {
  /** The revoke at the Authority Server did not go through (it is retried). */
  revokeError?: string;
  /** The old mandate is no longer honoured on this gateway (recorded locally). */
  oldStoppedLocally?: boolean;
}

/** Everything `create` needs, resolved and checked. */
export interface MandatePlan {
  groupId: string;
  groupName: string;
  isPersonal: boolean;
  domain: string;
  profile: AgentProfile;
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string;
  mode: 'review' | 'automatic';
  ttlSeconds: number;
  title: string;
  /** Approvers whose public keys the intent is encrypted for (team only). */
  approvers: string[];
  /** The team's settings for this profile as read here (team only); a device-chain gateway puts them into the grant. */
  team: { approvers: string[]; approvals?: number; caps: Record<string, unknown>; eligible?: Array<{ user_id: string; did: string | null }> } | null;
}

export class MandateRefused extends Error {
  /** Why, in a form a caller can act on without reading the sentence. */
  constructor(message: string, readonly code?: 'profile_not_enabled' | 'not_a_grantor' | 'not_your_mandate' | 'mandate_not_active' | 'no_change' | 'changed_since_proposal' | 'scope_at_least_one' | 'grant_refused' | 'delivery_failed', readonly detail?: Record<string, unknown>) { super(message); }
}

const INTENT_MAX = 2000; // the mandate screen's limit

const shortOf = (id: string): string => id.replace(/@.*$/, '').split('/').pop() ?? id;
const versionOf = (id: string): string => id.split('@')[1] ?? '';

function refuse(msg: string, code?: MandateRefused['code']): never {
  throw new MandateRefused(msg, code);
}

async function resolveProfile(as: AsCall, requested: string): Promise<AgentProfile> {
  let id = requested.trim();
  if (!id.includes('@')) {
    const list = await as('GET', '/api/profiles');
    const matches = ((list.body?.profiles ?? []) as Array<{ id: string }>).filter(p => shortOf(p.id) === id);
    if (matches.length === 0) refuse(`Unknown profile "${requested}".`);
    matches.sort((a, b) => versionOf(b.id).localeCompare(versionOf(a.id), undefined, { numeric: true }));
    id = matches[0].id;
  }
  const res = await as('GET', `/api/profiles/${encodeURIComponent(id)}`);
  if (res.status !== 200 || !res.body?.id) refuse(`Unknown profile "${requested}".`);
  return res.body as AgentProfile;
}

function scalarRecord(label: string, value: unknown): Record<string, string | number> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) refuse(`\`${label}\` must be an object.`);
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string' && typeof v !== 'number') refuse(`\`${label}.${k}\` must be a string or a number.`);
    out[k] = v as string | number;
  }
  return out;
}

/**
 * The approvers' public keys, from the AS's
 * `GET /api/groups/:id/profile-config/:profileId/approvers/pubkeys`, which answers
 * `{ pubkeys: { <userId>: <base64 key> } }`.
 */
export function approverPubkeys(body: unknown): Array<{ userId: string; publicKey: string }> {
  const map = (body as { pubkeys?: unknown })?.pubkeys;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0)
    .map(([userId, publicKey]) => ({ userId, publicKey }));
}

/**
 * The workspace of the person's active mandate(s) under `workspaceOf` (the
 * caller's own profile — Setup's): that one when they all sit in one
 * workspace, the personal workspace when there are none (or no profile is
 * named), and a refusal naming the workspaces when there are several — the AI
 * must then say which (`team`), never guess.
 */
async function delegationWorkspace<G extends { id: string; name: string; isPersonal?: boolean }>(
  deps: CeremonyDeps,
  groups: G[],
  workspaceOf: string | undefined,
): Promise<G | undefined> {
  const personal = groups.find(g => g.isPersonal);
  if (!workspaceOf) return personal;
  const mine = await deps.as('GET', '/api/mandates/mine?status=active');
  const rows = (mine.status === 200 ? mine.body?.mandates ?? [] : []) as Array<{ profileId?: string; groupId?: string }>;
  const own = shortOf(workspaceOf);
  const ids = new Set(rows.filter(r => r.profileId && shortOf(r.profileId) === own && r.groupId).map(r => r.groupId!));
  const found = groups.filter(g => ids.has(g.id));
  if (found.length === 0) return personal;
  if (found.length === 1) return found[0];
  const names = found.map(g => (g.isPersonal ? 'the personal workspace' : `"${g.name}"`)).join(', ');
  refuse(`Setup mandates exist in several workspaces (${names}): say which in \`team\` — a team's name, or "personal".`);
}

/** The workspace, the profile and the person's right to give it — everything before limits and scope. */
async function resolveWorkspaceAndRight(req: Pick<MandateRequest, 'team' | 'profile' | 'workspaceOf'>, deps: CeremonyDeps) {
  const user = deps.user;
  if (!user) refuse('The gateway is not signed in.');

  // Workspace: a named team, or — unnamed — where the person's Delegation
  // mandate lives. That mandate is the person's "AI may set up mandates for me
  // here"; creating in another workspace sends the new mandate's review
  // requests to a queue the person is not looking at (found 2026-10-05).
  const groupsRes = await deps.as('GET', '/api/groups');
  const groups = (groupsRes.body?.groups ?? []) as Array<{ id: string; name: string; isPersonal?: boolean; allowLazyEnable?: boolean }>;
  const group = req.team === 'personal'
    ? groups.find(g => g.isPersonal)
    : req.team
      ? groups.find(g => !g.isPersonal && (g.id === req.team || g.name === req.team))
      : await delegationWorkspace(deps, groups, req.workspaceOf);
  if (!group) refuse(req.team && req.team !== 'personal' ? `You are not a member of a team "${req.team}".` : 'No personal workspace found.');
  const isPersonal = !!group.isPersonal;

  const profile = await resolveProfile(deps.as, req.profile);
  const name = profile.name ?? shortOf(profile.id);

  // Rights — the Authority Server's team authority gate, up front.
  let approvers: string[] = [];
  let teamCaps: Record<string, unknown> = {};
  let teamApprovals: number | undefined;
  let teamEligible: Array<{ user_id: string; did: string | null }> | undefined;
  if (!isPersonal) {
    const cfg = await deps.as('GET', `/api/groups/${encodeURIComponent(group.id)}/profile-config/${encodeURIComponent(profile.id)}`);
    approvers = (cfg.status === 200 ? cfg.body?.config?.approvers : undefined) ?? [];
    teamCaps = (cfg.status === 200 ? cfg.body?.config?.caps : undefined) ?? {};
    teamApprovals = typeof cfg.body?.config?.approvals === 'number' ? cfg.body.config.approvals : undefined;
    teamEligible = Array.isArray(cfg.body?.eligible_approvers) ? cfg.body.eligible_approvers : undefined;
    // Who may give this mandate is `grantors`; `approvers` only decide above-cap actions, and a team may have none.
    const grantors: string[] | 'all' = (cfg.status === 200 ? cfg.body?.config?.grantors : undefined) ?? approvers;
    // The AS carries a team's settings over from an older version of the same
    // profile; an empty answer here means nothing could be carried (none
    // configured, or the new version adds a limit that needs a value).
    if (grantors !== 'all' && grantors.length === 0) refuse(`${name} ${versionOf(profile.id)} is not enabled in "${group.name}". Ask an admin of "${group.name}" to enable ${name} ${versionOf(profile.id)} and name who may give its mandates.`, 'profile_not_enabled');
    if (grantors !== 'all' && !grantors.includes(user.id)) refuse(`Only ${name}'s approvers in "${group.name}" can give this mandate, and the signed-in person is not one of them.`, 'not_a_grantor');
  }
  return { user, group, isPersonal, profile, name, approvers, teamCaps, teamApprovals, teamEligible };
}

/**
 * Only the team authority gate: may the signed-in person give a mandate for this profile in this
 * workspace? Throws {@link MandateRefused} (with a code) when not — so the gateway can tell a person,
 * before anything is proposed, that a team admin must enable a profile.
 */
export async function checkMandateRight(
  req: Pick<MandateRequest, 'team' | 'profile'>,
  deps: CeremonyDeps,
): Promise<{ groupName: string; profileId: string }> {
  const r = await resolveWorkspaceAndRight(req, deps);
  return { groupName: r.group.name, profileId: r.profile.id };
}

/**
 * A bound the profile marks `required` and gives a `default` is filled with that default when the
 * request leaves it out (hap-core's validation ignores defaults). Generic: read from the profile
 * schema only. A value the request did set, 0 included, is never changed.
 */
export function fillRequiredDefaults<T extends Record<string, unknown>>(limits: T, profile: { boundsSchema?: { fields?: Record<string, unknown> } }): T {
  const out: Record<string, unknown> = { ...limits };
  for (const [field, def] of Object.entries(profile.boundsSchema?.fields ?? {})) {
    const d = def as { required?: boolean; default?: unknown } | undefined;
    if (d?.required === true && out[field] === undefined && d.default !== undefined && d.default !== null) out[field] = d.default;
  }
  return out as T;
}

/** Validate the request and resolve everything needed — creates nothing. */
export async function planMandate(req: MandateRequest, deps: CeremonyDeps): Promise<MandatePlan> {
  const { user, group, isPersonal, profile, name, approvers, teamCaps, teamApprovals, teamEligible } = await resolveWorkspaceAndRight(req, deps);

  // Limits and scope against the profile.
  const bounds = { ...fillRequiredDefaults(scalarRecord('limits', req.limits), profile), profile: profile.id };
  const bv = validateBoundsParams(bounds as never, profile);
  const errors = [...bv.errors];
  for (const [field, value] of Object.entries(bounds)) {
    const bt = profile.boundsSchema?.fields[field]?.boundType as { kind?: string; values?: string[] } | undefined;
    if (bt?.kind === 'enum' && Array.isArray(bt.values) && !bt.values.includes(String(value))) {
      errors.push(`Field "${field}" must be one of ${bt.values.join(', ')}.`);
    }
    // A profile-declared ceiling on what a mandate may grant (e.g. reporting@0.2
    // read_max_age_days: 366) — refused here, before any proposal exists.
    const maximum = (profile.boundsSchema?.fields[field] as { maximum?: unknown } | undefined)?.maximum;
    if (typeof maximum === 'number' && typeof value === 'number' && value > maximum) {
      errors.push(`Field "${field}" may be at most ${maximum}.`);
    }
  }
  // A team's cap on a limit the gateway enforces itself must be set on the mandate; the Authority Server
  // refuses it otherwise. Say so now, before the person is asked to approve something that cannot be created.
  for (const [field, cap] of Object.entries(teamCaps)) {
    const def = profile.boundsSchema?.fields[field] as { enforcedBy?: string } | undefined;
    if (def?.enforcedBy !== 'gatekeeper' || bounds[field as keyof typeof bounds] !== undefined) continue;
    const value = typeof cap === 'object' && cap !== null ? (cap as { value?: unknown }).value : cap;
    errors.push(`"${group.name}" requires limit "${field}" on this mandate: set it in \`limits\`, at most ${String(value)}.`);
  }
  const context = scalarRecord('scope', req.scope);
  errors.push(...validateScopeParams(context as never, profile).errors);
  if (errors.length) refuse(`The mandate does not fit profile ${profile.id}: ${errors.join(' ')}`);
  // The profile's `scopeSchema.atLeastOne`: while the limits allow a listed action,
  // an empty group would mean "no limit" (scope-rules.ts). Never reaches the AS.
  const unmet = unmetForMandate(profile, context, bounds);
  if (unmet.length) refuse(atLeastOneBuildRefusal(profile, unmet[0]), 'scope_at_least_one');

  if (!isCommitmentModeAllowed(profile, req.mode)) {
    refuse(`Profile ${profile.id} allows mode ${allowedCommitmentModes(profile).join(' or ') || 'none'}, not "${req.mode}".`);
  }

  const ttlSeconds = req.ttlSeconds !== undefined
    ? req.ttlSeconds
    : req.durationHours === undefined ? profile.ttl.default : Math.round(req.durationHours * 3600);
  if (!(ttlSeconds > 0)) refuse('`duration_hours` must be positive.');
  if (ttlSeconds > profile.ttl.max) refuse(`At most ${profile.ttl.max / 3600} hours for profile ${profile.id}.`);

  const intent = typeof req.intent === 'string' ? req.intent.trim() : '';
  if (!intent) refuse('`intent` is required — the why, goal and watch-outs, in the person\'s words.');
  if (intent.length > INTENT_MAX) refuse(`\`intent\` is ${intent.length} characters; the limit is ${INTENT_MAX}.`);

  return {
    groupId: group.id,
    groupName: group.name,
    isPersonal,
    domain: isPersonal ? 'owner' : user.id,
    profile,
    bounds,
    context,
    intent,
    mode: req.mode as 'review' | 'automatic',
    ttlSeconds,
    title: (req.title ?? '').trim() || `${name} (proposed by AI)`,
    approvers,
    team: isPersonal ? null : { approvers, ...(teamApprovals !== undefined ? { approvals: teamApprovals } : {}), caps: teamCaps, ...(teamEligible ? { eligible: teamEligible } : {}) },
  };
}

/**
 * Retire a mandate after its replacement is signed AND delivered — never before,
 * so a failed delivery can never leave the person with no mandate at all.
 *
 * First the old mandate stops being honoured on this gateway (the local record,
 * replaced-mandates.ts): from that moment only the new limits apply here, even
 * while the Authority Server still serves the old one. Then the revoke at the
 * AS. A failed revoke is returned, never swallowed, and stays in the record so
 * replaced-revoke-retry.ts retries it until the AS confirms.
 */
async function retireReplaced(oldId: string, newId: string, deps: CeremonyDeps): Promise<RetireResult> {
  let oldStoppedLocally = false;
  if (deps.replaced) {
    try {
      await deps.replaced.record(oldId, newId);
      oldStoppedLocally = true;
    } catch (err) {
      console.error('[Control Plane] could not record the replaced mandate locally:', err instanceof Error ? err.message : err);
    }
  }
  const revokeError = await revokeReplaced(oldId, newId, deps);
  if (revokeError) {
    if (oldStoppedLocally) await deps.replaced!.noteAttempt(oldId, revokeError).catch(() => {});
    return { revokeError, ...(oldStoppedLocally ? { oldStoppedLocally } : {}) };
  }
  if (oldStoppedLocally) await deps.replaced!.clear(oldId).catch(() => {});
  void deps.resyncGates?.().catch(() => {});
  return {};
}

/** One revoke attempt at the AS. Undefined = done (revoked now, or already). */
export async function revokeReplaced(oldId: string, newId: string, deps: Pick<CeremonyDeps, 'as'>): Promise<string | undefined> {
  let res: AsResponse;
  try {
    res = await deps.as('POST', `/api/authorizations/${encodeURIComponent(oldId)}/revoke`, { reason: `Replaced by ${newId}` });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  // Already revoked (409) is what was wanted.
  if (res.status >= 300 && res.status !== 409) return readRefusal(res.body, `status ${res.status}`).message;
  return undefined;
}

/** Create the mandate the plan describes (and retire the one it replaces). Returns its authorization id. */
export async function createMandate(req: MandateRequest, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan } & RetireResult> {
  const plan = await planMandate(req, deps);
  const user = deps.user!;
  // A device chain: the mandate is granted on this computer with its check first, then requested (device-keys plan 4.4).
  if (deps.grants?.active()) return createGranted(req, plan, deps);

  const boundsHash = computeBoundsHash(plan.bounds as never, plan.profile);
  const scopeHash = computeScopeHash(plan.context as never, plan.profile);
  const intentHash = computeIntentHash(plan.intent);
  // v0.8: the hash of the profile's executionContextSchema, not of per-call values.
  const ecHash = computeExecutionContextHash(plan.profile);

  // Encrypt the intent for the team's approvers, like the sign page (eager, so a
  // cap tightened later still has the record).
  let enc: EncryptedIntent | undefined;
  if (!plan.isPersonal) {
    const keys = await deps.as(
      'GET',
      `/api/groups/${encodeURIComponent(plan.groupId)}/profile-config/${encodeURIComponent(plan.profile.id)}/approvers/pubkeys`,
    );
    const recipients = approverPubkeys(keys.body);
    if (recipients.length > 0) enc = await deps.encrypt(plan.intent, recipients);
  }

  const authorizationId = deps.newAuthorizationId();
  const res = await deps.as('POST', '/api/as/mandate', {
    authorization_id: authorizationId,
    profile_id: plan.profile.id,
    profile_hash: computeProfileHash(plan.profile),
    // v0.8: every version this gateway verifies and enforces, newest first
    // (protocol.md → Version negotiation, rule 1). Today's 0.7 AS issues 0.7,
    // a 0.8 AS issues 0.8 — the gateway reads each under its own rules.
    supported_versions: [...SUPPORTED_VERSIONS],
    bounds: plan.bounds,
    bounds_hash: boundsHash,
    scope_hash: scopeHash,
    domain: plan.domain,
    did: user.did,
    mandate_owners: [{ did: user.did }],
    gate_content_hashes: { intent: intentHash },
    execution_context_hash: ecHash,
    group_id: plan.groupId,
    ttl: plan.ttlSeconds,
    commitment_mode: plan.mode,
    title: plan.title,
    intent_ciphertext: enc?.intentCiphertext,
    encrypted_keys: enc?.encryptedKeys,
    approvers_frozen: enc?.approversFrozen,
    intent_disclosure_hash: enc?.intentDisclosureHash,
    ...(req.replaces ? { replaces: req.replaces } : {}),
    ...(req.discloseIdentity !== undefined ? { disclose_identity: req.discloseIdentity } : {}),
  });
  if (res.status >= 300) {
    refuse(`The Authority Server refused the mandate: ${readRefusal(res.body, `status ${res.status}`).message}`);
  }

  try {
    await deps.deliverGateContent({
      authorizationId,
      boundsHash,
      contextHash: scopeHash,
      context: plan.context,
      ...(req.contextLabels && Object.keys(req.contextLabels).length > 0 ? { contextLabels: req.contextLabels } : {}),
      gateContent: { intent: plan.intent },
    });
  } catch (err) {
    // Same rule as the sign page: a mandate whose intent never reached the
    // gateway must not stay active.
    await deps.as('POST', `/api/authorizations/${encodeURIComponent(authorizationId)}/revoke`, {
      reason: 'Auto-revoked: gate content delivery failed',
    }).catch(() => {});
    refuse(`The mandate was signed but its intent could not be delivered to the gateway, so it was revoked. (${err instanceof Error ? err.message : String(err)})`, 'delivery_failed');
  }
  const retired = req.replaces ? await retireReplaced(req.replaces, authorizationId, deps) : {};
  return { authorizationId, plan, ...retired };
}

/** A refusal of the grant, in the ceremony's own words: the code and, for an approver's identity code, the people to compare. */
function grantRefused(err: unknown): never {
  if (err instanceof GrantRefusal) {
    throw new MandateRefused(err.message, 'grant_refused', { grantCode: err.code, ...err.extra });
  }
  throw err;
}

/** Will the Authority Server put the owner's verified name on the mandate? It stamps `subjects` for a verified identity the person (or their standing choice) discloses; the grant covers the result. */
async function subjectsDisclosed(deps: CeremonyDeps, discloseIdentity: boolean | undefined): Promise<boolean> {
  const r = await deps.as('GET', '/api/users/me/identity-disclosure');
  if (r.status !== 200) refuse('The Authority Server did not say whether your verified name is shown, so the mandate was not granted.');
  return r.body?.verified === true && (discloseIdentity === true || r.body?.always === true);
}

/**
 * The same ceremony for a gateway with a device chain (device-keys plan 4.4): the mandate is built here with the
 * team's approvers, caps and count, granted on this computer with its check (a Touch ID touch), its sealed body
 * stored, and only then requested from the Authority Server, which signs exactly what was granted or refuses.
 * Nothing falls back to a mandate without a grant. A change of an existing mandate is a new version under the
 * same mandate id; the Authority Server ends the older authorization when the new one is issued.
 */
/** Everything the request of a granted mandate needs besides the grant itself. */
interface GrantedContext {
  req: MandateRequest;
  plan: MandatePlan;
  authorizationId: string;
  profileHash: string;
  boundsHash: string;
  scopeHash: string;
  intentHash: string;
  ecHash: string;
  enc?: EncryptedIntent;
  issueInput: Parameters<MandateGrants['issue']>[0];
}

/** The hashes, the intent sealed to the approvers and the input of the grant: computed once, the same for a give here and on the phone. */
async function grantedContext(req: MandateRequest, plan: MandatePlan, deps: CeremonyDeps): Promise<GrantedContext> {
  const user = deps.user!;
  const boundsHash = computeBoundsHash(plan.bounds as never, plan.profile);
  const scopeHash = computeScopeHash(plan.context as never, plan.profile);
  const intentHash = computeIntentHash(plan.intent);
  const ecHash = computeExecutionContextHash(plan.profile);
  const profileHash = computeProfileHash(plan.profile);

  let enc: EncryptedIntent | undefined;
  if (!plan.isPersonal) {
    const keys = await deps.as('GET', `/api/groups/${encodeURIComponent(plan.groupId)}/profile-config/${encodeURIComponent(plan.profile.id)}/approvers/pubkeys`);
    const recipients = approverPubkeys(keys.body);
    if (recipients.length > 0) enc = await deps.encrypt(plan.intent, recipients);
  }
  const disclosed = await subjectsDisclosed(deps, req.discloseIdentity);

  const authorizationId = deps.newAuthorizationId();
  const preChosenMandateId = deps.newMandateId?.();
  const issueInput: Parameters<MandateGrants['issue']>[0] = {
    ownUserId: user.id, ownDid: user.did, groupId: plan.groupId, isPersonal: plan.isPersonal, profile: plan.profile,
    bounds: plan.bounds as Record<string, string | number>, scope: plan.context, intent: plan.intent, mode: plan.mode, ttlSeconds: plan.ttlSeconds,
    authorizationId, ...(req.replaces ? { replaces: req.replaces } : {}),
    ...(preChosenMandateId ? { mandateId: preChosenMandateId } : {}),
    hashes: { profile: profileHash, bounds: boundsHash, scope: scopeHash, intent: intentHash, executionContext: ecHash },
    ...(enc ? { intentDisclosureHash: enc.intentDisclosureHash } : {}),
    subjectsDisclosed: disclosed, team: plan.team,
    ...(req.confirmedApproverDids ? { confirmedApproverDids: req.confirmedApproverDids } : {}),
    as: deps.as,
  };
  return { req, plan, authorizationId, profileHash, boundsHash, scopeHash, intentHash, ecHash, ...(enc ? { enc } : {}), issueInput };
}

async function createGranted(req: MandateRequest, plan: MandatePlan, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan; revokeError?: string }> {
  const ctx = await grantedContext(req, plan, deps);
  let issued: Issued;
  try {
    issued = await deps.grants!.issue(ctx.issueInput, { onTouched: () => deps.progress?.('touched') });
  } catch (err) { return grantRefused(err); }
  return requestGranted(ctx, issued, deps);
}

// ─── give on the phone (device-keys plan 4.4 "Transport", DEC-86) ──────────────

/** What the ceremony keeps of a give waiting on the phone: the context without its functions (it is sealed in the vault, see phone-give-store.ts). */
type StoredContext = Omit<GrantedContext, 'issueInput'>;

/**
 * Prepare the give for the person's phone instead of granting it here (a computer without a check key, or the person chose the phone):
 * the same plan and the same grant members as `createMandate` on this gateway, sealed to the person's devices. Nothing is requested from
 * the Authority Server until the phone's grant is here and matches (`pollPhoneGive`). The wait is kept in the vault across a restart.
 */
export async function giveOnPhone(req: MandateRequest, deps: CeremonyDeps, o: { proposalId?: string; requestContext?: Record<string, unknown> } = {}): Promise<{ mandateId: string; mandateVersion: number; expiresAt: number }> {
  if (!deps.grants?.active()) refuse('This gateway has no device chain, so there is no phone to give the mandate on.');
  // One give per AI proposal: the one already waiting (offered when the proposal arrived, or sent from the card) is the one the phone shows.
  if (o.proposalId) {
    const waiting = deps.grants!.phoneGives.byProposal(o.proposalId);
    if (waiting) {
      const g = waiting.record.give as { mandateVersion?: unknown; expiresAt?: unknown };
      if (typeof g.mandateVersion === 'number' && typeof g.expiresAt === 'number') return { mandateId: waiting.mandateId, mandateVersion: g.mandateVersion, expiresAt: g.expiresAt };
    }
  }
  const plan = await planMandate(req, deps);
  const ctx = await grantedContext(req, plan, deps);
  let give: PhoneGive;
  try {
    give = await deps.grants!.sendToPhone(ctx.issueInput, {
      title: plan.title,
      workspace: plan.groupName,
      ...(req.replaces ? { previous: await previousOf(req.replaces, deps) } : {}),
      ...(o.proposalId ? { proposalId: o.proposalId } : {}),
      ...(o.requestContext ? { requestContext: o.requestContext } : {}),
    });
  } catch (err) { return grantRefused(err); }
  const { issueInput: _fn, ...stored } = ctx;
  deps.grants!.phoneGives.hold(give.mandateId, { give: give as unknown as Record<string, unknown>, ctx: stored as unknown as Record<string, unknown>, ...(o.proposalId ? { proposalId: o.proposalId } : {}) });
  return { mandateId: give.mandateId, mandateVersion: give.mandateVersion, expiresAt: give.expiresAt };
}

/** Stop waiting for the give of this AI proposal on the phone (it was given on this computer instead). True when one was waiting. */
export function dropProposalGive(proposalId: string, deps: CeremonyDeps): boolean {
  const waiting = deps.grants?.phoneGives.byProposal(proposalId);
  return waiting ? deps.grants!.phoneGives.drop(waiting.mandateId) : false;
}

/** The version a change continues, from this computer's own copy; undefined when it cannot be read (the grants refuse then). */
async function previousOf(authorizationId: string, deps: CeremonyDeps): Promise<PhonePrevious | undefined> {
  const old = await deps.signedMandate?.(authorizationId).catch(() => null);
  if (!old) return undefined;
  const profile = await resolveProfile(deps.as, old.profileId).catch(() => null);
  if (!profile) return undefined;
  return { profile, bounds: old.bounds, scope: old.context, intent: old.intent, expires_at: old.expiresAt };
}

/**
 * Has the phone given it? `waiting` while no grant of that version is stored; `done` once the phone's grant verified here with exactly the
 * planned members AND the Authority Server issued the mandate; a refusal throws (and ends the wait). `unknown`: nothing waits under this id.
 */
export async function pollPhoneGive(mandateId: string, deps: CeremonyDeps): Promise<{ state: 'waiting' | 'unknown' } | { state: 'done'; authorizationId: string; revokeError?: string }> {
  // The page and the background completion may ask at the same moment: one check at a time per give, so a mandate is never requested twice.
  if (phoneGiveInFlight.has(mandateId)) return { state: 'waiting' };
  phoneGiveInFlight.add(mandateId);
  try {
    return await pollPhoneGiveOnce(mandateId, deps);
  } finally {
    phoneGiveInFlight.delete(mandateId);
  }
}

const phoneGiveInFlight = new Set<string>();

/**
 * AI proposals a give carried out, by proposal id: the mandate now in force and whether it was a change. The proposal is closed as
 * `replaced` (the Authority Server knows no other word for "closed because the person gave a mandate"); this tells the AI path that
 * it was ITS proposal that went into force, not a version of the person's own. Kept a day in this process: a restart forgets it and
 * the AI then hears the generic "replaced" line, which names list-authorizations.
 */
const givenForProposal = new Map<string, { at: number; authorizationId: string; op: 'grant' | 'change' }>();
const GIVEN_KEEP_MS = 24 * 3600_000;
export function noteProposalGiven(proposalId: string, authorizationId: string, op: 'grant' | 'change'): void {
  givenForProposal.set(proposalId, { at: Date.now(), authorizationId, op });
  for (const [id, g] of givenForProposal) if (Date.now() - g.at >= GIVEN_KEEP_MS) givenForProposal.delete(id);
}
/** What became of an AI proposal's give: in force (`given`), still waiting on the phone (`waiting`), or nothing known here. */
export function proposalGiveState(proposalId: string, deps: CeremonyDeps): { given: { authorizationId: string; op: 'grant' | 'change' } } | { waiting: true } | Record<string, never> {
  const g = givenForProposal.get(proposalId);
  if (g && Date.now() - g.at < GIVEN_KEEP_MS) return { given: { authorizationId: g.authorizationId, op: g.op } };
  return deps.grants?.phoneGives.byProposal(proposalId) ? { waiting: true } : {};
}
/** Gives finished in this process, kept a little while so a later ask (the page after the background, or the reverse) hears "done". */
const phoneGiveDone = new Map<string, { at: number; authorizationId: string; revokeError?: string }>();
const PHONE_GIVE_DONE_KEEP_MS = 10 * 60_000;
/** Gives REFUSED in this process, kept as long: whoever asks next (the page after the background completion) hears the same refusal, never
 *  "nothing waits" — the person must see why nothing was given (a phone's grant over other values), not "Stopped". */
const phoneGiveRefused = new Map<string, { at: number; err: unknown }>();

async function pollPhoneGiveOnce(mandateId: string, deps: CeremonyDeps): Promise<{ state: 'waiting' | 'unknown' } | { state: 'done'; authorizationId: string; revokeError?: string }> {
  const store = deps.grants!.phoneGives;
  const p = store.get(mandateId);
  if (!p) {
    // Finished a moment ago by the other asker (the page or the background completion): the same answer, not "nothing waits".
    const done = phoneGiveDone.get(mandateId);
    if (done && Date.now() - done.at < PHONE_GIVE_DONE_KEEP_MS) return { state: 'done', authorizationId: done.authorizationId, ...(done.revokeError ? { revokeError: done.revokeError } : {}) };
    const refused = phoneGiveRefused.get(mandateId);
    if (refused && Date.now() - refused.at < PHONE_GIVE_DONE_KEEP_MS) grantRefused(refused.err);
    return { state: 'unknown' };
  }
  let issued: Issued | null;
  try {
    issued = await deps.grants!.phoneGrant(p.give as unknown as PhoneGive);
  } catch (err) {
    store.drop(mandateId);
    phoneGiveRefused.set(mandateId, { at: Date.now(), err });
    for (const [id, r] of phoneGiveRefused) if (Date.now() - r.at >= PHONE_GIVE_DONE_KEEP_MS) phoneGiveRefused.delete(id);
    return grantRefused(err);
  }
  if (!issued) return { state: 'waiting' };
  store.drop(mandateId);
  const rc = p.ctx as { kind?: unknown; req?: RenewRequest; asBody?: Record<string, unknown>; boundsHash?: string; scopeHash?: string };
  const r: { authorizationId: string; revokeError?: string } = rc.kind === 'renew'
    ? await requestRenewal(rc.req!, rc.asBody!, rc.boundsHash!, rc.scopeHash!, issued, deps)
    : await requestGranted(p.ctx as unknown as StoredContext, issued, deps);
  phoneGiveDone.set(mandateId, { at: Date.now(), authorizationId: r.authorizationId, ...(r.revokeError ? { revokeError: r.revokeError } : {}) });
  if (p.proposalId) noteProposalGiven(p.proposalId, r.authorizationId, (p.give as { op?: unknown }).op === 'change' ? 'change' : 'grant');
  for (const [id, d] of phoneGiveDone) if (Date.now() - d.at >= PHONE_GIVE_DONE_KEEP_MS) phoneGiveDone.delete(id);
  return { state: 'done', authorizationId: r.authorizationId, ...(r.revokeError ? { revokeError: r.revokeError } : {}) };
}

/**
 * A change the person approved (an AI proposal, setup__change_mandate) on a computer that cannot grant it: the same checks as
 * `changeMandate` (the diff still the one approved), then sent to the phone like a give from the page (DEC-90).
 */
export async function changeOnPhone(req: MandateChangeRequest, deps: CeremonyDeps, o: { proposalId?: string } = {}): Promise<{ mandateId: string; mandateVersion: number; expiresAt: number }> {
  const { diff, request } = await planMandateChange(req, deps);
  if (req.sealedDiff && diffForCompare(diff) !== diffForCompare(req.sealedDiff)) {
    refuse('The mandate or its area changed after this was proposed, so what you approved is no longer what would be signed. Nothing was signed. Ask for the change again.', 'changed_since_proposal');
  }
  return giveOnPhone(request, deps, o);
}

/** Gives a page on this computer is waiting for (its card or give page asks every 2 s): that page shows "Signed" and then closes
 *  the AI's request itself — closing it here first would take the card away before the person sees the result. */
const pageWaiting = new Map<string, number>();
const PAGE_WAITING_MS = 6_000;
export function notePageWaiting(mandateId: string): void { pageWaiting.set(mandateId, Date.now()); }
/** The page heard the end of its give: it no longer waits. (A change keeps its mandate's id: without this, the page that gave
 *  version 1 a moment ago still counted as waiting when version 2 came from the phone, and that request was never closed —
 *  e2e 45264582001, 45253266621.) */
export function notePageDone(mandateId: string): void { pageWaiting.delete(mandateId); }
export function pageIsWaiting(mandateId: string): boolean {
  const at = pageWaiting.get(mandateId);
  return at !== undefined && Date.now() - at < PAGE_WAITING_MS;
}

/** Is any give waiting on the person's phone? (The completion checks every second while one waits, every 5 s otherwise.) */
export function anyGiveWaiting(deps: CeremonyDeps): boolean {
  try { return !!deps.grants?.active() && deps.grants.phoneGives.list().length > 0; } catch { return false; }
}

/** Can this gateway hand a grant to the person's phone (an active device of the chain, other than this one, with a check key)? */
export function isNoCheckKeyRefusal(err: unknown): boolean {
  return err instanceof MandateRefused && err.code === 'grant_refused' && (err.detail as { grantCode?: unknown } | undefined)?.grantCode === 'no_check_key';
}

/**
 * Finish every give that waits on the phone, page or not (an approved AI proposal has no page that polls): what the timer in index.ts
 * runs. A give whose phone grant arrived is requested and delivered; a refusal ends it. `onDone` is told of each mandate that went live.
 */
export async function completeWaitingGives(deps: CeremonyDeps, onDone: (r: { mandateId: string; authorizationId: string; proposalId?: string }) => void, onRefused?: (r: { mandateId: string; message: string }) => void): Promise<void> {
  if (!deps.grants?.active()) return;
  let waiting: Array<{ mandateId: string; proposalId?: string }>;
  try { waiting = deps.grants.phoneGives.list(); } catch { return; }
  for (const g of waiting) {
    try {
      const r = await pollPhoneGive(g.mandateId, deps);
      if (r.state === 'done') onDone({ mandateId: g.mandateId, authorizationId: r.authorizationId, ...(g.proposalId ? { proposalId: g.proposalId } : {}) });
    } catch (err) {
      onRefused?.({ mandateId: g.mandateId, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** The person stopped waiting for the phone on this page. The prepared row runs out at the Authority Server by itself. */
export function cancelPhoneGive(mandateId: string, deps: CeremonyDeps): boolean {
  return deps.grants?.phoneGives.drop(mandateId) ?? false;
}

/** Request the granted mandate from the Authority Server, deliver its gate content, retire what it replaces. */
async function requestGranted(ctx: StoredContext, issued: Issued, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan; revokeError?: string }> {
  const { req, plan, authorizationId, profileHash, boundsHash, scopeHash, intentHash, ecHash, enc } = ctx;
  const user = deps.user!;
  const grants = deps.grants!;
  deps.progress?.('requesting');
  const res = await deps.as('POST', '/api/as/mandate', {
    authorization_id: authorizationId,
    profile_id: plan.profile.id,
    profile_hash: profileHash,
    supported_versions: [...SUPPORTED_VERSIONS],
    bounds: plan.bounds,
    bounds_hash: boundsHash,
    scope_hash: scopeHash,
    domain: plan.domain,
    did: user.did,
    gate_content_hashes: { intent: intentHash },
    execution_context_hash: ecHash,
    group_id: plan.groupId,
    title: plan.title,
    intent_ciphertext: enc?.intentCiphertext,
    encrypted_keys: enc?.encryptedKeys,
    approvers_frozen: enc?.approversFrozen,
    intent_disclosure_hash: enc?.intentDisclosureHash,
    ...(req.replaces ? { replaces: req.replaces } : {}),
    ...(req.discloseIdentity !== undefined ? { disclose_identity: req.discloseIdentity } : {}),
    // What the grant covers, as the grant names it: the mandate id and version, the expiry (no ttl), mode, caps, approvers, count.
    ...issued.request,
  });
  if (res.status >= 300) {
    refuse(`The Authority Server refused the mandate: ${readRefusal(res.body, `status ${res.status}`).message}`);
  }
  deps.onIssued?.({ mandateId: issued.mandateId });
  deps.progress?.('delivering');
  try {
    await deps.deliverGateContent({
      authorizationId, boundsHash, contextHash: scopeHash, context: plan.context,
      ...(req.contextLabels && Object.keys(req.contextLabels).length > 0 ? { contextLabels: req.contextLabels } : {}),
      gateContent: { intent: plan.intent },
    });
  } catch (err) {
    // A mandate whose intent never reached the gateway must not stay active: ended with a device signature (final).
    await grants.revoke(authorizationId).catch(() => {});
    refuse(`The mandate was signed but its intent could not be delivered to the gateway, so it was revoked. (${err instanceof Error ? err.message : String(err)})`, 'delivery_failed');
  }
  // The Authority Server ended the authorization this one replaces in the same moment the new version was issued.
  if (req.replaces) void deps.resyncGates?.().catch(() => {});
  return { authorizationId, plan };
}

/** One shown value: the profile's label and unit for the field, from this gateway's copy of the profile. */
export interface PreparedRow { field: string; label: string; value: string | number; unit?: string }

/** What a give would grant, as this gateway checked it. The page shows exactly this and echoes `planHash` back with the give. */
export interface PreparedMandate {
  /** Binds the give to this plan: the gateway refuses a give whose request, or whose team part, differs (`changed_since_prepare`). */
  planHash: string;
  profileId: string;
  profileName: string;
  profileHash: string;
  mode: PreparedGrant['mode'];
  ttlSeconds: number;
  expiresAt: number;
  bounds: PreparedRow[];
  scope: PreparedRow[];
  intent: string;
  team: { approvers: PreparedGrant['approvers']; approvals: number | null; caps: PreparedRow[] } | null;
  /** The first refusal the real give would meet before the touch, or null. */
  blocked: PreparedGrant['blocked'];
  /** The person's phone can give it instead (`/give-on-phone`): another active device of their chain names a check key. */
  onPhone: boolean;
}

type FieldDef = { displayName?: string; unit?: string };
const rowsOf = (values: Record<string, string | number>, fields: Record<string, FieldDef> | undefined, skip: string[] = []): PreparedRow[] =>
  Object.entries(values).filter(([k]) => !skip.includes(k)).map(([field, value]) => ({ field, label: fields?.[field]?.displayName ?? field, value, ...(fields?.[field]?.unit ? { unit: fields[field]!.unit } : {}) }));

/**
 * A dry run of a give on a gateway with a device chain: the same validation and the same team computation as the real give, WITHOUT the touch
 * and without any write at the Authority Server or here (nothing is remembered, no grant, no body, no mandate). Refusals of the validation
 * (rights, limits, scope, duration) are thrown as {@link MandateRefused}, as the real give would; those the team part meets before the touch come
 * back as `blocked`, with the approvers the team's verified member list does not hold.
 */
export async function prepareMandate(req: MandateRequest, deps: CeremonyDeps): Promise<PreparedMandate> {
  const grants = deps.grants;
  if (!grants?.active()) refuse('Device keys are not set up on this gateway.');
  const plan = await planMandate(req, deps);
  const user = deps.user!;
  const profileHash = computeProfileHash(plan.profile);
  const disclosed = await subjectsDisclosed(deps, req.discloseIdentity);
  const pg = await grants.prepare({
    ownUserId: user.id, ownDid: user.did, groupId: plan.groupId, isPersonal: plan.isPersonal, profile: plan.profile,
    bounds: plan.bounds as Record<string, string | number>, scope: plan.context, intent: plan.intent, mode: plan.mode, ttlSeconds: plan.ttlSeconds,
    authorizationId: deps.newAuthorizationId(), ...(req.replaces ? { replaces: req.replaces } : {}),
    hashes: { profile: profileHash, bounds: computeBoundsHash(plan.bounds as never, plan.profile), scope: computeScopeHash(plan.context as never, plan.profile), intent: computeIntentHash(plan.intent), executionContext: computeExecutionContextHash(plan.profile) },
    subjectsDisclosed: disclosed, team: plan.team,
    ...(req.confirmedApproverDids ? { confirmedApproverDids: req.confirmedApproverDids } : {}),
    as: deps.as,
  });
  const caps = pg.caps ?? {};
  const planHash = `sha256:${createHash('sha256').update(canonicalize({
    profile_id: plan.profile.id, profile_hash: profileHash, group_id: plan.groupId, bounds: plan.bounds, scope: plan.context, intent: plan.intent,
    ttl_seconds: plan.ttlSeconds, title: plan.title, disclose_identity: req.discloseIdentity ?? null, replaces: req.replaces ?? null,
    mode: pg.mode, caps: pg.caps, approvals: pg.approvals, approvers: pg.approvers.map(a => a.did).sort(),
  } as never)).digest('hex')}`;
  return {
    planHash, profileId: plan.profile.id, profileName: plan.profile.name ?? plan.profile.id.replace(/@.*$/, '').split('/').pop() ?? plan.profile.id,
    profileHash, mode: pg.mode, ttlSeconds: plan.ttlSeconds, expiresAt: pg.expiresAt,
    bounds: rowsOf(plan.bounds as Record<string, string | number>, plan.profile.boundsSchema?.fields as Record<string, FieldDef> | undefined, ['profile', 'path']),
    scope: rowsOf(plan.context, plan.profile.scopeSchema?.fields as Record<string, FieldDef> | undefined),
    intent: plan.intent,
    team: plan.isPersonal ? null : { approvers: pg.approvers, approvals: pg.approvals, caps: rowsOf(caps, plan.profile.boundsSchema?.fields as Record<string, FieldDef> | undefined) },
    blocked: pg.blocked,
    onPhone: pg.onPhone,
  };
}

export interface RenewRequest {
  authorizationId: string;
  profileId: string;
  groupId: string;
  /** Exactly the signed values: renewing moves only the expiry, the AS refuses any other change. */
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string;
  mode: 'automatic' | 'review';
  domain: string;
  ttlSeconds: number;
  path?: string;
}

/** Extend = renew: the same per-ceremony id with `renew: true`. Only the expiry moves. */
export async function renewMandate(req: RenewRequest, deps: CeremonyDeps): Promise<{ authorizationId: string }> {
  const user = deps.user;
  if (!user) refuse('The gateway is not signed in.');
  const profile = await resolveProfile(deps.as, req.profileId);
  const boundsHash = computeBoundsHash(req.bounds as never, profile);
  const scopeHash = computeScopeHash(req.context as never, profile);
  if (deps.grants?.active()) return renewGranted(req, profile, boundsHash, scopeHash, deps);
  const res = await deps.as('POST', '/api/as/mandate', {
    authorization_id: req.authorizationId,
    renew: true,
    profile_id: profile.id,
    profile_hash: computeProfileHash(profile),
    supported_versions: [...SUPPORTED_VERSIONS],
    bounds: req.bounds,
    bounds_hash: boundsHash,
    scope_hash: scopeHash,
    domain: req.domain,
    did: user.did,
    mandate_owners: [{ did: user.did }],
    gate_content_hashes: { intent: computeIntentHash(req.intent) },
    execution_context_hash: computeExecutionContextHash(profile),
    group_id: req.groupId,
    commitment_mode: req.mode,
    ttl: req.ttlSeconds,
  });
  if (res.status >= 300) refuse(`The Authority Server refused the renewal: ${readRefusal(res.body, `status ${res.status}`).message}`);
  await deps.deliverGateContent({
    authorizationId: req.authorizationId,
    boundsHash: res.body?.bounds_hash ?? boundsHash,
    contextHash: scopeHash,
    context: req.context,
    gateContent: { intent: req.intent },
    ...(req.path ? { path: req.path } : {}),
  });
  return { authorizationId: req.authorizationId };
}


/** What a renewal grants: the issue input for the grant and the request it then makes (shared by this computer and the phone path). */
interface RenewPlan {
  input: IssueInput;
  asBody: Record<string, unknown>;
}

async function planRenewal(req: RenewRequest, profile: AgentProfile, boundsHash: string, scopeHash: string, deps: CeremonyDeps): Promise<RenewPlan> {
  const user = deps.user!;
  const groups = ((await deps.as('GET', '/api/groups')).body?.groups ?? []) as Array<{ id: string; isPersonal?: boolean }>;
  const group = groups.find(g => g.id === req.groupId);
  if (!group) refuse('This mandate belongs to a workspace you are not in.');
  let team: MandatePlan['team'] = null;
  if (!group.isPersonal) {
    const cfg = await deps.as('GET', `/api/groups/${encodeURIComponent(group.id)}/profile-config/${encodeURIComponent(profile.id)}`);
    if (cfg.status !== 200) refuse('The team settings could not be read, so the mandate was not extended.');
    team = {
      approvers: cfg.body?.config?.approvers ?? [],
      ...(typeof cfg.body?.config?.approvals === 'number' ? { approvals: cfg.body.config.approvals } : {}),
      caps: cfg.body?.config?.caps ?? {},
      ...(Array.isArray(cfg.body?.eligible_approvers) ? { eligible: cfg.body.eligible_approvers } : {}),
    };
  }
  const intentHash = computeIntentHash(req.intent);
  const ecHash = computeExecutionContextHash(profile);
  const profileHash = computeProfileHash(profile);
  return {
    input: {
      ownUserId: user.id, ownDid: user.did, groupId: req.groupId, isPersonal: !!group.isPersonal, profile,
      bounds: req.bounds, scope: req.context, intent: req.intent, mode: req.mode, ttlSeconds: req.ttlSeconds,
      authorizationId: req.authorizationId, renewal: true,
      hashes: { profile: profileHash, bounds: boundsHash, scope: scopeHash, intent: intentHash, executionContext: ecHash },
      subjectsDisclosed: false, team, as: deps.as,
    },
    asBody: {
      authorization_id: req.authorizationId,
      profile_id: profile.id,
      profile_hash: profileHash,
      supported_versions: [...SUPPORTED_VERSIONS],
      bounds: req.bounds,
      bounds_hash: boundsHash,
      scope_hash: scopeHash,
      domain: req.domain,
      did: user.did,
      gate_content_hashes: { intent: intentHash },
      execution_context_hash: ecHash,
      group_id: req.groupId,
    },
  };
}

/** Request the renewed version and deliver its gate content (after the grant, here or from the phone). */
async function requestRenewal(req: RenewRequest, asBody: Record<string, unknown>, boundsHash: string, scopeHash: string, issued: Issued, deps: CeremonyDeps): Promise<{ authorizationId: string }> {
  const res = await deps.as('POST', '/api/as/mandate', { ...asBody, ...issued.request });
  if (res.status >= 300) refuse(`The Authority Server refused the renewal: ${readRefusal(res.body, `status ${res.status}`).message}`);
  await deps.deliverGateContent({
    authorizationId: req.authorizationId,
    boundsHash: res.body?.bounds_hash ?? boundsHash,
    contextHash: scopeHash,
    context: req.context,
    gateContent: { intent: req.intent },
    ...(req.path ? { path: req.path } : {}),
  });
  return { authorizationId: req.authorizationId };
}

/** Extend = a `change` of the same mandate under the same authorization: granted again on this computer, only the expiry moves. */
async function renewGranted(req: RenewRequest, profile: AgentProfile, boundsHash: string, scopeHash: string, deps: CeremonyDeps): Promise<{ authorizationId: string }> {
  const plan = await planRenewal(req, profile, boundsHash, scopeHash, deps);
  let issued: Issued;
  try {
    issued = await deps.grants!.issue(plan.input);
  } catch (err) { return grantRefused(err); }
  return requestRenewal(req, plan.asBody, boundsHash, scopeHash, issued, deps);
}

/**
 * Extend on the phone (a computer without a check key, DEC-90): the same renewal plan, sent to the phone with the version it continues
 * (this computer's own copy), so the phone shows "lasts until" old → new and checks the rest is unchanged against the previous grant.
 */
export async function renewOnPhone(req: RenewRequest, deps: CeremonyDeps): Promise<{ mandateId: string; mandateVersion: number; expiresAt: number }> {
  if (!deps.grants?.active()) refuse('This gateway has no device chain, so there is no phone to extend the mandate on.');
  if (!deps.user) refuse('The gateway is not signed in.');
  const profile = await resolveProfile(deps.as, req.profileId);
  const boundsHash = computeBoundsHash(req.bounds as never, profile);
  const scopeHash = computeScopeHash(req.context as never, profile);
  const plan = await planRenewal(req, profile, boundsHash, scopeHash, deps);
  const previous = await previousOf(req.authorizationId, deps);
  if (!previous) refuse('The mandate being extended could not be read on this computer, so it was not sent to your phone.');
  let give: PhoneGive;
  try {
    give = await deps.grants!.sendToPhone(plan.input, { title: profile.name ?? profile.id, previous });
  } catch (err) { return grantRefused(err); }
  deps.grants!.phoneGives.hold(give.mandateId, {
    give: give as unknown as Record<string, unknown>,
    ctx: { kind: 'renew', req, asBody: plan.asBody, boundsHash, scopeHash } as unknown as Record<string, unknown>,
  });
  return { mandateId: give.mandateId, mandateVersion: give.mandateVersion, expiresAt: give.expiresAt };
}

// ─── Changing a mandate ─────────────────────────────────────────────────────

/** The signed mandate being changed, as the MCP server read it from its signed copy. */
export interface SignedMandate {
  authorizationId: string;
  profileId: string;
  groupId: string;
  ownerDid: string;
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  intent: string;
  mode: 'review' | 'automatic';
  /** Seconds since the epoch. */
  expiresAt: number;
  title?: string;
  /** The verified name shows on this mandate's actions. */
  disclosesIdentity?: boolean;
}

export interface MandateChangeRequest {
  old: SignedMandate;
  changes: {
    limits?: Record<string, unknown>;
    scope?: Record<string, unknown>;
    mode?: string;
    durationHours?: number;
    intent?: string;
  };
  /** On execution: the diff sealed with the proposal. A mandate that would differ from it is refused. */
  sealedDiff?: MandateDiff;
}

export interface MandateChangePlan {
  plan: MandatePlan;
  diff: MandateDiff;
  request: MandateRequest;
}

function unknownFields(label: string, values: Record<string, unknown> | undefined, schema: AgentProfile['boundsSchema'] | AgentProfile['scopeSchema'] | undefined): string[] {
  const declared = schema?.fields ?? {};
  return Object.keys(values ?? {}).filter(k => !(k in declared) || k === 'profile' || k === 'path').map(k => `\`${label}.${k}\``);
}

/** The values a newer profile version needs that the old mandate does not have. */
function newRequiredFields(values: Record<string, unknown>, schema: AgentProfile['boundsSchema'] | AgentProfile['scopeSchema'] | undefined): string[] {
  return Object.entries(schema?.fields ?? {})
    .filter(([k, def]) => k !== 'profile' && k !== 'path' && (def as { required?: boolean }).required && values[k] === undefined)
    .map(([k, def]) => (def as { displayName?: string }).displayName ?? k);
}

/** Build the new mandate from the signed old one and the changing values, and compute what differs. Creates nothing. */
export async function planMandateChange(req: MandateChangeRequest, deps: CeremonyDeps): Promise<MandateChangePlan> {
  const user = deps.user;
  if (!user) refuse('The gateway is not signed in.');
  const { old, changes } = req;

  // Only the person's own mandates. A group admin can revoke a colleague's on the AS;
  // the gateway must not turn that into a way for an AI to replace someone else's.
  if (old.ownerDid !== user.did) refuse('This mandate was given by someone else. Only the person who gave it can change it.', 'not_your_mandate');

  // Still active — the local list can lag behind the Authority Server.
  const mine = await deps.as('GET', '/api/mandates/mine?status=active');
  const rows = (mine.status === 200 ? mine.body?.mandates ?? [] : []) as Array<{ authorization_id?: string; authorizationId?: string }>;
  if (!rows.some(r => (r.authorization_id ?? r.authorizationId) === old.authorizationId)) {
    refuse('This mandate is no longer active, so there is nothing to change.', 'mandate_not_active');
  }

  // A change always moves to the newest version of the area's profile: the AS issues no other.
  const newest = await resolveProfile(deps.as, shortOf(old.profileId));
  const oldProfile = old.profileId === newest.id ? newest : await resolveProfile(deps.as, old.profileId);

  const bad = [...unknownFields('limits', changes.limits, newest.boundsSchema), ...unknownFields('scope', changes.scope, newest.scopeSchema)];
  if (bad.length) refuse(`${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not part of ${shortOf(newest.id)} ${versionOf(newest.id)}.`);

  const limits = { ...carryValues(old.bounds, newest.boundsSchema), ...scalarRecord('limits', changes.limits) } as Record<string, string | number>;
  const scope = { ...carryValues(old.context, newest.scopeSchema), ...scalarRecord('scope', changes.scope) } as Record<string, string | number>;

  // A field new in the newest version has no signed value and no default to lean on:
  // the person must say what it should be, so it reaches the card as a value they gave.
  const missing = [...newRequiredFields(limits, newest.boundsSchema), ...newRequiredFields(scope, newest.scopeSchema)];
  if (missing.length) {
    refuse(`${shortOf(newest.id)} ${versionOf(newest.id)} needs a value this mandate does not have yet: ${missing.join(', ')}. Ask the person, and include it in the change.`);
  }

  // The end date stays unless a new one is proposed.
  const nowSec = Math.floor(Date.now() / 1000);
  if (old.expiresAt <= nowSec) refuse('This mandate has already ended.', 'mandate_not_active');
  const ttlSeconds = changes.durationHours !== undefined
    ? Math.round(changes.durationHours * 3600)
    : Math.min(old.expiresAt - nowSec, newest.ttl.max);
  const expiresAt = changes.durationHours !== undefined ? nowSec + ttlSeconds : Math.min(old.expiresAt, nowSec + newest.ttl.max);

  const groups = (await deps.as('GET', '/api/groups')).body?.groups as Array<{ id: string; isPersonal?: boolean }> | undefined;
  const group = groups?.find(g => g.id === old.groupId);
  if (!group) refuse('This mandate belongs to a workspace you are not in.');

  const request: MandateRequest = {
    team: group.isPersonal ? 'personal' : old.groupId,
    profile: newest.id,
    limits,
    scope,
    intent: changes.intent ?? old.intent,
    mode: changes.mode ?? old.mode,
    ttlSeconds,
    title: old.title || (newest.name ?? shortOf(newest.id)),
    replaces: old.authorizationId,
    ...(old.disclosesIdentity ? { discloseIdentity: true } : {}),
  };
  // The same validation as a new mandate: rights, limits, scope, mode, duration, intent.
  const plan = await planMandate(request, deps);

  const diff = computeMandateDiff({
    before: { profile: oldProfile, bounds: old.bounds, scope: old.context, intent: old.intent, mode: old.mode, expiresAt: old.expiresAt },
    after: { profile: newest, bounds: limits, scope, intent: plan.intent, mode: plan.mode, expiresAt },
  });
  if (diffIsEmpty(diff)) refuse('These values are what the mandate already says, so there is nothing to change.', 'no_change');

  return { plan, diff, request };
}

/**
 * A change's end date moves when it is signed, so it is compared without its moving
 * part. Stable key order: the sealed copy travels as canonical JSON.
 */
function diffForCompare(d: MandateDiff): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sorted({ ...d, ...(d.lastsUntil ? { lastsUntil: { ...d.lastsUntil, after: 0 } } : {}) }));
}

/**
 * Sign the new mandate, deliver it, retire the old one. Runs after a person approved the
 * proposal, possibly long after: everything is computed again from the signed old mandate,
 * and anything that would differ from what the person saw is refused.
 */
export async function changeMandate(req: MandateChangeRequest, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan } & RetireResult> {
  const { diff, request } = await planMandateChange(req, deps);
  if (req.sealedDiff && diffForCompare(diff) !== diffForCompare(req.sealedDiff)) {
    refuse('The mandate or its area changed after this was proposed, so what you approved is no longer what would be signed. Nothing was signed. Ask for the change again.', 'changed_since_proposal');
  }
  return createMandate(request, deps);
}
