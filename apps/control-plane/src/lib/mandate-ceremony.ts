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
  computeProfileHash,
  isCommitmentModeAllowed,
  validateBoundsParams,
  validateScopeParams,
  PROTOCOL_VERSION,
  type AgentProfile,
} from '@hap/core';

export interface MandateRequest {
  /** Team id or name; absent = the personal workspace. */
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
  title?: string;
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
    gateContent: { intent: string };
  }) => Promise<void>;
  newAuthorizationId: () => string;
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

export class MandateRefused extends Error {}

const INTENT_MAX = 2000; // the mandate screen's limit

const shortOf = (id: string): string => id.replace(/@.*$/, '').split('/').pop() ?? id;
const versionOf = (id: string): string => id.split('@')[1] ?? '';

function refuse(msg: string): never {
  throw new MandateRefused(msg);
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
  refuse(`Delegation mandates exist in several workspaces (${names}): say which in \`team\` — a team's name, or "personal".`);
}

/** Validate the request and resolve everything needed — creates nothing. */
export async function planMandate(req: MandateRequest, deps: CeremonyDeps): Promise<MandatePlan> {
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
  if (!isPersonal) {
    const cfg = await deps.as('GET', `/api/groups/${encodeURIComponent(group.id)}/profile-config/${encodeURIComponent(profile.id)}`);
    approvers = (cfg.status === 200 ? cfg.body?.config?.approvers : undefined) ?? [];
    // The AS carries a team's settings over from an older version of the same
    // profile; an empty answer here means nothing could be carried (none
    // configured, or the new version adds a limit that needs a value).
    if (approvers.length === 0) refuse(`${name} ${versionOf(profile.id)} is not enabled in "${group.name}". Ask an admin of "${group.name}" to enable ${name} ${versionOf(profile.id)} and name who may give its mandates.`);
    if (!approvers.includes(user.id)) refuse(`Only ${name}'s approvers in "${group.name}" can give this mandate, and the signed-in person is not one of them.`);
  }

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
  const context = scalarRecord('scope', req.scope);
  errors.push(...validateScopeParams(context as never, profile).errors);
  if (errors.length) refuse(`The mandate does not fit profile ${profile.id}: ${errors.join(' ')}`);

  if (!isCommitmentModeAllowed(profile, req.mode)) {
    refuse(`Profile ${profile.id} allows mode ${allowedCommitmentModes(profile).join(' or ') || 'none'}, not "${req.mode}".`);
  }

  const ttlSeconds = req.durationHours === undefined ? profile.ttl.default : Math.round(req.durationHours * 3600);
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

/** Create the mandate the plan describes. Returns its authorization id. */
export async function createMandate(req: MandateRequest, deps: CeremonyDeps): Promise<{ authorizationId: string; plan: MandatePlan }> {
  const plan = await planMandate(req, deps);
  const user = deps.user!;

  const boundsHash = computeBoundsHash(plan.bounds as never, plan.profile);
  const scopeHash = computeScopeHash(plan.context as never, plan.profile);
  const intentHash = computeIntentHash(plan.intent);
  const ecHash = computeIntentHash(JSON.stringify({ profile: plan.profile.id, domain: plan.domain, group: plan.groupId }));

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
    supported_versions: [PROTOCOL_VERSION],
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
  });
  if (res.status >= 300) {
    const why = res.body?.message ?? res.body?.detail ?? res.body?.error ?? `status ${res.status}`;
    refuse(`The Authority Server refused the mandate: ${why}`);
  }

  try {
    await deps.deliverGateContent({ authorizationId, boundsHash, contextHash: scopeHash, context: plan.context, gateContent: { intent: plan.intent } });
  } catch (err) {
    // Same rule as the sign page: a mandate whose intent never reached the
    // gateway must not stay active.
    await deps.as('POST', `/api/authorizations/${encodeURIComponent(authorizationId)}/revoke`, {
      reason: 'Auto-revoked: gate content delivery failed',
    }).catch(() => {});
    refuse(`The mandate was signed but its intent could not be delivered to the gateway, so it was revoked. (${err instanceof Error ? err.message : String(err)})`);
  }
  return { authorizationId, plan };
}
