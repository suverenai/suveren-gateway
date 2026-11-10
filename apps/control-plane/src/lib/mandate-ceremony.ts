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
}

export class MandateRefused extends Error {
  /** Why, in a form a caller can act on without reading the sentence. */
  constructor(message: string, readonly code?: 'profile_not_enabled' | 'not_a_grantor' | 'not_your_mandate' | 'mandate_not_active' | 'no_change' | 'changed_since_proposal') { super(message); }
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
 * The workspace of the person's active Delegation mandate(s): that one when they
 * all sit in one workspace, the personal workspace when there are none, and a
 * refusal naming the workspaces when there are several — the AI must then say
 * which (`team`), never guess.
 */
async function delegationWorkspace<G extends { id: string; name: string; isPersonal?: boolean }>(
  deps: CeremonyDeps,
  groups: G[],
): Promise<G | undefined> {
  const personal = groups.find(g => g.isPersonal);
  const mine = await deps.as('GET', '/api/mandates/mine?status=active');
  const rows = (mine.status === 200 ? mine.body?.mandates ?? [] : []) as Array<{ profileId?: string; groupId?: string }>;
  const ids = new Set(rows.filter(r => r.profileId && shortOf(r.profileId) === 'delegation' && r.groupId).map(r => r.groupId!));
  const found = groups.filter(g => ids.has(g.id));
  if (found.length === 0) return personal;
  if (found.length === 1) return found[0];
  const names = found.map(g => (g.isPersonal ? 'the personal workspace' : `"${g.name}"`)).join(', ');
  refuse(`Setup mandates exist in several workspaces (${names}): say which in \`team\` — a team's name, or "personal".`);
}

/** The workspace, the profile and the person's right to give it — everything before limits and scope. */
async function resolveWorkspaceAndRight(req: Pick<MandateRequest, 'team' | 'profile'>, deps: CeremonyDeps) {
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
      : await delegationWorkspace(deps, groups);
  if (!group) refuse(req.team && req.team !== 'personal' ? `You are not a member of a team "${req.team}".` : 'No personal workspace found.');
  const isPersonal = !!group.isPersonal;

  const profile = await resolveProfile(deps.as, req.profile);
  const name = profile.name ?? shortOf(profile.id);

  // Rights — the Authority Server's team authority gate, up front.
  let approvers: string[] = [];
  let teamCaps: Record<string, unknown> = {};
  if (!isPersonal) {
    const cfg = await deps.as('GET', `/api/groups/${encodeURIComponent(group.id)}/profile-config/${encodeURIComponent(profile.id)}`);
    approvers = (cfg.status === 200 ? cfg.body?.config?.approvers : undefined) ?? [];
    teamCaps = (cfg.status === 200 ? cfg.body?.config?.caps : undefined) ?? {};
    // Who may give this mandate is `grantors`; `approvers` only decide above-cap actions, and a team may have none.
    const grantors: string[] | 'all' = (cfg.status === 200 ? cfg.body?.config?.grantors : undefined) ?? approvers;
    // The AS carries a team's settings over from an older version of the same
    // profile; an empty answer here means nothing could be carried (none
    // configured, or the new version adds a limit that needs a value).
    if (grantors !== 'all' && grantors.length === 0) refuse(`${name} ${versionOf(profile.id)} is not enabled in "${group.name}". Ask an admin of "${group.name}" to enable ${name} ${versionOf(profile.id)} and name who may give its mandates.`, 'profile_not_enabled');
    if (grantors !== 'all' && !grantors.includes(user.id)) refuse(`Only ${name}'s approvers in "${group.name}" can give this mandate, and the signed-in person is not one of them.`, 'not_a_grantor');
  }
  return { user, group, isPersonal, profile, name, approvers, teamCaps };
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

/** Validate the request and resolve everything needed — creates nothing. */
export async function planMandate(req: MandateRequest, deps: CeremonyDeps): Promise<MandatePlan> {
  const { user, group, isPersonal, profile, name, approvers, teamCaps } = await resolveWorkspaceAndRight(req, deps);

  // Limits and scope against the profile.
  const bounds = { ...scalarRecord('limits', req.limits), profile: profile.id };
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
  };
}

/**
 * Retire a mandate after its replacement is signed AND delivered — never before,
 * so a failed delivery can never leave the person with no mandate at all. Both are
 * live for a moment: a brief overlap is safe, a gap is not. A failed revoke is
 * returned, never swallowed: after a reduction the old, wider mandate stays live.
 */
async function retireReplaced(oldId: string, newId: string, deps: CeremonyDeps): Promise<{ revokeError?: string }> {
  let res: AsResponse;
  try {
    res = await deps.as('POST', `/api/authorizations/${encodeURIComponent(oldId)}/revoke`, { reason: `Replaced by ${newId}` });
  } catch (err) {
    return { revokeError: err instanceof Error ? err.message : String(err) };
  }
  // Already revoked (409) is what was wanted.
  if (res.status >= 300 && res.status !== 409) return { revokeError: readRefusal(res.body, `status ${res.status}`).message };
  void deps.resyncGates?.().catch(() => {});
  return {};
}

/** Create the mandate the plan describes (and retire the one it replaces). Returns its authorization id. */
export async function createMandate(req: MandateRequest, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan; revokeError?: string }> {
  const plan = await planMandate(req, deps);
  const user = deps.user!;

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
    refuse(`The mandate was signed but its intent could not be delivered to the gateway, so it was revoked. (${err instanceof Error ? err.message : String(err)})`);
  }
  const retired = req.replaces ? await retireReplaced(req.replaces, authorizationId, deps) : {};
  return { authorizationId, plan, ...retired };
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

/** A change's end date moves when it is signed, so it is compared without its moving part. */
function diffForCompare(d: MandateDiff): unknown {
  return { ...d, ...(d.lastsUntil ? { lastsUntil: { ...d.lastsUntil, after: 0 } } : {}) };
}

/**
 * Sign the new mandate, deliver it, retire the old one. Runs after a person approved the
 * proposal, possibly long after: everything is computed again from the signed old mandate,
 * and anything that would differ from what the person saw is refused.
 */
export async function changeMandate(req: MandateChangeRequest, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan; revokeError?: string }> {
  const { diff, request } = await planMandateChange(req, deps);
  if (req.sealedDiff && JSON.stringify(diffForCompare(diff)) !== JSON.stringify(diffForCompare(req.sealedDiff))) {
    refuse('The mandate or its area changed after this was proposed, so what you approved is no longer what would be signed. Nothing was signed. Ask for the change again.', 'changed_since_proposal');
  }
  return createMandate(request, deps);
}
