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
import { createGatedToolHandler, buildProxiedToolDescription, profileMatches } from './lib/tool-proxy';

// ─── JSON Schema → Zod conversion ──────────────────────────────────────────

/**
 * Convert a JSON Schema properties object to a Zod shape for registerTool.
 * Handles common types; defaults to z.unknown() for complex or unrecognized schemas.
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: z.ZodTypeAny;

    switch (prop.type) {
      case 'string':
        if (prop.enum && Array.isArray(prop.enum)) {
          zodType = z.enum(prop.enum as [string, ...string[]]);
        } else {
          zodType = z.string();
        }
        break;
      case 'number':
      case 'integer':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.unknown());
        break;
      case 'object':
        zodType = z.record(z.unknown());
        break;
      default:
        zodType = z.unknown();
        break;
    }

    if (typeof prop.description === 'string') {
      zodType = zodType.describe(prop.description);
    }

    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return shape;
}

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
      if (proxiedTools.has(tool.namespacedName)) continue;

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
        const hasAuth = auths.some(
          a => a.complete && profileMatches(a.profileId, tool.gating!.profile!),
        );
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
