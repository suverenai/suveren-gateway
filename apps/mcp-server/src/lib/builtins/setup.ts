/**
 * `setup` — the gateway tools an AI uses to set up a test of itself AND
 * (since DL1, temp/briefs/dl-delegation-brief.md) to propose mandates and
 * its own working instructions on REAL systems, governed by the review-only
 * `delegation` profile: every call is a proposal a person approves before
 * anything changes.
 *
 * get_guide — and loading/clearing test data in connectors, declared on
 * THEIR manifests — stay simulation-only (decision 2): only `get_guide`
 * declares `simulationOnly` here; `create_mandate` / `set_agent_brief` no
 * longer do (decision 1).
 *
 * set_agent_brief — replaces the agent brief (context.md) with the proposed
 * text after approval; it applies from the next agent session.
 *
 * create_mandate — creates a new mandate for the signed-in person after
 * approval, exactly as the sign page would (control plane,
 * lib/mandate-ceremony.ts). Checked in full before the proposal (a dry run
 * with the same code), so nobody approves a mandate that could not be
 * created. Create only — editing stays with the person. Outside simulation,
 * the profile and mode it may propose are themselves bounded by the
 * delegation 0.4+ scope (decision 3: `allowed_profiles`/`allowed_modes`,
 * enforced by the Gatekeeper like any other scope — no new gating code);
 * Delegation itself can never be proposed (decision 4, enforced here,
 * independent of that scope).
 *
 * describe_mandate_proposal / describe_brief_proposal — internal (never
 * listed, never callable by an agent): the AU3 preview read `create_mandate`
 * / `set_agent_brief` declare for their own pending proposal, called only via
 * `/internal/preview` (see ../preview.ts).
 */
import { builtinText, builtinStructured, type BuiltinIntegration, type MandateCandidate } from '../builtin-integration';
import { CONTEXT_MAX_BYTES, writeContextFile, readContextFile } from '../context-loader';
import { isSimulationMode } from '../simulation-mode';
import type { BuiltinDeps } from './index';
import { controlPlaneMandate } from '../cp-mandate';
import { loadGuides, guideHeader, limitsSection, packageSection, fillGenerated, type SystemLine, type ProfileLike } from '../guides';
import { getAllManifests } from '../manifest-loader';
import { getConsumptionState } from '../consumption';
import { unifiedLineDiff } from '../unified-diff';
import { getProfile, type AgentProfile } from '@hap/core';
import type { IntegrationManager } from '../integration-manager';

/** The delegation profile by its short name, as a manifest names it: a mandate under
 *  any version governs these tools (0.1 grants keep working), and a new mandate is
 *  created under the newest version the Authority Server serves. */
export const DELEGATION_PROFILE = 'delegation';

/** Seeded into the Delegation mandate's intent (the person edits it and signs their
 *  own words). Written for two readers: the person signing — what they allow, in
 *  plain words — and the setup AI, which reads it as standing instructions. */
const DELEGATION_INTENT_HINT = [
  'Why — With test data only, I want to find out which routine parts of my work an AI could take over, so people gain time — before anything touches real systems.',
  '',
  'Goal — Follow the setup guide: interview me about the company, the team and the work; prepare test data from real cases, renamed to .example names; propose the mandates and the working instructions (agent brief) that the AI doing the work will need.',
  '',
  'Watch out — You only propose; nothing happens until I approve it in the Suveren Gateway. Ask, don\'t guess: never invent a rule, a limit or a step. One proposal at a time. Steps customers would see start with my review. Never use real names or customer data in a test run — test data only. Never give the working AI a reporting mandate during a test run. Keep the setup and the working AI in separate conversations.',
  '',
  // DL1 — outside simulation, the same mandate also covers ongoing, real-system
  // use: the Scope above (which profiles, which mode) is what actually bounds
  // the AI from here, not simulation mode. Plain words, per the brief.
  'Outside simulation — once you have connected real systems: the AI proposes mandates and its own working instructions (agent brief) for the profiles you allow above; you approve each one before it takes effect. Delegation itself can never be proposed.',
].join('\n');

function briefRefusal(args: Record<string, unknown>): string | undefined {
  if (typeof args.content !== 'string' || args.content.trim() === '') return '`content` must be the complete new brief (markdown text).';
  const bytes = Buffer.byteLength(args.content, 'utf-8');
  if (bytes > CONTEXT_MAX_BYTES) return `the brief is ${bytes} bytes; the limit is ${CONTEXT_MAX_BYTES}. Shorten it.`;
  return undefined;
}

