/**
 * Mandate Brief — renders enriched authorizations into a compact text brief
 * that is set as MCP `instructions` so the agent understands its mandate.
 *
 * Tier 1 of the two-tier context model: always loaded, one line per authority.
 * Intents, full bounds docs, and per-tool detail are Tier 2 — pulled on demand
 * via list-authorizations(domain). A user with 30 authorizations otherwise
 * pays ~15K tokens of Intent paragraphs on every session start.
 */

import type { EnrichedAuthorization } from './shared-state';
import type { ExecutionLog } from './execution-log';
import type { IntegrationManager } from './integration-manager';
import { getProfile } from '@hap/core';
import { getConsumptionState, formatConsumptionCompact } from './consumption';
import { getContextForBrief } from './context-loader';

/** Extract short profile name from full ID (e.g., "github.com/.../charge@0.3" → "charge") */
function shortProfileName(profileId: string): string {
  const withoutVersion = profileId.replace(/@.*$/, '');
  const parts = withoutVersion.split('/');
  return parts[parts.length - 1];
}

/** Count gated vs read-only tools for a profile */
function countToolsByGating(
  profileId: string,
  integrationManager: IntegrationManager | undefined,
): { gated: number; readOnly: number } {
  if (!integrationManager) return { gated: 0, readOnly: 0 };

  const allTools = integrationManager.getAllTools();
  let gated = 0;
  let readOnly = 0;

  for (const tool of allTools) {
    if (!tool.gating || !tool.gating.profile) {
      // No gating config at all — ungated
      readOnly++;
    } else if (tool.gating.profile === profileId || tool.gating.profile === shortProfileName(profileId)) {
      // Tool is associated with this profile
      if (tool.gating.staticExecution?.action_type === 'read' && Object.keys(tool.gating.executionMapping ?? {}).length === 0) {
        readOnly++;
      } else {
        gated++;
      }
    }
  }

  return { gated, readOnly };
}

export interface MandateBriefOptions {
  authorizations: EnrichedAuthorization[];
  executionLog?: ExecutionLog;
  integrationManager?: IntegrationManager;
  contextDir?: string;
}

/**
 * Build the mandate brief text from enriched authorizations.
 * Compact format — one-line summary per authority with consumption and tool counts.
 */
export function buildMandateBrief(opts: MandateBriefOptions): string {
  const { authorizations, executionLog, integrationManager, contextDir } = opts;

  const lines: string[] = [
    'You are connected to Suveren — the gateway that gates every privileged tool call you make.',
    'Suveren implements the bounded-authority model from the open Human Agency Protocol (HAP).',
    'You have bounded authorities granted by human decision owners.',
    'You MUST stay within these bounds — the Gatekeeper will reject actions that exceed them.',
  ];

  // === CONTEXT === (from user-maintained context.md)
  const { brief: contextBrief } = getContextForBrief(contextDir);
  if (contextBrief) {
    lines.push('');
    lines.push('=== CONTEXT ===');
    lines.push('');
    lines.push(contextBrief);
  }

  const active = authorizations.filter(a => a.complete);
  const pending = authorizations.filter(a => !a.complete);
  const now = Math.floor(Date.now() / 1000);

  if (active.length > 0) {
    lines.push('');
    lines.push('=== ACTIVE AUTHORITIES ===');
    lines.push('');

    for (const auth of active) {
      const earliestExpiry = Math.min(...auth.attestations.map(a => a.expiresAt));
      const remainingMin = Math.max(0, Math.round((earliestExpiry - now) / 60));

      const shortName = shortProfileName(auth.profileId);
      const version = auth.profileId.match(/@(.+)$/)?.[1] ?? '';
      const shortId = version ? `${shortName}@${version}` : shortName;

      const boundsDesc = Object.entries(auth.frame)
        .filter(([key]) => key !== 'profile' && key !== 'path')
        .map(([key, value]) => `${key}:${value}`)
        .join(' · ');

      // One compact line per authority: bounds · usage · tool count · expiry.
      // Intents are intentionally NOT inlined here — they stay pull-on-demand
      // via list-authorizations(domain) so a user with 30 authorizations
      // doesn't pay ~15K tokens of paragraphs on every session start.
      const parts: string[] = [];
      if (boundsDesc) parts.push(boundsDesc);

      if (executionLog) {
        const profile = getProfile(auth.profileId) ?? getProfile(shortName);
        const consumption = getConsumptionState(auth, executionLog, profile);
        const compact = formatConsumptionCompact(consumption);
        if (compact) parts.push(compact);
      }

      const { gated, readOnly } = countToolsByGating(auth.profileId, integrationManager);
      if (gated > 0 || readOnly > 0) parts.push(`${gated} gated tools`);

      parts.push(`${remainingMin} min remaining`);

      lines.push(`[${shortId}] ${parts.join(' · ')}`);
      lines.push(`  → list-authorizations(domain: "${shortName}") for intent & details`);
      lines.push('');
    }
  }

  if (pending.length > 0) {
    lines.push('=== PENDING (awaiting attestations) ===');
    lines.push('');

    for (const auth of pending) {
      const missing = auth.requiredDomains.filter(d => !auth.attestedDomains.includes(d));
      lines.push(`[${auth.path}] ${auth.profileId} — needs: ${missing.join(', ')}`);
    }

    lines.push('');
  }

  // Instruction to use list-authorizations for detail
  lines.push('When you receive a task, call list-authorizations(domain) to load full details for the relevant domain.');

  return lines.join('\n');
}
