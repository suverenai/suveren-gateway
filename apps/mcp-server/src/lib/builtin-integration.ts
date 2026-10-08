/**
 * Built-in integrations — tools the gateway implements itself (in process), governed
 * exactly like a connector's tools.
 *
 * A built-in declares what a connector's manifest declares: the profile that governs
 * it and a `toolGating` entry per tool (action type, mappings, `category: 'read'` +
 * read gate, `hideUnlessAuthorized`). `IntegrationManager.registerBuiltin` turns it
 * into ordinary `DiscoveredTool`s named `<id>__<tool>`, so everything downstream is
 * shared, not duplicated: tool listing and hiding, mandate selection, the local
 * gatekeeper, the read gate, ticket requests and `receipt_id` injection, review-mode
 * proposals and their execution after approval (committed executor), the execution
 * journal, and simulation-mode visibility. Only the last step differs: the manager
 * calls `handler` instead of a child MCP client.
 *
 * What a built-in never goes through: npm install/pin, spawn, respawn, the
 * integration registry (`integrations.json`), or the connector status list. It
 * cannot be stopped; it exists for the life of the process.
 *
 * Simulation mode: a built-in is refused there unless it declares
 * `simulation: true`, the same rule as a manifest's `simulation` marker — a
 * built-in that could reach a real system must not run during a test.
 */
import type { ProfileToolGating } from './tool-gating-types';

/** What a tool returns — the same shape a connector's MCP tool call returns. */
export interface BuiltinToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface BuiltinTool {
  /** Tool name without the integration prefix (the agent sees `<id>__<name>`). */
  name: string;
  description: string;
  /** JSON Schema of the arguments, as a connector would publish it. */
  inputSchema: Record<string, unknown>;
  /**
   * Runs the action. Called only after the call passed the gatekeeper — for a
   * write, with a ticket (its id in `args.receipt_id` when the tool declares it);
   * for review mode, only after a person approved it, possibly in another trigger.
   * Throwing is reported to the agent as a failed call.
   */
  handler: (args: Record<string, unknown>) => Promise<BuiltinToolResult>;
  /**
   * Checks the arguments BEFORE anything is requested — no proposal, no ticket.
   * Return a refusal text, or nothing to let the call through to the gate. Use it
   * for what makes the action impossible regardless of who approves (too large,
   * malformed), so a person is never asked to approve a call that cannot run.
   * The handler must still check again: approval can come much later.
   */
  validate?: (args: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
}

/** What `mandateRefusal` sees of a held mandate — EnrichedAuthorization fits. */
export interface MandateCandidate {
  authorizationId: string;
  profileId: string;
  complete: boolean;
  bounds?: Record<string, string | number>;
  frame?: Record<string, string | number>;
}

export interface BuiltinIntegration {
  /** Prefix of the tool names. Must not contain `__` and must not clash with a connector id. */
  id: string;
  name: string;
  /** One sentence for the person giving a mandate: what the agent can do with these tools. */
  description?: string;
  /** Starter text for the mandate's intent — the same as a manifest's `intentHint`. */
  intentHint?: string;
  /** Profile id governing every tool (full id or short name, as in a manifest). */
  profile: string;
  /** Per-tool gating, the `toolGating` block of a manifest. A tool without an entry is refused. */
  toolGating: ProfileToolGating;
  /** Safe while simulation mode is on (touches no real system). Default false = refused there. */
  simulation?: boolean;
  /**
   * Available ONLY while simulation mode is on: refused outside it before any
   * proposal or ticket (e.g. the AI creating its own mandates — test setups only).
   */
  simulationOnly?: boolean;
  /**
   * A held mandate (on this built-in's profile) that the built-in refuses —
   * e.g. one from an older profile version. Return the refusal reason, or
   * nothing to accept it. The gate applies it to EVERY tool of the built-in,
   * before the gatekeeper check and mandate selection (tool-proxy.ts): a
   * refused mandate is never selectable, so it can neither authorize nor be
   * charged for a call. Declare here the SAME predicate the built-in's own
   * refusal uses, so reads and writes follow one rule.
   */
  mandateRefusal?: (auth: MandateCandidate) => string | undefined;
  tools: BuiltinTool[];
}

/** What the UI's mandate picker needs to offer a built-in group (via /health). */
export interface BuiltinStatus {
  id: string;
  name: string;
  description: string;
  /** Profile id governing the tools. */
  profile: string;
  /** See BuiltinIntegration.intentHint. */
  intentHint?: string;
  /** Usable right now — false for a simulationOnly group outside simulation mode. */
  available: boolean;
}

/** Shorthand for a successful text result. */
export function builtinText(text: string): BuiltinToolResult {
  return { content: [{ type: 'text', text }] };
}
