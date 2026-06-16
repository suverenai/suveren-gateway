/**
 * list-authorizations tool — Tier 2 of the two-tier context model.
 *
 * No argument: compact overview of all active authorities (refreshed).
 * With domain: full detail for matching authority — bounds, consumption,
 *   intent, and capability map.
 */

import type { SharedState } from '../lib/shared-state';
import type { IntegrationManager } from '../lib/integration-manager';
import { getProfile } from '@hap/core';
import type { ProfileToolGating } from '@hap/core';
import { getConsumptionState, formatConsumptionCompact, formatConsumptionFull } from '../lib/consumption';
import { readContextFile } from '../lib/context-loader';
import { profileMatches } from '../lib/tool-proxy';

/** Extract short profile name from full ID */
function shortProfileName(profileId: string): string {
  const withoutVersion = profileId.replace(/@.*$/, '');
  const parts = withoutVersion.split('/');
  return parts[parts.length - 1];
}

/** Build a capability map for a profile from its toolGating + discovered tools */
function buildCapabilityMap(
  profileId: string,
  toolGating: ProfileToolGating | undefined,
  integrationManager: IntegrationManager | undefined,
): string {
  if (!integrationManager || !toolGating) return '';

  const allTools = integrationManager.getAllTools();
  const shortName = shortProfileName(profileId);

  const gated: string[] = [];
  const readOnly: string[] = [];
  const defaultGated: string[] = [];

  for (const tool of allTools) {
    if (!tool.gating || !tool.gating.profile) {
      continue;
    }

    // Only include tools matching this profile
    if (!profileMatches(tool.gating.profile, shortName) && tool.gating.profile !== profileId) {
      continue;
    }

    const overrides = toolGating.overrides ?? {};
    const override = overrides[tool.originalName];

    if (override === null) {
      // Explicitly exempt from gating
      readOnly.push(tool.originalName);
    } else if (override !== undefined) {
      // Has specific override — this is a gated tool
      const mappingDesc = Object.entries(override.executionMapping ?? {})
        .map(([arg, mapping]) => {
          if (typeof mapping === 'string') return `${mapping} from ${arg}`;
          if (Array.isArray(mapping)) return `${mapping.map(m => m.field).join('+')} from ${arg}`;
          if ('divisor' in mapping) return `${mapping.field} from ${arg} (/${mapping.divisor})`;
          return `${mapping.field} from ${arg}`;
        })
        .join(', ');
      const actionType = override.staticExecution?.action_type ?? 'unknown';
      gated.push(`      - ${tool.originalName}: ${actionType}${mappingDesc ? `, ${mappingDesc}` : ''}`);
    } else {
      // Falls through to default gating
      const defaultAction = toolGating.default.staticExecution?.action_type;
      if (defaultAction === 'read' && Object.keys(toolGating.default.executionMapping ?? {}).length === 0) {
        defaultGated.push(tool.originalName);
      } else {
        gated.push(`      - ${tool.originalName}: ${defaultAction ?? 'default'} (default gating)`);
      }
    }
  }

  const lines: string[] = [];
  lines.push('  Capability Map:');

  if (gated.length > 0) {
    lines.push('    Gated (checked per call):');
    lines.push(...gated);
  }

  if (readOnly.length > 0) {
    lines.push(`    Read-only (no authorization needed): ${readOnly.join(', ')}`);
  }

  if (defaultGated.length > 0) {
    lines.push(`    Default-gated (action_type: ${toolGating.default.staticExecution?.action_type ?? 'read'}): ${defaultGated.join(', ')}`);
  }

  if (gated.length === 0 && readOnly.length === 0 && defaultGated.length === 0) {
    lines.push('    No tools discovered for this profile.');
  }

  return lines.join('\n');
}