/** The connectors as the guides see them — built-ins (this group included) are not systems. */
export function connectedSystems(im: IntegrationManager): SystemLine[] {
  const byId = new Map<string, SystemLine>();
  for (const t of im.getAllTools()) {
    if (im.isBuiltin(t.integrationId) || !t.gating?.profile || t.gating.category === 'disabled') continue;
    const s = byId.get(t.integrationId) ?? { id: t.integrationId, profile: t.gating.profile, actionTypes: [], writeTools: [], readTools: [] };
    if (t.gating.category === 'read') {
      s.readTools.push(t.originalName);
    } else {
      s.writeTools.push(t.originalName);
      const at = t.gating.staticExecution?.action_type;
      if (typeof at === 'string' && !s.actionTypes.includes(at)) s.actionTypes.push(at);
    }
    byId.set(t.integrationId, s);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Short profile name from a full id or a short name alike — always lowercase. */
function shortName(idOrName: string): string {
  const stripped = idOrName.replace(/@.*$/, '').split('/').pop() ?? idOrName;
  return stripped.toLowerCase();
}

/** The version suffix of a full profile id (e.g. "0.3" from ".../delegation@0.3"), or "". */
function versionOf(id: string): string {
  return id.split('@')[1] ?? '';
}

/**
 * Decision 4 (DL1 brief): Delegation can never be proposed — a fixed rule in
 * the tool, independent of any held mandate's scope (a scope that somehow DID
 * list it would still not be honoured). Checked before the control-plane dry
 * run (validate) and again before executing (handler) — the same "approval
 * can come long after" discipline the brief's other checks use.
 */
function delegationItselfRefusal(args: Record<string, unknown>): string | undefined {
  const requested = typeof args.profile === 'string' ? args.profile : '';
  if (shortName(requested) === DELEGATION_PROFILE) {
    return 'Delegation can never be proposed — the AI cannot widen its own delegation.';
  }
  return undefined;
}

/**
 * Decision 5 (DL1 brief): outside simulation, only a Delegation mandate whose
 * PROFILE declares the allowed_profiles/allowed_modes scope (0.4+) governs
 * create_mandate / set_agent_brief / get_guide. An older, unscoped mandate's
 * profile has no `scopeSchema` at all, so hap-core's generic scope check has
 * nothing to compare against and passes trivially — exactly the "unscoped
 * mandate would allow anything" danger the brief names. In simulation mode
 * every version keeps working exactly as before this existed (today's
 * behaviour) — real systems are blocked by the simulation gate regardless of
 * this check.
 */
function delegationMandateRefusal(auth: MandateCandidate): string | undefined {
  if (isSimulationMode()) return undefined;
  const profile = getProfile(auth.profileId);
  if (profile?.scopeSchema?.fields?.allowed_profiles) return undefined;
  return (
    `your Delegation mandate (${shortName(auth.profileId)} ${versionOf(auth.profileId)}) does not declare which ` +
    'profiles or modes you may propose — only a Delegation mandate on delegation 0.4 or later works outside ' +
    'simulation mode. Ask the person to give a current Delegation mandate.'
  );
}

// ─── Formatting for describe_mandate_proposal (AU3 preview) ────────────────

/** How a bound/scope field's unit reads next to its value, mirroring apps/ui's
 *  bound-format.ts (a separate package — duplicated, not imported, on purpose). */
function formatUnit(unit: string | undefined): string {
  if (!unit || unit === 'count') return '';
  if (unit === 'minutes') return 'min';
  if (unit === 'hours') return 'hr';
  if (unit === 'days') return 'days';
  if (unit === 'percent') return '%';
  if (unit.startsWith('currency:')) return unit.slice('currency:'.length);
  return unit;
}

function formatBoundValue(value: unknown, unit: string | undefined): string {
  if (typeof value !== 'number' && typeof value !== 'string') return String(value);
  const u = formatUnit(unit);
  if (!u) return String(value);
  if (unit === 'percent') return `${value}${u}`;
  if (unit?.startsWith('currency:')) return `${u} ${value}`;
  return `${value} ${u}`;
}

/** `args.limits`/`args.scope` by FIELD NAME → the profile's displayName (fallback: the
 *  field name) with the value formatted by the field's unit (bounds only; scope fields
 *  carry no unit and so render as the plain value). */
function labeledRecord(
  values: unknown,
  fields: Record<string, { displayName?: string; unit?: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const def = fields?.[key];
    out[def?.displayName ?? key] = formatBoundValue(value, def?.unit);
  }
  return out;
}

/** "30 days" / "12 hours" — from `args.duration_hours`, else the target profile's default TTL. */
function formatValidity(args: Record<string, unknown>, profile: AgentProfile): string {
  const hours = typeof args.duration_hours === 'number' && args.duration_hours > 0 ? args.duration_hours : undefined;
  const totalSeconds = hours !== undefined ? Math.round(hours * 3600) : (profile.ttl?.default ?? 0);
  if (totalSeconds <= 0) return 'unknown';
  if (totalSeconds % 86400 === 0) {
    const days = totalSeconds / 86400;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (totalSeconds % 3600 === 0) {
    const hrs = totalSeconds / 3600;
    return `${hrs} hour${hrs === 1 ? '' : 's'}`;
  }
  return `${Math.round(totalSeconds / 3600)} hours`;
}

/**
 * Local-data-only sentences for the approval card (contract: "checks ...
 * local data only, each a plain sentence"). Re-derives, from the held
 * Delegation mandate(s)' own granted scope and today's proposal count, the
 * same things the Gatekeeper already checked before this proposal could
 * exist — shown so the approver does not have to trust that blindly.
 */
function delegationChecks(
  deps: BuiltinDeps,
  args: Record<string, unknown>,
  targetShortName: string,
  targetDisplayName: string,
): string[] {
  const governing = deps.state.getEnrichedAuthorizations()
    .filter(a => a.complete && shortName(a.profileId) === DELEGATION_PROFILE);

  const listed = (ctx: Record<string, string | number> | undefined, field: string): string[] =>
    typeof ctx?.[field] === 'string'
      ? (ctx[field] as string).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];

  const profileOk = governing.some(g => listed(g.context, 'allowed_profiles').includes(targetShortName.toLowerCase()));
  const mode = typeof args.mode === 'string' ? args.mode : '';
  const modeOk = mode !== '' && governing.some(g => listed(g.context, 'allowed_modes').includes(mode.toLowerCase()));

  const checks: string[] = [
    profileOk
      ? `${targetDisplayName} is allowed by your Delegation mandate`
      : `${targetDisplayName} is not confirmed as allowed by an active Delegation mandate`,
  ];
  checks.push(
    mode === ''
      ? 'No mode was given'
      : modeOk
        ? `${mode} — within the modes your Delegation mandate allows`
        : `${mode} is not among the modes your Delegation mandate allows`,
  );

  const first = governing[0];
  if (first) {
    const delegationProfile = getProfile(first.profileId);
    const entry = getConsumptionState(first, deps.state.executionLog, delegationProfile)
      .find(e => e.field === 'mandate_daily_max');
    if (entry && entry.limit !== null) {
      checks.push(`Proposals today: ${entry.current} of ${entry.limit}`);
    }
  }
  return checks;
}

/** `getProfile(args.profile)` + its short name, or undefined for an unknown profile. */
function resolveTargetProfile(input: unknown): { profile: AgentProfile; shortName: string } | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const profile = getProfile(input.trim());
  if (!profile) return undefined;
  return { profile, shortName: shortName(profile.id) };
}

// ─── Shared input schemas (describe_* previews take the SAME args as the action) ──

const CREATE_MANDATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    // Short name only (e.g. "sales") — a full profile id is refused here, at input
    // validation, before the tool ever runs (DL1 Interface contract).
    profile: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', description: 'Profile short name, e.g. "sales" (newest version).' },
    limits: { type: 'object', description: 'The limits (bounds) by field name, as the profile defines them.' },
    scope: { type: 'object', description: 'The scope (context) by field name, as the profile defines it.' },
    intent: { type: 'string', description: 'Why, goal and watch-outs — signed with the mandate (at most 2000 characters).' },
    mode: { type: 'string', enum: ['review', 'automatic'], description: 'review = each action needs approval; automatic = within the limits.' },
    duration_hours: { type: 'number', description: 'How long the mandate is valid, in hours. Omit for the profile default.' },
    title: { type: 'string', description: 'A short name for the mandate.' },
    ticket_id: {
      type: 'string',
      description: 'Authorization reference for this call, set by the governing gateway — agents do not set this.',
    },
  },
  required: ['profile', 'limits', 'intent', 'mode'],
};

