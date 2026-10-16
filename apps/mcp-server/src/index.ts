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
import { buildMandateBrief } from './lib/mandate-brief';
import { listAuthorizationsHandler } from './tools/authorizations';
import { checkPendingHandler } from './tools/pending';
import { listIntegrationsHandler } from './tools/integrations';
import { checkPendingCommitmentsHandler } from './tools/commitments';
import type { IntegrationManager, DiscoveredTool } from './lib/integration-manager';
import { createGatedToolHandler, buildProxiedToolDescription, profileMatches, toolIsAuthorizedForDisplay, toolAlwaysListed } from './lib/tool-proxy';
import { jsonSchemaToZodShape } from './lib/json-schema-to-zod';
import { wrapWithOutcomeOutbox } from './lib/outcome-outbox';

// ─── JSON Schema → Zod conversion ──────────────────────────────────────────


// ─── Server factory ─────────────────────────────────────────────────────────

export function createMcpServer(
  state: SharedState,
  integrationManager?: IntegrationManager,
) {
  const { cache } = state;

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

  // ─── list-authorizations ─────────────────────────────────────────────────

  server.registerTool(
    'list-authorizations',
    {
      description: 'List what you are currently authorized to do. Call with no arguments for a compact overview, or with a domain (e.g., "charge") for full details including consumption, bounds, and capability map.',
      inputSchema: {
        domain: z.string().optional().describe('Profile domain to show full details for (e.g., "charge", "deploy"). Omit for compact overview.'),
      },
    },
    withOutcomeOutbox(listAuthorizationsHandler(state, integrationManager))
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
    withOutcomeOutbox(checkPendingHandler(cache))
  );

  // ─── list-integrations ─────────────────────────────────────────────────

  server.registerTool(
    'list-integrations',
    {
      description: 'List all running integrations and their authorization status. Returns a compact overview — use list-authorizations(domain) for full details on a specific profile.',
      inputSchema: {},
    },
    withOutcomeOutbox(listIntegrationsHandler(state, integrationManager))
  );

  // ─── check-pending-commitments ─────────────────────────────────────────

  server.registerTool(
    'check-pending-commitments',
    {
      description: 'Check status of pending proposals awaiting domain owner commitment. Call with a proposal_id to check a specific proposal, or without to see all.',
      inputSchema: {
        proposal_id: z.string().optional().describe('Specific proposal ID to check. Omit to see all.'),
      },
    },
    withOutcomeOutbox(checkPendingCommitmentsHandler(state, integrationManager))
  );

  // ─── Proxied tools from downstream integrations ──────────────────────────

  const proxiedTools = new Map<string, { tool: DiscoveredTool; registered: ReturnType<typeof server.registerTool> }>();

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
        if (existing.tool === tool) continue;
        existing.registered.remove();
        proxiedTools.delete(tool.namespacedName);
      }

      const handler = createGatedToolHandler(tool, integrationManager, state);
      const zodShape = jsonSchemaToZodShape(tool.inputSchema);
      const description = buildProxiedToolDescription(tool);

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
          (integrationManager?.isBuiltin?.(tool.integrationId) ? handler : withOutcomeOutbox(handler)) as Parameters<typeof server.registerTool>[2],
        );
        proxiedTools.set(tool.namespacedName, { tool, registered });
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
