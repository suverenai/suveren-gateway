/**
 * Suveren MCP Server — Tool provider for the agent with embedded Gatekeeper.
 *
 * Registers:
 * - Suveren admin tools: list-authorizations, check-pending-mandates
 * - Proxied tools: discovered from downstream MCP servers via IntegrationManager
 *
 * Builds a mandate brief from enriched authorizations and sets it as MCP instructions.
 * Tool descriptions are updated dynamically to reflect current authorization bounds.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SharedState } from './lib/shared-state';
import { attachmentLine, attachmentSources, type GuideManifest } from './lib/guidance';
import { toolNameOf } from './lib/guidance-runtime';
import { getAllManifests } from './lib/manifest-loader';
import { isSimulationMode } from './lib/simulation-mode';
import { buildMandateBrief } from './lib/mandate-brief';
import { listAuthorizationsHandler } from './tools/authorizations';
import { checkPendingHandler } from './tools/pending';
import { listIntegrationsHandler } from './tools/integrations';
import { checkPendingCommitmentsHandler } from './tools/commitments';
import type { IntegrationManager, DiscoveredTool } from './lib/integration-manager';
import { recordBlocked, createGatedToolHandler, buildProxiedToolDescription, profileMatches, toolIsAuthorizedForDisplay, toolAlwaysListed } from './lib/tool-proxy';
import { jsonSchemaToZodShape } from './lib/json-schema-to-zod';
import { wrapWithOutcomeOutbox } from './lib/outcome-outbox';
import { SessionChangeNotice, currentTold } from './lib/change-notice';
import { getContextForBrief } from './lib/context-loader';

// ─── JSON Schema → Zod conversion ──────────────────────────────────────────


// ─── Server factory ─────────────────────────────────────────────────────────

export function createMcpServer(
  state: SharedState,
  integrationManager?: IntegrationManager,
) {
  const { cache } = state;

  // Taken right where the instructions are built: this is what the AI will have been told.
  const changeNotice = new SessionChangeNotice({
    now: () => currentTold(state.getEnrichedAuthorizations(), integrationManager),
    currentBrief: () => getContextForBrief().brief,
    ledger: state.changeLedger,
    appName: () => server.server.getClientVersion()?.name,
  });

  // Build mandate brief from current enriched authorizations
  const enriched = state.getEnrichedAuthorizations();
  const instructions = buildMandateBrief({
    authorizations: enriched,
    executionLog: state.executionLog,
    integrationManager,
    asVersionRefusal: state.asVersionRefusal,
  });

  const server = new McpServer(
    { name: 'suveren-gateway', version: '0.1.0' },
    { instructions },
  );

  // RJ4 — the ONE wrapper every registered tool's handler goes through, so a
  // pending rejection/change-needed/replaced outcome reaches the AI on its
  // next call to ANY of them (proxied, builtin, or a gateway tool below) —
  // see outcome-outbox.ts. Never an internal tool: those are filtered out
  // before `server.registerTool` is ever called for them (see
  // `registerProxiedTools` below).
  const withOutcomeOutbox = <T>(handler: T): T =>
    wrapWithOutcomeOutbox(state.outcomeOutbox, handler as Parameters<typeof wrapWithOutcomeOutbox>[1]) as T;

  // Every tool answer also tells a running chat what changed since it was told (change-notice.ts).
  const withNotes = <T>(handler: T): T =>
    changeNotice.wrap(withOutcomeOutbox(handler) as (...args: unknown[]) => unknown) as T;

  // ─── list-authorizations ─────────────────────────────────────────────────

  server.registerTool(
    'list-authorizations',
    {
      description: 'Where things stand. With no argument: a short answer with what is possible here, the one next step and what you can do yourself. With a domain (the area of the task, e.g. "charge"): the exact steps the person takes for that area, and the full details of its mandates, including consumption, bounds and capability map.',
      inputSchema: {
        domain: z.string().optional().describe('The area of the task (e.g., "charge", "deploy"), by its short name or the name the person sees. Omit for the short answer.'),
      },
    },
    withNotes(listAuthorizationsHandler(state, integrationManager))
  );

  // ─── check-pending-mandates (v0.7; was check-pending-attestations) ───────

  server.registerTool(
    'check-pending-mandates',
    {
      description: 'Check if any mandates are waiting for your owner\'s approval.',
      inputSchema: {
        domain: z.string().describe('The owner\'s domain (e.g., "compliance")'),
      },
    },
    withNotes(checkPendingHandler(cache))
  );

  // ─── list-integrations ─────────────────────────────────────────────────

  server.registerTool(
    'list-integrations',
    {
      description: 'List all running integrations and their authorization status. Returns a compact overview — use list-authorizations(domain) for full details on a specific profile.',
      inputSchema: {},
    },
    withNotes(listIntegrationsHandler(state, integrationManager))
  );

  // ─── check-pending-commitments ─────────────────────────────────────────

  server.registerTool(
    'check-pending-commitments',
    {
      description: 'Check status of pending proposals awaiting domain owner commitment. Call with a proposal_id to check a specific proposal, or without to see all. ' +
        'With a proposal_id you may also pass wait_seconds (max 50): the gateway then waits until the person decides and answers at once — ' +
        'first tell the person what you proposed and that it waits for their approval in the gateway.',
      inputSchema: {
        proposal_id: z.string().optional().describe('Specific proposal ID to check. Omit to see all.'),
        wait_seconds: z.number().int().min(0).max(50).optional()
          .describe('Only with proposal_id: wait up to this many seconds (max 50) while the proposal is still pending; answers as soon as the person decides. Omit or 0 to answer at once.'),
      },
    },
    withNotes(checkPendingCommitmentsHandler(state, integrationManager))
  );

  // ─── Proxied tools from downstream integrations ──────────────────────────

  const proxiedTools = new Map<string, { tool: DiscoveredTool; registered: ReturnType<typeof server.registerTool>; description: string }>();

  /** The description an agent sees: the fixed prefix plus, for a tool that takes attachments, what the manifests let it attach. */
  function describeProxied(tool: DiscoveredTool): string {
    let extra: string | undefined;
    if (tool.gating?.attachmentsArg) {
      const running = (getAllManifests() as unknown as GuideManifest[]).filter(m => integrationManager?.isRunning?.(m.id));
      extra = attachmentLine(attachmentSources(running, toolNameOf));
    }
    return buildProxiedToolDescription(tool, extra);
  }

  function registerProxiedTools() {
    if (!integrationManager) {
      console.error('[MCP] registerProxiedTools: no integrationManager');
      return;
    }

    const allTools = integrationManager.getAllTools();

    // Remove tools that no longer exist
    for (const [name] of proxiedTools) {
      if (!allTools.some(t => t.namespacedName === name)) {
        const entry = proxiedTools.get(name);
        entry?.registered.remove();
        proxiedTools.delete(name);
      }
    }

    // Register new tools
    for (const tool of allTools) {
      // DL1 — a built-in's own internal preview tools (describe_mandate_proposal /
      // describe_brief_proposal) are never listed and never callable by an agent:
      // reachable only via IntegrationManager.callTool, called directly by
      // gateway-internal code (AU3's /internal/preview). Never register them with
      // the MCP server at all, so `tools/list` never names them and `tools/call`
      // answers "not found" exactly as it would for a name that never existed.
      if (tool.internal) continue;
      // Same name but a different DiscoveredTool object means the integration
      // restarted — possibly with different gating. The registered handler
      // closed over the OLD tool (and its gating), so it must be replaced;
      // keeping it would enforce a gating config the backend no longer has.
      const existing = proxiedTools.get(tool.namespacedName);
      if (existing) {
        if (existing.tool === tool) {
          // Same tool, but a connector that offers documents may have started since: keep the line current.
          const fresh = describeProxied(tool);
          if (fresh !== existing.description) {
            existing.registered.update({ description: fresh });
            existing.description = fresh;
          }
          continue;
        }
        existing.registered.remove();
        proxiedTools.delete(tool.namespacedName);
      }

      const gatedHandler = createGatedToolHandler(tool, integrationManager, state);
      // The MCP layer passes every argument through (passthrough, below) instead of stripping
      // what the advertised schema leaves out — a stripped argument let the call run without it
      // and the AI was never told (2026-11-07, Rehearsal A16 on the real Gmail test account).
      // A BLOCKED argument goes on to the gate, which refuses it with its own reason; any other
      // argument this tool does not offer is refused here, by name. Nothing reaches a connector
      // that the tool did not advertise.
      const offered = new Set(Object.keys(((tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}));
      const blockedArgs = new Set(tool.gating?.blockedArgs ?? []);
      const handler = (async (args: Record<string, unknown>, extra: unknown) => {
        const unknown = Object.keys(args ?? {}).filter(k => !offered.has(k) && !blockedArgs.has(k));
        if (unknown.length > 0) {
          recordBlocked(state, tool, {
            kind: 'unsealed_arg',
            detail: `Argument ${unknown.map(u => `"${u}"`).join(', ')} is not offered by this tool.`,
            field: unknown[0],
            who: 'gateway',
            code: 'UNKNOWN_ARG',
          });
          return {
            content: [{
              type: 'text' as const,
              text: `Refused: "${tool.namespacedName}" does not offer ${unknown.map(u => `"${u}"`).join(', ')}. ` +
                'Nothing was done and no ticket was requested. Call it again with only the arguments the tool lists.',
            }],
            isError: true,
          };
        }
        return (gatedHandler as (a: Record<string, unknown>, e: unknown) => unknown)(args, extra);
      }) as typeof gatedHandler;
      // passthrough: an argument the AI sends that the advertised schema leaves out (a blocked
      // one such as gmail threadId/bcc, or an unknown one) must reach the gate and be REFUSED
      // openly. A plain shape let the SDK strip it silently, so the call ran without it and the
      // AI was never told (2026-11-07, Rehearsal A16 on the real Gmail test account).
      const zodShape = z.object(jsonSchemaToZodShape(tool.inputSchema)).passthrough();
      const description = describeProxied(tool);

      try {
        const registered = server.registerTool(
          tool.namespacedName,
          {
            description,
            // Always a schema, even an empty one: without it the SDK calls the
            // handler as (extra) instead of (args, extra), and the request's own
            // data (session id, headers, _meta) was forwarded to the connector as
            // the tool's arguments (Mollie GetOrganizationDetails, 2026-10-16).
            inputSchema: zodShape,
          },
          // Built-in tools (reports, setup) never carry the outcome line: a
          // report's output is evidence and must not mix in a notice (nor the
          // decider's identity); setup tools are not the working agent's.
          // A built-in that declares evidenceOnly carries no change note either.
          (integrationManager?.builtinEvidenceOnly?.(tool.integrationId)
            ? handler
            : integrationManager?.isBuiltin?.(tool.integrationId)
              ? changeNotice.wrap(handler as (...args: unknown[]) => unknown)
              : withNotes(handler)) as Parameters<typeof server.registerTool>[2],
        );
        proxiedTools.set(tool.namespacedName, { tool, registered, description });
      } catch (err) {
        console.error(`[MCP] Failed to register tool ${tool.namespacedName}:`, err);
      }
    }
  }

  // ─── Tool visibility ────────────────────────────────────────────────────

  function refreshTools() {
    const auths = state.getEnrichedAuthorizations();
    const isBuiltin = (id: string) => integrationManager?.isBuiltin?.(id) ?? false;
    const builtinAlwaysListed = (id: string) => integrationManager?.builtinAlwaysListed?.(id) ?? false;

    // Descriptions are fixed per tool (see buildProxiedToolDescription); only
    // visibility is recomputed here.
    for (const [, { tool, registered }] of proxiedTools) {
      // A tool that exists only in simulation mode (get_guide) is not offered outside it: its answer would be "not available".
      if (tool.simulationOnly && !isSimulationMode()) { registered.disable(); continue; }
      // Connector tools are listed whether or not a mandate exists — the gate
      // refuses an uncovered call (see toolAlwaysListed).
      if (toolAlwaysListed(tool, isBuiltin, builtinAlwaysListed)) {
        registered.enable();
      } else if (tool.gating?.profile) {
        const matchingAuths = auths.filter(
          a => a.complete && profileMatches(a.profileId, tool.gating!.profile!),
        );
        // hideUnlessAuthorized tools need more than "a mandate exists" — see
        // toolIsAuthorizedForDisplay. For every other tool this is exactly
        // the previous "hasAuth" check (matchingAuths.length > 0).
        const hasAuth = matchingAuths.length > 0 && toolIsAuthorizedForDisplay(tool, matchingAuths);
        if (hasAuth) registered.enable(); else registered.disable();
      } else {
        // No gating config = no profile = always disabled
        registered.disable();
      }
    }

    server.sendToolListChanged();
  }

  // Register any existing proxied tools and set initial visibility
  registerProxiedTools();
  refreshTools();

  return { server, gatekeeper: state.gatekeeper, refreshTools, registerProxiedTools };
}