const SET_AGENT_BRIEF_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'The complete new agent brief, in markdown (at most 16 KB).' },
    ticket_id: {
      type: 'string',
      description: 'Authorization reference for this call, set by the governing gateway — agents do not set this.',
    },
  },
  required: ['content'],
};

const DESCRIBE_MANDATE_PROPOSAL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    proposal: { type: 'string', title: 'Proposal' },
    profile_version: { type: 'string', title: 'Version' },
    workspace: { type: 'string', title: 'Workspace' },
    mode: { type: 'string', title: 'Mode' },
    valid: { type: 'string', title: 'Valid' },
    limits: { type: 'object', title: 'Limits' },
    scope: { type: 'object', title: 'Scope' },
    title: { type: ['string', 'null'], title: 'Title' },
    intent: { type: 'string', title: 'Intent', description: 'Written by the AI — becomes your words when you sign' },
    checks: { type: 'array', title: 'Checks', items: { type: 'string' } },
  },
  required: ['proposal', 'profile_version', 'workspace', 'mode', 'valid', 'limits', 'scope', 'title', 'intent', 'checks'],
};

const DESCRIBE_BRIEF_PROPOSAL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    change: { type: 'string', title: 'Change', contentMediaType: 'text/x-diff' },
    words: { type: 'number', title: 'Words' },
  },
  required: ['change', 'words'],
};

