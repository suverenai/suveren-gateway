/**
 * list-authorizations tool — Tier 2 of the two-tier context model.
 *
 * No argument: compact overview of all active authorities (refreshed).
 * With domain: full detail for matching authority — bounds, consumption,
 *   intent, and capability map.
 */

import type { SharedState } from '../lib/shared-state';
import { lockedNotice } from '../lib/locked-notice';
import type { IntegrationManager } from '../lib/integration-manager';
import { getProfile } from '@hap/core';
import { getConsumptionState, formatConsumptionCompact, formatConsumptionFull } from '../lib/consumption';
import { readContextFile } from '../lib/context-loader';
import { profileMatches } from '../lib/tool-proxy';
import { agentVisibleAuthorizations } from '../lib/agent-visibility';

/** Extract short profile name from full ID */
function shortProfileName(profileId: string): string {
  const withoutVersion = profileId.replace(/@.*$/, '');
  const parts = withoutVersion.split('/');
  return parts[parts.length - 1];
}

/**
 * Build a capability map for a profile from the already-resolved per-tool
 * gating (`tool.gating`, a `ToolGatingConfig` — integration-manager.ts's
 * `resolveToolGating`) + discovered tools.
 *
 * Reads each tool's OWN resolved gating directly rather than re-deriving it
 * from a profile-level `toolGating` block: hap-core 0.12 dropped
 * `AgentProfile.toolGating` (never a protocol concept — see
 * tool-gating-types.ts), and the manifest's per-tool entry was always the
 * preferred source anyway (integration-manager.ts: "prefer manifest
 * toolGating over profile's").
 */
function buildCapabilityMap(
  profileId: string,
  integrationManager: IntegrationManager | undefined,
): string {
  if (!integrationManager) return '';

  const allTools = integrationManager.getAllTools();
  const shortName = shortProfileName(profileId);

  const gated: string[] = [];
  const readOnly: string[] = [];
  /** Discovered but described by no manifest entry ⇒ refused at the gate. */
  const undescribed: string[] = [];

  for (const tool of allTools) {
    if (!tool.gating || !tool.gating.profile) {
      continue;
    }

    // Only include tools matching this profile
    if (!profileMatches(tool.gating.profile, shortName) && tool.gating.profile !== profileId) {
      continue;
    }

    const gating = tool.gating;

    if (gating.category === 'read') {
      readOnly.push(tool.originalName);
    } else if (gating.category === 'disabled') {
      // Either explicitly disabled, or (disabledReason set) not described by
      // any manifest entry — either way the gate refuses it; no permissive
      // default exists to fall back on. Listing it as gated would tell the
      // agent it may call something every call of which is refused.
      undescribed.push(tool.originalName);
    } else {
      const mappingDesc = Object.entries(gating.executionMapping ?? {})
        .map(([arg, mapping]) => {
          if (typeof mapping === 'string') return `${mapping} from ${arg}`;
          if (Array.isArray(mapping)) return `${mapping.map(m => m.field).join('+')} from ${arg}`;
          if ('divisor' in mapping) return `${mapping.field} from ${arg} (/${mapping.divisor})`;
          return `${mapping.field} from ${arg}`;
        })
        .join(', ');
      const actionType = gating.staticExecution?.action_type ?? 'unknown';
      gated.push(`      - ${tool.originalName}: ${actionType}${mappingDesc ? `, ${mappingDesc}` : ''}`);
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

  if (undescribed.length > 0) {
    lines.push(
      `    Refused (no manifest entry — do not call): ${undescribed.join(', ')}`,
    );
  }

  if (gated.length === 0 && readOnly.length === 0 && undescribed.length === 0) {
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
    // Running but locked reads as "no authorizations" unless we say so.
    if (!state.spClient.isUnlocked()) {
      return { content: [{ type: 'text' as const, text: lockedNotice('list authorizations', state.spClient.getLockReason() ?? 'restart') }] };
    }
    // In simulation mode, hide authorizations for profiles with no running
    // integration — see agent-visibility.ts. A no-op outside simulation.
    const authorizations = agentVisibleAuthorizations(state.getEnrichedAuthorizations(), integrationManager);
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

        // Item 9 (re-approval UX): generic, not per-profile — a mandate the
        // AS can no longer verify (pre-0.7 blob) still shows, flagged, with
        // the clear action named below rather than silently vanishing.
        const statusLabel = !auth.complete ? ' (PENDING)' : auth.needsReapproval ? ' (NEEDS RE-APPROVAL)' : '';
        output.push(`[${auth.path}] ${auth.profileId} (${remainingMin} min remaining)${statusLabel}`);
        if (auth.needsReapproval) {
          output.push('  The Authority Server no longer verifies this mandate\'s protocol version. Ask the decision owner to re-approve it.');
        }
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
          const meta = await state.spClient.getAuthorizationSummary(auth.authorizationId);
          if (meta?.above_cap) {
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
          output.push(`  Missing mandates: ${missing.join(', ')}`);
        }

        // Capability map
        if (profile && integrationManager) {
          output.push('');
          output.push(buildCapabilityMap(auth.profileId, integrationManager));
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
        const statusLabel = auth.needsReapproval ? ' (NEEDS RE-APPROVAL)' : '';
        const lines = [`  [${auth.path}] ${auth.profileId} — ${remainingMin} min remaining${statusLabel}`];
        lines.push(`    Bounds: ${boundsDesc}`);

        // Item 9 (re-approval UX): generic, not per-profile.
        if (auth.needsReapproval) {
          lines.push('    The Authority Server no longer verifies this mandate\'s protocol version. Ask the decision owner to re-approve it.');
        }

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
          `  ${auth.path}: ${boundsDesc} — needs ${missing.join(', ')} mandate, ${remainingMin} min remaining`
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
