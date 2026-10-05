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
 */
import { builtinText, type BuiltinIntegration } from '../builtin-integration';
import { CONTEXT_MAX_BYTES, writeContextFile } from '../context-loader';
import { isSimulationMode } from '../simulation-mode';
import type { BuiltinDeps } from './index';
import { controlPlaneMandate } from '../cp-mandate';

export const DELEGATION_PROFILE = 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1';

function briefRefusal(args: Record<string, unknown>): string | undefined {
  if (typeof args.content !== 'string' || args.content.trim() === '') return '`content` must be the complete new brief (markdown text).';
  const bytes = Buffer.byteLength(args.content, 'utf-8');
  if (bytes > CONTEXT_MAX_BYTES) return `the brief is ${bytes} bytes; the limit is ${CONTEXT_MAX_BYTES}. Shorten it.`;
  return undefined;
}

export function setupBuiltin(_deps: BuiltinDeps): BuiltinIntegration {
  return {
    id: 'setup',
    name: 'Test setup',
    description:
      'Your AI proposes its own setup for a test — its agent brief and its mandates. Every proposal waits for ' +
      'your approval. Simulation mode only.',
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
            team: { type: 'string', description: 'Team name or id. Omit for the personal workspace.' },
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