export function setupBuiltin(deps: BuiltinDeps): BuiltinIntegration {
  return {
    id: 'setup',
    // Shown as the picker card title (apps/ui AuthorizePicker) — the person
    // reads this as the mandate they're giving, so it must match the profile
    // name they'll see everywhere else (Mandates page, dashboard first-run
    // card), not the internal "test setup" framing. Description is unchanged.
    name: 'Delegation',
    description:
      'Your AI proposes mandates and its agent brief — in a test (simulation mode) and, within the profiles ' +
      'and modes you allow, on your real systems too. Every proposal waits for your approval.',
    intentHint: DELEGATION_INTENT_HINT,
    profile: DELEGATION_PROFILE,
    simulation: true,
    // DL1: no longer simulationOnly at the GROUP level — create_mandate and
    // set_agent_brief now work outside simulation too (decision 1); only
    // get_guide keeps the per-tool flag below (decision 2).
    mandateRefusal: delegationMandateRefusal,
    toolGating: {
      overrides: {
        set_agent_brief: {
          executionMapping: {},
          staticExecution: { action_type: 'brief' },
          actionLabel: 'Agent brief set',
          hideUnlessAuthorized: true,
          approvalView: { content: { label: 'New agent brief', kind: 'markdown' } },
          // AU3 — the approval card's preview of this pending proposal (DL1
          // Interface contract). Identity arg mapping: same field name either side.
          preview: { tool: 'describe_brief_proposal', args: { content: 'content' } },
        },
        get_guide: {
          category: 'read',
          boundField: 'read_access',
          requiredValue: 'unlimited',
        },
        create_mandate: {
          executionMapping: { profile: 'allowed_profiles', mode: 'allowed_modes' },
          staticExecution: { action_type: 'mandate' },
          actionLabel: 'Mandate proposed',
          hideUnlessAuthorized: true,
          // Shown like the mandate screen: limits and scope by the profile's own names.
          approvalView: {
            profile: { label: 'Profile', kind: 'profile' },
            limits: { label: 'Limits', kind: 'profile-limits', profileArg: 'profile' },
            scope: { label: 'Scope', kind: 'profile-scope', profileArg: 'profile' },
            intent: { label: 'Intent', kind: 'markdown' },
            mode: { label: 'Mode' },
            duration_hours: { label: 'Valid for (hours)' },
            title: { label: 'Title' },
          },
          preview: { tool: 'describe_mandate_proposal', args: { profile: 'profile', limits: 'limits', scope: 'scope', intent: 'intent', mode: 'mode', duration_hours: 'duration_hours', title: 'title' } },
        },
        // Internal preview tools (DL1): never listed, never callable by an
        // agent (BuiltinTool.internal — enforced in index.ts and
        // tool-proxy.ts); explicitly disabled here too, so a direct call
        // through the normal gate (defence in depth) refuses cleanly instead
        // of falling through to the "not described in manifest" default.
        describe_mandate_proposal: { category: 'disabled' },
        describe_brief_proposal: { category: 'disabled' },
      },
    } as unknown as BuiltinIntegration['toolGating'],
    tools: [
      {
        name: 'get_guide',
        // DL1 decision 2: stays simulation-only, per-tool (the group no longer is).
        simulationOnly: true,
        description:
          'Start here when the person asks how to begin with Suveren or how to set up their work with it. ' +
          'Simulation mode only: the setup guides — how to interview the person, build the test data, propose ' +
          'mandates and the agent brief, set up the working AI\'s process, and what can make a test misleading. ' +
          'Call without `topic` for the list and the order to follow; then read each topic before doing that step.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'The guide to read, e.g. "interview". Omit for the list of topics.' },
          },
          required: [],
        },
        handler: async (args) => {
          if (!isSimulationMode()) return { ...builtinText('Refused: not available outside simulation mode.'), isError: true };
          const guides = loadGuides();
          const systems = connectedSystems(deps.integrationManager);
          const running = new Set(systems.map(s => s.id));
          // Simulated systems this gateway knows but has not started — the person
          // activates them in the gateway; the AI cannot. `isSimulationSafe`
          // (not mere capability) so a connector currently SET to a real mode
          // (e.g. ERP's mode=live) is never listed as something to "activate
          // for the test" — it would just be refused.
          const inactive = getAllManifests()
            .filter(m => deps.integrationManager.isSimulationSafe(m.id) && !running.has(m.id))
            .map(m => m.name);
          const header = guideHeader(systems, inactive);
          const topic = typeof args.topic === 'string' ? args.topic.trim().toLowerCase() : '';
          if (!topic) {
            const list = guides.map((g, i) => `${i + 1}. **${g.topic}** — ${g.summary}`).join('\n');
            return builtinText(`${header}\n\n**Setup guides, in order:**\n\n${list || '- none installed'}\n\nRead each topic with get_guide(topic) before doing that step.`);
          }
          const guide = guides.find(g => g.topic === topic);
          if (!guide) {
            return { ...builtinText(`Unknown topic "${topic}". Topics: ${guides.map(g => g.topic).join(', ') || 'none installed'}.`), isError: true };
          }
          const body = fillGenerated(guide.body.trim(), {
            limits: () => limitsSection(systems.map(s => ({ id: s.id, profile: getProfile(s.profile) as ProfileLike | undefined }))),
            package: () => packageSection(
              deps.integrationManager.getAllTools().find(t => !deps.integrationManager.isBuiltin(t.integrationId) && t.originalName === 'load_simulation'),
            ),
          });
          return builtinText(`${header}\n\n${body}`);
        },
      },
      {
        name: 'set_agent_brief',
        description:
          'Propose a new agent brief — the standing instructions every agent session starts with. `content` ' +
          'replaces the whole brief (markdown, at most 16 KB). A person approves or rejects the proposal; only ' +
          'after approval is the brief replaced, and it applies from the next session. Write the complete brief, ' +
          'not a change to the current one.',
        inputSchema: SET_AGENT_BRIEF_INPUT_SCHEMA,
        validate: briefRefusal,
        handler: async (args) => {
          // Approval can come long after the proposal: check again before writing.
          const refusal = briefRefusal(args);
          if (refusal) return { ...builtinText(`Refused: ${refusal}`), isError: true };
          writeContextFile(args.content as string);
          return builtinText(
            `Agent brief replaced (${Buffer.byteLength(args.content as string, 'utf-8')} bytes). It applies from the next agent session.`,
          );
        },
      },
      {
        name: 'create_mandate',
        description:
          'Propose a new mandate for the person running this gateway — the authority another tool needs (e.g. ' +
          'sales quotes up to a value). Always goes to the person\'s current workspace (their team, or Personal ' +
          'if they are not in one) — there is no way to name a different one. A person approves or rejects the ' +
          'proposal; only after approval is the mandate created, exactly as if they had signed it on the mandate ' +
          'screen. Checked against the profile before the proposal: unknown limits, a mode the profile does not ' +
          'allow, or a team where the person may not give this mandate are refused at once. Outside simulation ' +
          'mode, the profile and mode you may propose are themselves limited by your Delegation mandate\'s scope ' +
          '— Delegation itself can never be proposed. Create only.',
        inputSchema: CREATE_MANDATE_INPUT_SCHEMA,
        validate: async (args) => {
          const fixed = delegationItselfRefusal(args);
          // Decision 7: never silent — recorded under Blocked even though
          // this refuses before any proposal exists (`precheckBuiltin`'s
          // short-circuit has no `state` of its own to record through).
          if (fixed) {
            deps.state.denialLog?.record({
              ts: Date.now(), tool: 'create_mandate', integrationId: 'setup', profile: DELEGATION_PROFILE,
              kind: 'bound', detail: fixed, who: 'gateway', code: 'DELEGATION_NOT_PROPOSABLE',
            });
            return fixed;
          }
          const check = await controlPlaneMandate(true, mandateRequest(args));
          return check.ok ? undefined : check.message;
        },
        handler: async (args) => {
          // Approval can come long after the proposal: check the fixed rule again before creating.
          const fixed = delegationItselfRefusal(args);
          if (fixed) return { ...builtinText(`Refused: ${fixed}`), isError: true };
          const r = await controlPlaneMandate(false, mandateRequest(args));
          if (!r.ok) return { ...builtinText(`Refused: ${r.message}`), isError: true };
          return builtinText(
            `Mandate created: ${r.authorizationId} — profile ${r.profileId}, ${r.groupName}, mode ${r.mode}, ` +
            `valid for ${Math.round((r.ttlSeconds ?? 0) / 3600)} h. It is active now.`,
          );
        },
      },
      {
        // AU3 internal preview (DL1 Interface contract) — never listed, never
        // callable by an agent. Builds the "What you would sign" card for a
        // pending create_mandate proposal from the SAME args, local data only.
        name: 'describe_mandate_proposal',
        internal: true,
        description: 'Internal — the approval card\'s preview of a pending create_mandate proposal. Not for agent use.',
        inputSchema: CREATE_MANDATE_INPUT_SCHEMA,
        outputSchema: DESCRIBE_MANDATE_PROPOSAL_OUTPUT_SCHEMA,
        handler: async (args) => {
          const resolved = resolveTargetProfile(args.profile);
          if (!resolved) {
            return { ...builtinText(`Refused: unknown profile "${String(args.profile)}".`), isError: true };
          }
          const { profile, shortName: targetShortName } = resolved;
          const displayName = profile.name ?? targetShortName;
          // WS3 (work-plan "Added 2026-10-11 — an account is Personal OR
          // in one team"): `create_mandate` no longer takes `team` — the
          // mandate always goes to the person's active workspace. Read the
          // REAL one from the same dry-run check `create_mandate`'s own
          // `validate` already runs, rather than echoing back anything the
          // AI said (there is nothing left to echo — the field is gone).
          const check = await controlPlaneMandate(true, mandateRequest(args));
          const workspace = check.ok && check.groupName ? check.groupName : 'Personal';
          const mode = typeof args.mode === 'string' ? args.mode : '';
          const structured = {
            proposal: `New mandate · ${displayName}`,
            profile_version: `${targetShortName} ${profile.version}`,
            workspace,
            mode,
            valid: formatValidity(args, profile),
            limits: labeledRecord(args.limits, profile.boundsSchema?.fields),
            scope: labeledRecord(args.scope, profile.scopeSchema?.fields),
            title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null,
            intent: typeof args.intent === 'string' ? args.intent : '',
            checks: delegationChecks(deps, args, targetShortName, displayName),
          };
          return builtinStructured(structured);
        },
      },
      {
        // AU3 internal preview (DL1 Interface contract) — never listed, never
        // callable by an agent. Builds the "New agent brief" diff card.
        name: 'describe_brief_proposal',
        internal: true,
        description: 'Internal — the approval card\'s preview of a pending set_agent_brief proposal. Not for agent use.',
        inputSchema: SET_AGENT_BRIEF_INPUT_SCHEMA,
        outputSchema: DESCRIBE_BRIEF_PROPOSAL_OUTPUT_SCHEMA,
        handler: async (args) => {
          const proposed = typeof args.content === 'string' ? args.content : '';
          const current = readContextFile() ?? '';
          const change = unifiedLineDiff(current, proposed);
          const trimmed = proposed.trim();
          const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
          return builtinStructured({ change, words });
        },
      },
    ],
  };
}

/**
 * The tool's arguments as the control plane's MandateRequest. No `team` —
 * WS3 dropped that argument; mandate-ceremony.ts's own `team`-omitted
 * fallback (the workspace of the person's Delegation mandate) now always
 * resolves to the active workspace, since an account can only ever be
 * active in one place at a time (decision 1, WS1/WS2 on the Authority
 * Server side).
 */
function mandateRequest(args: Record<string, unknown>): Record<string, unknown> {
  return {
    profile: args.profile,
    limits: args.limits,
    scope: args.scope,
    intent: args.intent,
    mode: args.mode,
    durationHours: args.duration_hours,
    title: args.title,
  };
}