export function listAuthorizationsHandler(
  state: SharedState,
  integrationManager?: IntegrationManager,
  contextDir?: string,
) {
  return async (args?: { domain?: string }) => {
    const authorizations = state.getEnrichedAuthorizations();
    const now = Math.floor(Date.now() / 1000);
    const domain = args?.domain;

    if (authorizations.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No active authorizations. A decision owner must grant authority via the Authority UI.',
        }],
      };
    }

    // ── Domain-scoped detail view ──────────────────────────────────────────
    if (domain) {
      const matching = authorizations.filter(auth => {
        const shortName = shortProfileName(auth.profileId);
        return shortName === domain || profileMatches(auth.profileId, domain);
      });

      if (matching.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No authorizations found for domain "${domain}". Active domains: ${
              [...new Set(authorizations.map(a => shortProfileName(a.profileId)))].join(', ')
            }`,
          }],
        };
      }

      const output: string[] = [];
      for (const auth of matching) {
        const earliestExpiry = Math.min(...auth.attestations.map(a => a.expiresAt));
        const remainingMin = Math.max(0, Math.round((earliestExpiry - now) / 60));

        const boundsDesc = Object.entries(auth.frame)
          .filter(([key]) => key !== 'profile' && key !== 'path')
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ');

        const statusLabel = auth.complete ? '' : ' (PENDING)';
        output.push(`[${auth.path}] ${auth.profileId} (${remainingMin} min remaining)${statusLabel}`);
        output.push('');
        output.push(`  Bounds: ${boundsDesc}`);

        // Commitment mode (automatic vs review) — previously only discoverable
        // from the intent prose; surface it as structured output.
        const reviewDomains = auth.deferredCommitmentDomains ?? [];
        output.push(reviewDomains.length > 0
          ? '  Mode: review — each action requires your approval before it runs (a proposal is created, not executed)'
          : '  Mode: automatic — actions run immediately within bounds');

        // Above team cap → actions require approval even within these bounds
        // (Phase 6). Best-effort SP read; skipped silently if SP is unreachable.
        try {
          const meta = await state.spClient.getFrameMetadata(auth.frameHash ?? auth.boundsHash ?? auth.path);
          if (meta?.aboveCap) {
            output.push('  ⚠ Above team cap — actions here require approval even within these bounds.');
          }
        } catch { /* best-effort */ }

        // Full consumption detail
        const shortName = shortProfileName(auth.profileId);
        const profile = getProfile(auth.profileId) ?? getProfile(shortName);
        if (profile) {
          const consumption = getConsumptionState(auth, state.executionLog, profile);
          const consumptionText = formatConsumptionFull(consumption);
          if (consumptionText) {
            output.push('');
            output.push('  Usage:');
            output.push(consumptionText);
          }
        }

        // Context (allowed scope — stored locally, never sent to SP)
        if (auth.context) {
          const contextEntries = Object.entries(auth.context).filter(([, v]) => v !== '' && v !== undefined);
          if (contextEntries.length > 0) {
            output.push('');
            output.push('  Scope:');
            for (const [k, v] of contextEntries) {
              output.push(`    ${k}: ${v}`);
            }
          }
        }

        // Gate content
        if (auth.gateContent?.intent) {
          output.push('');
          output.push(`  Intent: ${auth.gateContent.intent}`);
        }

        // Pending domain info
        if (!auth.complete) {
          const missing = auth.requiredDomains.filter(d => !auth.attestedDomains.includes(d));
          output.push('');
          output.push(`  Missing attestations: ${missing.join(', ')}`);
        }

        // Capability map
        if (profile && integrationManager) {
          output.push('');
          output.push(buildCapabilityMap(auth.profileId, profile.toolGating, integrationManager));
        }

        output.push('');
      }

      return {
        content: [{
          type: 'text' as const,
          text: output.join('\n'),
        }],
      };
    }

    // ── Compact overview (no domain) ───────────────────────────────────────
    const active: string[] = [];
    const pending: string[] = [];

    // Include context if available
    const context = readContextFile(contextDir);

    for (const auth of authorizations) {
      const earliestExpiry = Math.min(...auth.attestations.map(a => a.expiresAt));
      const remainingMin = Math.max(0, Math.round((earliestExpiry - now) / 60));

      const boundsDesc = Object.entries(auth.frame)
        .filter(([key]) => key !== 'profile' && key !== 'path')
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');

      if (auth.complete) {
        const lines = [`  [${auth.path}] ${auth.profileId} — ${remainingMin} min remaining`];
        lines.push(`    Bounds: ${boundsDesc}`);

        // Flag review mode in the compact view (automatic is the unremarkable default)
        if ((auth.deferredCommitmentDomains ?? []).length > 0) {
          lines.push('    Mode: review (each action requires your approval)');
        }

        // Compact consumption
        const shortName = shortProfileName(auth.profileId);
        const profile = getProfile(auth.profileId) ?? getProfile(shortName);
        if (profile) {
          const consumption = getConsumptionState(auth, state.executionLog, profile);
          const compact = formatConsumptionCompact(consumption);
          if (compact) {
            lines.push(`    Usage: ${compact}`);
          }
        }

        lines.push(`    Call list-authorizations(domain: "${shortProfileName(auth.profileId)}") for full details`);
        active.push(lines.join('\n'));
      } else {
        const missing = auth.requiredDomains.filter(d => !auth.attestedDomains.includes(d));
        pending.push(
          `  ${auth.path}: ${boundsDesc} — needs ${missing.join(', ')} attestation, ${remainingMin} min remaining`
        );
      }
    }

    const output: string[] = [];

    if (context) {
      output.push('=== CONTEXT ===');
      output.push(context);
      output.push('');
    }

    if (active.length > 0) {
      output.push('Active authorizations:');
      output.push(...active);
    }
    if (pending.length > 0) {
      if (output.length > 0) output.push('');
      output.push('Pending (missing owners):');
      output.push(...pending);
    }

    return {
      content: [{
        type: 'text' as const,
        text: output.join('\n'),
      }],
    };
  };
}
