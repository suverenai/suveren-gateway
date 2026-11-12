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
import { uiPort } from './locked-notice';
import { AGENT_RULES } from './agent-rules';
import { firstMandateText, LEAD_THE_PERSON_RULE, REFUSAL_RULE, FIRST_LINE, REPLY_RULE, roleText, factsLines, possibleAreas, manifestAreas, type GuideManifest } from './guidance';

const connectorNames = (ms: GuideManifest[]): string[] => [...new Set(ms.filter(m => manifestAreas(m).length > 0).map(m => m.name))];
import { setupCardName, setupMandateFacts, guideManifests } from './guidance-runtime';
import { areaName } from './tool-proxy';

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
    // Never shown to anyone, gateway-internal only (DL1) — would otherwise
    // inflate "N gated tools" by the builtin's own preview helpers.
    if (tool.internal || (tool.simulationOnly && !isSimulationMode())) continue;
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

  // The first line alone must work: some apps show the AI nothing else until it loads the tools.
  // Claude Code keeps only the first 4096 characters, so what every AI needs comes first: the reply
  // rule, the rules (golden rule first), the role; the state, the agent brief and the facts after.
  const lines: string[] = [
    FIRST_LINE,
    REPLY_RULE,
    LEAD_THE_PERSON_RULE,
    // Refusal rule (Andreas, 2026-11-12): a mandate/limit refusal is final; an
    // argument refusal says how to fix it and may be fixed once. Codex read the
    // old "do not retry" literally and stopped on a wrong-type refusal.
    'Tools are listed even where no mandate covers them yet. ' + REFUSAL_RULE,
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

  // Always, in every mode: what an agent must never do with this gateway.
  lines.push('');
  lines.push('=== RULES ===');
  lines.push('');
  for (const r of AGENT_RULES) lines.push(`- ${r}`);
  lines.push('');

  // The role, right after the rules (Andreas, 2026-11-12): the fixed text every AI needs comes first,
  // so what Claude Code cuts after 4096 characters is the variable part (mandates, the agent brief,
  // the facts), never the role. Word for word the same in every mode; it must never say which mode.
  const card = setupCardName(integrationManager);
  lines.push('=== YOUR ROLE ===');
  lines.push('');
  lines.push(roleText(card));
  lines.push('');

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
    lines.push('=== MUST BE SIGNED AGAIN ===');
    lines.push('');
    for (const auth of needingReapproval) {
      lines.push(
        `[${shortProfileName(auth.profileId)}] ${auth.authorizationId}: the Authority Server no longer ` +
          'accepts this mandate\'s protocol version. Ask the mandate owner to sign it again (Mandates page → Sign again).',
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

  // No mandate at all: the one step only a person can take, in the page's own words. The same block
  // in every mode, with no condition on how the person opens: its words must not tell a working AI
  // which mode it is in (see agent-visibility.ts).
  if (active.length === 0) {
    lines.push('=== FIRST STEP ===');
    lines.push('');
    const setup = setupMandateFacts(integrationManager, []);
    lines.push(firstMandateText({ card: setup.card, area: setup.area }));
    lines.push('');
  }

  // Test mode, with a mandate in place: lead into the setup guide, or name the one step a person takes
  // (the Setup mandate). Neutral words — no "simulation" or "test" — because the working AI reads them too.
  if (isSimulationMode() && active.length > 0) {
    // The built-in that carries the `mandate` action type, found as setupMandateFacts finds it: no area name in code.
    const canSetUp = setupMandateFacts(integrationManager, active).held.length > 0;
    lines.push('=== GETTING STARTED ===');
    lines.push('');
    lines.push(canSetUp
      ? 'To set up their work with Suveren, call setup__get_guide first and follow its steps in order.'
      : `To set up more of their work, they first create a "${setupCardName(integrationManager)}" mandate on the Suveren Gateway page, which they open themselves in their own browser. With it you can read the setup guide and lead them through the setup.`);
    lines.push('');
  }

  // === CONTEXT === (from user-maintained context.md). The AI also gets it in full from
  // list-authorizations(), which the first line sends it to.
  const { brief: contextBrief } = getContextForBrief(contextDir);
  if (contextBrief) {
    lines.push('=== CONTEXT ===');
    lines.push('');
    lines.push(contextBrief);
    lines.push('');
  }

  // Always, in every mode: the facts the AI draws on, then what this gateway offers. The words are
  // the AI's own to find, so they must never say which mode this is. Claude Code cuts after 4096
  // characters: the area list (also in list-authorizations()) is what falls off first.
  const manifests = guideManifests(integrationManager);
  lines.push('=== FACTS YOU CAN DRAW ON ===');
  lines.push('');
  for (const f of factsLines({ port: uiPort(), card, areas: [] })) lines.push(`- ${f}`);
  lines.push('');
  const running = (n: string) => manifests.some(m => m.name === n && integrationManager?.isRunning?.(m.id));
  const onThisGateway = factsLines({
    card,
    gateway: true,
    areas: possibleAreas(manifests, areaName),
    connected: connectorNames(manifests).filter(running),
    notConnected: connectorNames(manifests).filter(n => !running(n)),
  }).slice(factsLines({ card, areas: [] }).length);
  if (onThisGateway.length > 0) {
    lines.push('=== ON THIS GATEWAY ===');
    lines.push('');
    for (const f of onThisGateway) lines.push(`- ${f}`);
  }

  return lines.join('\n');
}
