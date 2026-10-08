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
import { agentVisibleAuthorizations } from './agent-visibility';
import { isSimulationMode } from './simulation-mode';
import { uiUrl } from './locked-notice';
import { AGENT_RULES } from './agent-rules';

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
  /** V7 — shared-state.ts's `asVersionRefusal`. Non-null means the paired
   *  Authority Server does not support this gateway's protocol version;
   *  every gated tool call already refuses on its own (tool-proxy.ts), but
   *  the agent should see this up front rather than discover it one
   *  refused call at a time. */
  asVersionRefusal?: string | null;
}

/**
 * Build the mandate brief text from enriched authorizations.
 * Compact format — one-line summary per authority with consumption and tool counts.
 */
export function buildMandateBrief(opts: MandateBriefOptions): string {
  const { executionLog, integrationManager, contextDir } = opts;
  // In simulation mode, hide authorities for profiles with no running
  // integration — see agent-visibility.ts. A no-op outside simulation.
  const authorizations = agentVisibleAuthorizations(opts.authorizations, integrationManager);

  const lines: string[] = [
    'You are connected to Suveren — the gateway that gates every privileged tool call you make.',
    'Suveren implements the bounded-authority model from the open Human Agency Protocol (HAP).',
    'You have bounded authorities granted by human decision owners.',
    'You MUST stay within these bounds — the Gatekeeper will reject actions that exceed them.',
  ];

  // V7 — fail closed, up front: if the paired Authority Server does not
  // support this gateway's protocol version, no gated action can run at
  // all this session. Every individual call already refuses on its own;
  // this says so once, before the agent tries the first one.
  if (opts.asVersionRefusal) {
    lines.push('');
    lines.push('=== AUTHORITY SERVER INCOMPATIBLE — NO GATED ACTION WILL RUN ===');
    lines.push('');
    lines.push(opts.asVersionRefusal);
  }

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

  // Item 9 (re-approval UX) — generic, not per-profile: any authorization
  // the AS has told us (via a VERSION_UNSUPPORTED ticket refusal) carries
  // only a pre-0.7 mandate blob. Its own OWN section, ahead of the normal
  // active list, so it is impossible to miss — the clear action is "ask
  // the decision owner to re-approve it" (list-authorizations names it).
  const needingReapproval = active.filter(a => a.needsReapproval);
  if (needingReapproval.length > 0) {
    lines.push('');
    lines.push('=== NEEDS RE-APPROVAL ===');
    lines.push('');
    for (const auth of needingReapproval) {
      lines.push(
        `[${shortProfileName(auth.profileId)}] ${auth.authorizationId}: the Authority Server no longer ` +
          'verifies this mandate\'s protocol version. Ask the decision owner to re-approve it.',
      );
    }
    lines.push('');
  }

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
    lines.push('=== PENDING (awaiting mandates) ===');
    lines.push('');

    for (const auth of pending) {
      const missing = auth.requiredDomains.filter(d => !auth.attestedDomains.includes(d));
      lines.push(`[${auth.path}] ${auth.profileId} — needs: ${missing.join(', ')}`);
    }

    lines.push('');
  }

  // First contact in simulation mode: a person asking their AI "how do I start
  // with Suveren?" must get led into the setup guide, or told the one step only
  // a person can take (the Delegation mandate). Neutral words — no "simulation"
  // or "test" — because the working AI reads these lines too and must not be
  // able to tell simulation from live (see agent-visibility.ts).
  if (isSimulationMode()) {
    const canSetUp = active.some(a => shortProfileName(a.profileId) === 'delegation');
    lines.push('=== GETTING STARTED ===');
    lines.push('');
    lines.push(canSetUp
      ? 'If the person asks how to start with Suveren or how to set up their work with it: call setup__get_guide first and follow its steps in order.'
      : `If the person asks how to start with Suveren: they first create a "Delegation" mandate in the Suveren Gateway at ${uiUrl()}. With it you can read the setup guide and lead them through the setup.`);
    lines.push('');
  }

  // Always, in every mode: what an agent must never do with this gateway.
  lines.push('=== RULES ===');
  lines.push('');
  for (const r of AGENT_RULES) lines.push(`- ${r}`);
  lines.push('');

  // Instruction to use list-authorizations for detail
  lines.push('When you receive a task, call list-authorizations(domain) to load full details for the relevant domain.');

  return lines.join('\n');
}
