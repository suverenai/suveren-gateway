/**
 * Suveren MCP Server — Tool provider for the agent with embedded Gatekeeper.
 *
 * Registers:
 * - Suveren admin tools: list-authorizations, check-pending-attestations
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
import { createGatedToolHandler, buildProxiedToolDescription, profileMatches, toolIsAuthorizedForDisplay } from './lib/tool-proxy';
import { jsonSchemaToZodShape } from './lib/json-schema-to-zod';

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

  // ─── list-authorizations ─────────────────────────────────────────────────

  server.registerTool(
    'list-authorizations',
    {
      description: 'List what you are currently authorized to do. Call with no arguments for a compact overview, or with a domain (e.g., "charge") for full details including consumption, bounds, and capability map.',
      inputSchema: {
        domain: z.string().optional().describe('Profile domain to show full details for (e.g., "charge", "deploy"). Omit for compact overview.'),
      },
    },
    listAuthorizationsHandler(state, integrationManager)
  );

  // ─── check-pending-attestations ──────────────────────────────────────────

  server.registerTool(
    'check-pending-attestations',
    {
      description: 'Check if any attestations are waiting for your owner\'s approval.',
      inputSchema: {
        domain: z.string().describe('The owner\'s domain (e.g., "compliance")'),
      },
    },
    checkPendingHandler(cache)
  );

  // ─── list-integrations ─────────────────────────────────────────────────

  server.registerTool(
    'list-integrations',
    {
      description: 'List all running integrations and their authorization status. Returns a compact overview — use list-authorizations(domain) for full details on a specific profile.',
      inputSchema: {},
    },
    listIntegrationsHandler(state, integrationManager)
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
    checkPendingCommitmentsHandler(state, integrationManager)
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
      const description = buildProxiedToolDescription(tool, state);

      try {
        const registered = server.registerTool(
          tool.namespacedName,
          {
            description,
            ...(Object.keys(zodShape).length > 0 ? { inputSchema: zodShape } : {}),
          },
          handler as Parameters<typeof server.registerTool>[2],
        );
        proxiedTools.set(tool.namespacedName, { tool, registered });
      } catch (err) {
        console.error(`[MCP] Failed to register tool ${tool.namespacedName}:`, err);
      }
    }
  }

  // ─── Dynamic tool descriptions ──────────────────────────────────────────

  function refreshTools() {
    const auths = state.getEnrichedAuthorizations();

    // Update proxied tool descriptions and visibility
    for (const [, { tool, registered }] of proxiedTools) {
      const description = buildProxiedToolDescription(tool, state);
      registered.update({ description });

      // All tools require authorization — enable/disable based on matching authorizations
      if (tool.gating?.profile) {
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
