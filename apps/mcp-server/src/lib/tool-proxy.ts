/**
 * Tool Proxy — HAP gating wrapper for proxied tool calls.
 *
 * Wraps downstream MCP tool calls with HAP authorization verification.
 * ALL tools require authorization — no ungated access.
 *
 * - Read-only tools (category: "read") require a matching authorization
 *   but skip execution context verification.
 * - Write tools require full execution context verification against bounds.
 */

import type { IntegrationManager, DiscoveredTool } from './integration-manager';
import type { SharedState, EnrichedAuthorization } from './shared-state';
import { SPReceiptError } from './sp-client';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

// Cap preview payload: proposals are stored in Redis and fetched on every
// thread poll. 1 MB file → ~1.3 MB base64. Larger files skip the preview
// and the card just shows the path as text.
const MAX_PREVIEW_BYTES = 1 * 1024 * 1024;

/**
 * If the tool call passes a local image path, read the file and attach a
 * data-URL preview to toolArgs so the review card can render it. The actual
 * tool execution still uses the original imagePath (downstream MCP reads the
 * file at execute time). The _imagePreview key is informational only and is
 * ignored by the downstream tool's zod schema.
 */
async function attachImagePreview(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const imagePath = typeof args.imagePath === 'string' ? args.imagePath : null;
  if (!imagePath) return args;
  if (args._imagePreview) return args; // already attached
  try {
    const mime = IMAGE_MIME[extname(imagePath).toLowerCase()];
    if (!mime) return args;
    const buf = await readFile(imagePath);
    if (buf.byteLength > MAX_PREVIEW_BYTES) return args; // don't bloat proposals
    return { ...args, _imagePreview: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return args; // file unreadable — show path only
  }
}

/**
 * Apply a single mapping entry to produce an execution context field.
 * Handles divisor, transform, and direct copy.
 */
function applyMapping(
  m: { field: string; divisor?: number; transform?: string },
  value: unknown,
  execution: Record<string, string | number>,
): void {
  if (m.divisor) {
    const numValue = typeof value === 'number' ? value : Number(value);
    execution[m.field] = numValue / m.divisor;
    return;
  }
  const arr = Array.isArray(value) ? value.map(String) : [String(value)];
  switch (m.transform) {
    case 'length':
      execution[m.field] = arr.length;
      break;
    case 'join':
      execution[m.field] = arr.join(',');
      break;
    case 'join_domains': {
      const domains = [...new Set(arr.map(email => {
        const at = email.lastIndexOf('@');
        return at >= 0 ? email.substring(at + 1).toLowerCase() : email.toLowerCase();
      }))].sort();
      execution[m.field] = domains.join(',');
      break;
    }
    default:
      execution[m.field] = typeof value === 'number' ? value : String(value);
  }
}

/** Match a short profile name (e.g. "charge") against a full qualified ID (e.g. "github.com/.../charge@0.3") */
export function profileMatches(profileId: string, shortName: string): boolean {
  return profileId === shortName || profileId.includes('/' + shortName + '@') || profileId.endsWith('/' + shortName);
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Create a handler function for a proxied tool that gates calls through HAP.
 *
 * All tools require authorization:
 * - Read tools (category: "read") → need matching auth, no execution context checks
 * - Write tools → full execution context verification against bounds
 */
export function createGatedToolHandler(
  tool: DiscoveredTool,
  integrationManager: IntegrationManager,
  state: SharedState,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  // Tools without gating config still require authorization if integration has a profile
  if (!tool.gating || !tool.gating.profile) {
    return async () => {
      return {
        content: [{
          type: 'text',
          text: `Tool "${tool.namespacedName}" has no gating configuration. All tools require authorization.`,
        }],
        isError: true,
      };
    };
  }

  const { profile, executionMapping, staticExecution, category } = tool.gating;

  // Read-only tools: require matching authorization but skip execution context checks
  if (category === 'read') {
    return async (args: Record<string, unknown>) => {
      const auths = state.getEnrichedAuthorizations();
      const matchingAuths = auths.filter(
        a => a.complete && profileMatches(a.profileId, profile!),
      );

      if (matchingAuths.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No active authorization matching profile "${profile}". ` +
              `A decision owner must grant authority via the Authority UI before this tool can be used.`,
          }],
          isError: true,
        };
      }

      // Authorization exists — proxy the read call (no execution context verification needed)
      return integrationManager.callTool(tool.integrationId, tool.originalName, args);
    };
  }

  // Write tools: full execution context verification
  return async (args: Record<string, unknown>) => {
    // Start with static values (e.g., scope: "external")
    const execution: Record<string, string | number> = { ...staticExecution };

    // Build execution context from tool args using the mapping
    for (const [argName, mapping] of Object.entries(executionMapping)) {
      const value = args[argName];
      if (value !== undefined && value !== null) {
        if (typeof mapping === 'string') {
          // Direct mapping: argName → contextField
          execution[mapping] = typeof value === 'number' ? value : String(value);
        } else if (Array.isArray(mapping)) {
          // Array mapping: one arg → multiple execution fields
          for (const m of mapping) applyMapping(m, value, execution);
        } else if ('divisor' in mapping) {
          // Divisor mapping: convert units (e.g., cents ÷ 100 → EUR)
          const numValue = typeof value === 'number' ? value : Number(value);
          execution[mapping.field] = numValue / mapping.divisor;
        } else if ('transform' in mapping) {
          // Transform mapping: array-aware transforms
          applyMapping(mapping, value, execution);
        }
      }
    }

    // Find all active authorizations matching this profile
    const auths = state.getEnrichedAuthorizations();
    const matchingAuths = auths.filter(
      a => a.complete && profileMatches(a.profileId, profile!),
    );

    if (matchingAuths.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No active authorization matching profile "${profile}". ` +
            `A decision owner must grant authority via the Authority UI before this tool can be used.`,
        }],
        isError: true,
      };
    }

    // Try each matching authorization until one passes verification
    const errors: string[] = [];
    for (const auth of matchingAuths) {
      // Pass v0.4 enriched fields (bounds/context from gate store) to gatekeeper
      const { result } = await state.gatekeeper.verifyExecution(auth.path, execution, {
        bounds: auth.bounds,
        context: auth.context,
      });

      if (!result.approved) {
      }
      if (result.approved) {
        // SP read-by-hash lookups (receipt, proposals) require the storage key.
        // frameHash is per-user scoped post-b228e58; boundsHash is the content
        // fingerprint and would miss on FrameMetadata reads.
        const authHash = auth.frameHash ?? auth.boundsHash;

        // Check for deferred commitment domains — submit proposal instead of executing
        if ((auth.deferredCommitmentDomains ?? []).length > 0) {
          try {
            const enrichedArgs = await attachImagePreview(args);
            const { proposal } = await state.spClient.submitProposal({
              frameHash: authHash,
              profileId: auth.profileId,
              path: auth.path,
              pendingDomains: auth.deferredCommitmentDomains,
              tool: tool.namespacedName,
              toolArgs: enrichedArgs,
              executionContext: { ...execution },
            });
            return {
              content: [{
                type: 'text',
                text: `Awaiting commitment from domain${auth.deferredCommitmentDomains.length > 1 ? 's' : ''} ` +
                  `"${auth.deferredCommitmentDomains.join('", "')}" for tool ${tool.originalName}.\n` +
                  `Proposal ID: ${proposal.id}. Check status with check-pending-commitments(proposal_id: "${proposal.id}").`,
              }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Failed to submit proposal: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }

        // Request receipt from SP (pre-flight — fail closed).
        //
        // `action` is the tool identifier used by the SP for the
        // PROPOSAL_MISMATCH equality check in review mode. In automatic
        // mode there's no proposal to match; we use the namespaced tool
        // name for consistency with the review-mode path.
        //
        // `actionType` tells the SP which bounds field to enforce
        // (e.g. write_daily_max vs delete_daily_max vs post_daily_max).
        // It MUST come from the integration manifest's staticExecution —
        // no prefix-based fallbacks. If a manifest declares a write tool
        // without action_type, we log a warning and send undefined; the
        // SP's generic action.split('_')[0] fallback is a last-resort
        // guard but is never expected to fire in practice.
        try {
          const actionType =
            typeof execution.action_type === 'string' ? execution.action_type : undefined;
          if (!actionType) {
            console.error(
              `[HAP MCP] Warning: tool ${tool.namespacedName} has no action_type in staticExecution. ` +
                `Bounds check may be skipped. Fix the integration manifest.`,
            );
          }

          await state.spClient.postReceipt({
            attestationHash: authHash,
            profileId: auth.profileId,
            path: auth.path,
            action: tool.namespacedName,
            actionType,
            executionContext: { ...execution },
            amount: typeof execution.amount === 'number' ? execution.amount : undefined,
          });
        } catch (err) {
          if (err instanceof SPReceiptError && err.statusCode === 409) {
            // P8.2: SP returned approval_required — this action exceeds the team cap
            // for an above-cap authority. Route to per-action multi-party approval:
            // creator + all profile approvers must approve before execution.
            const spBody = err.body as {
              approvers?: string[];
              frameHash?: string;
              field?: string;
              cap?: number;
            };
            // Prefer approvers from the 409 body; fall back to frameMeta frozen list.
            let pendingApprovers: string[] = spBody.approvers ?? [];
            if (pendingApprovers.length === 0) {
              // Defensive fallback: fetch frameMeta to get approversFrozen
              try {
                const frameMeta = await state.spClient.getFrameMetadata(authHash);
                if (frameMeta?.approversFrozen) {
                  pendingApprovers = frameMeta.approversFrozen;
                }
                if (frameMeta?.createdBy) {
                  pendingApprovers = [frameMeta.createdBy, ...pendingApprovers];
                }
              } catch {
                // best effort
              }
            } else {
              // Always include creator at the front — Decision #4: above-cap = everyone reviews,
              // creator INCLUDED regardless of authority-level mode.
              try {
                const frameMeta = await state.spClient.getFrameMetadata(authHash);
                if (frameMeta?.createdBy) {
                  pendingApprovers = [frameMeta.createdBy, ...pendingApprovers];
                }
              } catch {
                // best effort — proceed without creator in front
              }
            }
            const uniqueApprovers = [...new Set(pendingApprovers)];

            try {
              const enrichedArgs = await attachImagePreview(args);
              const { proposal } = await state.spClient.submitProposal({
                frameHash: authHash,
                profileId: auth.profileId,
                path: auth.path,
                pendingDomains: [],
                tool: tool.namespacedName,
                toolArgs: enrichedArgs,
                executionContext: { ...execution },
                pendingApprovers: uniqueApprovers,
              });
              return {
                content: [{
                  type: 'text',
                  text: `Action exceeds team cap. Approval required from ${uniqueApprovers.length} reviewer(s).\n` +
                    `Proposal ID: ${proposal.id}. Use check-pending-commitments to track status.`,
                }],
              };
            } catch (proposalErr) {
              return {
                content: [{ type: 'text', text: `Failed to submit approval proposal: ${proposalErr instanceof Error ? proposalErr.message : String(proposalErr)}` }],
                isError: true,
              };
            }
          }

          if (err instanceof SPReceiptError && err.statusCode === 422) {
            // Hard ceiling — no approver path configured. Bubble as a hard error.
            return {
              content: [{ type: 'text', text: `Action blocked: ${err.message} (hard team ceiling — contact the team admin)` }],
              isError: true,
            };
          }

          if (err instanceof SPReceiptError && err.statusCode === 403) {
            // SP rejected — limit exceeded or revoked. If revoked, purge the
            // cached attestation so list-authorizations/list-integrations
            // reflect reality instead of serving a stale "authorized" view.
            if (/revoked/i.test(err.message)) {
              state.cache.invalidate(auth.path);
            }
            return {
              content: [{ type: 'text', text: `Blocked by SP: ${err.message}` }],
              isError: true,
            };
          }
          // SP unreachable — fail closed
          return {
            content: [{ type: 'text', text: `SP unavailable — tool call blocked. ${err instanceof Error ? err.message : ''}` }],
            isError: true,
          };
        }

        // Record execution in log for cumulative tracking
        state.executionLog.record({
          profileId: auth.profileId,
          path: auth.path,
          execution: { ...execution },
          timestamp: Math.floor(Date.now() / 1000),
        });

        // Authorization verified — proxy the call
        return integrationManager.callTool(tool.integrationId, tool.originalName, args);
      }

      // Collect rejection reasons
      const reasons = result.errors.map(e => {
        if (e.code === 'BOUND_EXCEEDED') {
          return `${auth.path}: ${e.field}: ${e.message}`;
        }
        return `${auth.path}: ${e.message}`;
      });
      errors.push(...reasons);
    }

    // All authorizations failed
    return {
      content: [{
        type: 'text',
        text: `Tool call rejected by Gatekeeper. Tried ${matchingAuths.length} authorization(s):\n` +
          errors.map(e => `  - ${e}`).join('\n'),
      }],
      isError: true,
    };
  };
}

/**
 * Build a description for a proxied tool that includes a short gating tag.
 *
 * Tags:
 * - [HAP: charge — read] — read-only, requires authorization
 * - [HAP: charge — charge, amount checked] — gated with specific checks
 * - [HAP: charge — no active authorization] — gated but no auth available
 */
export function buildProxiedToolDescription(
  tool: DiscoveredTool,
  state: SharedState,
): string {
  if (!tool.gating || !tool.gating.profile) {
    return `[HAP: no gating config] ${tool.description}`;
  }

  const profile = tool.gating.profile;
  const auths = state.getEnrichedAuthorizations();
  const hasAuth = auths.some(
    a => a.complete && profileMatches(a.profileId, profile),
  );

  if (!hasAuth) {
    return `[HAP: ${profile} — no active authorization] ${tool.description}`;
  }

  if (tool.gating.category === 'read') {
    return `[HAP: ${profile} — read] ${tool.description}`;
  }

  // Build a short tag describing what's checked
  const parts: string[] = [];
  if (tool.gating.staticExecution?.action_type) {
    parts.push(String(tool.gating.staticExecution.action_type));
  }
  const mappedFields = Object.values(tool.gating.executionMapping ?? {}).flatMap(m =>
    typeof m === 'string' ? [m] : Array.isArray(m) ? m.map(e => e.field) : [m.field],
  );
  if (mappedFields.length > 0) {
    parts.push(`${mappedFields.join(', ')} checked`);
  }

  const tag = parts.length > 0 ? parts.join(', ') : 'gated';
  return `[HAP: ${profile} — ${tag}] ${tool.description}`;
}
