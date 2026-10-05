/**
 * `setup` — the gateway tools an AI uses to set up a test of itself, governed by the
 * review-only `delegation` profile: every call is a proposal a person approves
 * before anything changes. Simulation mode only, for now (work plan, simulation
 * setup S7/S8/S10).
 *
 * set_agent_brief — replaces the agent brief (context.md) with the proposed text
 * after approval; it applies from the next agent session.
 */
import { builtinText, type BuiltinIntegration } from '../builtin-integration';
import { CONTEXT_MAX_BYTES, writeContextFile } from '../context-loader';
import { isSimulationMode } from '../simulation-mode';
import type { BuiltinDeps } from './index';

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
      'Your AI proposes its own setup for a test — for now its agent brief. Every proposal waits for your ' +
      'approval. Simulation mode only.',
    profile: DELEGATION_PROFILE,
    simulation: true,
    simulationOnly: true,
    toolGating: {
      overrides: {
        set_agent_brief: {
          executionMapping: {},
          staticExecution: { action_type: 'brief' },
          hideUnlessAuthorized: true,
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
    ],
  };
}
