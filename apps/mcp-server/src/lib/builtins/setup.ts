/**
 * `setup` — the gateway tools an AI uses to set up a test of itself, governed by the
 * review-only `delegation` profile: every call is a proposal a person approves
 * before anything changes. Simulation mode only, for now (work plan, simulation
 * setup S7/S8/S10).
 *
 * set_agent_brief — replaces the agent brief (context.md) with the proposed text
 * after approval; it applies from the next agent session.
 *
 * create_mandate — creates a new mandate for the signed-in person after approval,
 * exactly as the sign page would (control plane, lib/mandate-ceremony.ts). Checked
 * in full before the proposal (a dry run with the same code), so nobody approves a
 * mandate that could not be created. Create only — editing stays with the person.
 *
 * get_guide — the setup guides (lib/guides.ts): defaults shipped with the gateway,
 * overridable per installation; every guide is prefixed with the systems actually
 * connected, so the texts never have to name them.
 */
import { builtinText, type BuiltinIntegration } from '../builtin-integration';
import { CONTEXT_MAX_BYTES, writeContextFile } from '../context-loader';
import { isSimulationMode } from '../simulation-mode';
import type { BuiltinDeps } from './index';
import { controlPlaneMandate } from '../cp-mandate';
import { loadGuides, guideHeader, type SystemLine } from '../guides';
import type { IntegrationManager } from '../integration-manager';

export const DELEGATION_PROFILE = 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1';

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

export function setupBuiltin(deps: BuiltinDeps): BuiltinIntegration {
  return {
    id: 'setup',
    // Shown as the picker card title (apps/ui AuthorizePicker) — the person
    // reads this as the mandate they're giving, so it must match the profile
    // name they'll see everywhere else (Mandates page, dashboard first-run
    // card), not the internal "test setup" framing. Description is unchanged.
    name: 'Delegation',
    description:
      'Your AI sets up a test of itself: it reads the setup guides and proposes its agent brief and its ' +
      'mandates. Every proposal waits for your approval. Simulation mode only.',
    profile: DELEGATION_PROFILE,
    simulation: true,
    simulationOnly: true,
    toolGating: {
      overrides: {
        set_agent_brief: {
          executionMapping: {},
          staticExecution: { action_type: 'brief' },
          hideUnlessAuthorized: true,
          approvalView: { content: { label: 'New agent brief', kind: 'markdown' } },
        },
        get_guide: {
          category: 'read',
          boundField: 'read_access',
          requiredValue: 'unlimited',
        },
        create_mandate: {
          executionMapping: {},
          staticExecution: { action_type: 'mandate' },
          hideUnlessAuthorized: true,
          // Shown like the mandate screen: limits and scope by the profile's own names.
          approvalView: {
            team: { label: 'Team' },
            profile: { label: 'Profile', kind: 'profile' },
            limits: { label: 'Limits', kind: 'profile-limits', profileArg: 'profile' },
            scope: { label: 'Scope', kind: 'profile-scope', profileArg: 'profile' },
            intent: { label: 'Intent', kind: 'markdown' },
            mode: { label: 'Mode' },
            duration_hours: { label: 'Valid for (hours)' },
            title: { label: 'Title' },
          },
        },
      },
    } as unknown as BuiltinIntegration['toolGating'],
    tools: [
      {
        name: 'get_guide',
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
          const header = guideHeader(connectedSystems(deps.integrationManager));
          const topic = typeof args.topic === 'string' ? args.topic.trim().toLowerCase() : '';
          if (!topic) {
            const list = guides.map((g, i) => `${i + 1}. **${g.topic}** — ${g.summary}`).join('\n');
            return builtinText(`${header}\n\n**Setup guides, in order:**\n\n${list || '- none installed'}\n\nRead each topic with get_guide(topic) before doing that step.`);
          }
          const guide = guides.find(g => g.topic === topic);
          if (!guide) {
            return { ...builtinText(`Unknown topic "${topic}". Topics: ${guides.map(g => g.topic).join(', ') || 'none installed'}.`), isError: true };
          }
          return builtinText(`${header}\n\n${guide.body.trim()}`);
        },
      },
      {
        name: 'set_agent_brief',
        description:
          'Simulation mode only: propose a new agent brief — the standing instructions every agent session starts ' +
          'with. `content` replaces the whole brief (markdown, at most 16 KB). A person approves or rejects the ' +
          'proposal; only after approval is the brief replaced, and it applies from the next session. Write the ' +
          'complete brief, not a change to the current one.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The complete new agent brief, in markdown (at most 16 KB).' },
            receipt_id: {
              type: 'string',
              description: 'Authorization reference for this call, set by the governing gateway — agents do not set this.',
            },
          },
          required: ['content'],
        },
        validate: briefRefusal,
        handler: async (args) => {
          // Approval can come long after the proposal: check again before writing.
          if (!isSimulationMode()) return { ...builtinText('Refused: not available outside simulation mode.'), isError: true };
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
          'Simulation mode only: propose a new mandate for the person running this gateway — the authority another ' +
          'tool needs (e.g. sales quotes up to a value). A person approves or rejects the proposal; only after ' +
          'approval is the mandate created, exactly as if they had signed it on the mandate screen. Checked against ' +
          'the profile before the proposal: unknown limits, a mode the profile does not allow, or a team where the ' +
          'person may not give this mandate are refused at once. Create only.',
        inputSchema: {
          type: 'object',
          properties: {
            team: { type: 'string', description: 'Team name or id, or "personal". Omit to use the workspace of your Delegation mandate.' },
            profile: { type: 'string', description: 'Profile, e.g. "sales" (newest version) or a full profile id.' },
            limits: { type: 'object', description: 'The limits (bounds) by field name, as the profile defines them.' },
            scope: { type: 'object', description: 'The scope (context) by field name, as the profile defines it.' },
            intent: { type: 'string', description: 'Why, goal and watch-outs — signed with the mandate (at most 2000 characters).' },
            mode: { type: 'string', enum: ['review', 'automatic'], description: 'review = each action needs approval; automatic = within the limits.' },
            duration_hours: { type: 'number', description: 'How long the mandate is valid, in hours. Omit for the profile default.' },
            title: { type: 'string', description: 'A short name for the mandate.' },
            receipt_id: {
              type: 'string',
              description: 'Authorization reference for this call, set by the governing gateway — agents do not set this.',
            },
          },
          required: ['profile', 'limits', 'intent', 'mode'],
        },
        validate: async (args) => {
          const check = await controlPlaneMandate(true, mandateRequest(args));
          return check.ok ? undefined : check.message;
        },
        handler: async (args) => {
          if (!isSimulationMode()) return { ...builtinText('Refused: not available outside simulation mode.'), isError: true };
          const r = await controlPlaneMandate(false, mandateRequest(args));
          if (!r.ok) return { ...builtinText(`Refused: ${r.message}`), isError: true };
          return builtinText(
            `Mandate created: ${r.authorizationId} — profile ${r.profileId}, ${r.groupName}, mode ${r.mode}, ` +
            `valid for ${Math.round((r.ttlSeconds ?? 0) / 3600)} h. It is active now.`,
          );
        },
      },
    ],
  };
}

/** The tool's arguments as the control plane's MandateRequest. */
function mandateRequest(args: Record<string, unknown>): Record<string, unknown> {
  return {
    team: typeof args.team === 'string' && args.team.trim() ? args.team.trim() : undefined,
    profile: args.profile,
    limits: args.limits,
    scope: args.scope,
    intent: args.intent,
    mode: args.mode,
    durationHours: args.duration_hours,
    title: args.title,
  };
}
