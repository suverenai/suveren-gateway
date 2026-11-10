/**
 * list-authorizations tool — Tier 2 of the two-tier context model.
 *
 * No argument: the short answer — the active mandates, what is possible here
 *   in one line, the ONE next step and what the AI can do itself.
 * With domain: the exact steps for that area, per connector state, and full
 *   detail for matching mandates — bounds, consumption, intent, capability map.
 */

import type { SharedState, EnrichedAuthorization } from '../lib/shared-state';
import { lockedNotice, uiUrl } from '../lib/locked-notice';
import type { IntegrationManager } from '../lib/integration-manager';
import { getProfile } from '@hap/core';
import { getConsumptionState, formatConsumptionCompact, formatConsumptionFull } from '../lib/consumption';
import { readContextFile } from '../lib/context-loader';
import { profileMatches, toolAlwaysListed, areaName } from '../lib/tool-proxy';
import { isSimulationMode } from '../lib/simulation-mode';
import { firstMandateText, connectorOverview, manifestAreas, shortAnswer, possibleAreas, type GuideManifest } from '../lib/guidance';
import { overviewInput, guideManifests, setupCardName, setupMandateFacts } from '../lib/guidance-runtime';
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
    // A built-in's internal tools are never listed or callable by an agent —
    // naming them here (even as "refused") only invites a call.
    if (tool.internal || !tool.gating || !tool.gating.profile || (tool.simulationOnly && !isSimulationMode())) {
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

/**
 * Tools listed to the agent (toolAlwaysListed) that no complete mandate
 * covers yet, grouped by profile — "listed, but a call is refused until the
 * person grants a mandate". Without this the agent cannot tell a listed tool
 * it may use from one it may not, and calls blind.
 */
function listedWithoutMandate(
  authorizations: Array<{ profileId: string; complete: boolean }>,
  integrationManager: IntegrationManager | undefined,
): Array<{ profile: string; line: string }> {
  if (!integrationManager) return [];
  // Optional call: test doubles of the manager predate this hook.
  const isBuiltin = (id: string) => integrationManager.isBuiltin?.(id) ?? false;
  const builtinAlwaysListed = (id: string) => integrationManager.builtinAlwaysListed?.(id) ?? false;
  const byProfile = new Map<string, string[]>();
  for (const tool of integrationManager.getAllTools()) {
    if (!toolAlwaysListed(tool, isBuiltin, builtinAlwaysListed)) continue;
    const profile = tool.gating!.profile!;
    // A read is usable under any area its manifest names (readAlsoUnder).
    const areas = tool.gating!.category === 'read' ? [profile, ...(tool.gating!.readAlsoUnder ?? [])] : [profile];
    if (authorizations.some(a => a.complete && areas.some(p => profileMatches(a.profileId, p)))) continue;
    const short = shortProfileName(profile);
    byProfile.set(short, [...(byProfile.get(short) ?? []), tool.namespacedName]);
  }
  return [...byProfile.entries()].map(([profile, tools]) => ({ profile, line: `  ${profile}: ${tools.join(', ')}` }));
}

/**
 * A built-in's own "no mandate" text (e.g. Setup's two ways forward) for every
 * built-in whose profile no complete mandate covers. Its tools are usually not
 * listed without a mandate (setup is hidden), so without this the agent never
 * reaches the text and can only say "I can't" (Andreas, 2026-11-05).
 */
function builtinHintsWithoutMandate(
  authorizations: Array<{ profileId: string; complete: boolean }>,
  integrationManager: IntegrationManager | undefined,
): string[] {
  const hints = integrationManager?.builtinNoMandateTexts?.() ?? [];
  return hints
    .filter(h => !authorizations.some(a => a.complete && profileMatches(a.profileId, h.profile)))
    .map(h => h.text);
}

/**
 * What each connector still needs, for the whole gateway or for one area/connector.
 * Empty when no connector is known (nothing to lead the person through).
 */
async function connectorsSection(
  state: SharedState,
  integrationManager: IntegrationManager | undefined,
  authorizations: EnrichedAuthorization[],
  domain?: string,
): Promise<string> {
  try {
    let manifests: GuideManifest[] = guideManifests(integrationManager);
    if (domain) {
      const d = domain.toLowerCase();
      manifests = manifests.filter(m => m.id.toLowerCase() === d || manifestAreas(m).some(a => profileMatches(a, domain) || a.toLowerCase() === d));
    }
    if (manifests.length === 0) return '';
    const input = await overviewInput(state, integrationManager, authorizations, { onlyManifests: manifests });
    return connectorOverview({ ...input, detail: !!domain });
  } catch (err) {
    // A guidance failure must never hide the mandates themselves.
    console.error('[Suveren MCP] connector overview failed:', err);
    return '';
  }
}

/** The short answer's part after the mandates. Empty only if guidance itself fails. */
async function shortAnswerPart(
  state: SharedState,
  integrationManager: IntegrationManager | undefined,
  authorizations: EnrichedAuthorization[],
): Promise<string> {
  try {
    const setup = setupMandateFacts(integrationManager, authorizations);
    // Only the step this answer names can be blocked by a team: the first mandate.
    const teamAreas = authorizations.length === 0 && setup.area ? [setup.area] : [];
    const input = await overviewInput(state, integrationManager, authorizations, { teamAreas });
    return shortAnswer({ ...input, url: uiUrl() });
  } catch (err) {
    // A guidance failure must never hide the mandates themselves.
    console.error('[Suveren MCP] short answer failed:', err);
    return '';
  }
}

/** The area a domain names: the name the person sees ("Payments") means its area; anything else is left as given. */
function resolveDomain(domain: string, integrationManager: IntegrationManager | undefined): string {
  const d = domain.toLowerCase();
  for (const m of guideManifests(integrationManager)) {
    const hit = manifestAreas(m).find(a => areaName(a).toLowerCase() === d);
    if (hit) return hit;
  }
  return domain;
}

/** Which listed-but-unusable rows belong to this area or connector. */
function rowsForDomain(
  rows: Array<{ profile: string; line: string }>,
  domain: string,
  integrationManager: IntegrationManager | undefined,
): string[] {
  const d = domain.toLowerCase();
  const areas = guideManifests(integrationManager).filter(m => m.id.toLowerCase() === d).flatMap(m => manifestAreas(m));
  return rows.filter(r => profileMatches(r.profile, domain) || areas.some(a => profileMatches(r.profile, a))).map(r => r.line);
}

const LISTED_WITHOUT_MANDATE_HEADING =
  'Listed but not usable yet — no mandate covers these; every call is refused until the person grants one:';

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
    const domain = args?.domain ? resolveDomain(args.domain, integrationManager) : undefined;

    const notYet = listedWithoutMandate(authorizations, integrationManager);
    const hints = builtinHintsWithoutMandate(authorizations, integrationManager);

    if (authorizations.length === 0) {
      // No mandate at all reads the same in every mode: the words must not tell a working AI which mode it is in.
      const text = ['No active authorizations — no tool is usable yet.'];
      if (!domain) {
        const short = await shortAnswerPart(state, integrationManager, authorizations);
        if (short) text.push('', short);
        return { content: [{ type: 'text' as const, text: text.join('\n') }] };
      }
      text.push('', firstMandateText({ url: uiUrl(), card: setupCardName(integrationManager) }));
      const rows = rowsForDomain(notYet, domain, integrationManager);
      if (rows.length > 0) text.push('', LISTED_WITHOUT_MANDATE_HEADING, ...rows);
      for (const h of hints) text.push('', h);
      const section = await connectorsSection(state, integrationManager, authorizations, domain);
      if (section) text.push('', section);
      else {
        const areas = possibleAreas(guideManifests(integrationManager), areaName);
        if (areas.length > 0) text.push('', `No area or connector called "${args?.domain}". Possible here: ${areas.join(', ')}.`);
      }
      return { content: [{ type: 'text' as const, text: text.join('\n') }] };
    }

    // ── Domain-scoped detail view ──────────────────────────────────────────
    if (domain) {
      const matching = authorizations.filter(auth => {
        const shortName = shortProfileName(auth.profileId);
        return shortName === domain || profileMatches(auth.profileId, domain);
      });

      if (matching.length === 0) {
        const section = await connectorsSection(state, integrationManager, authorizations, domain);
        const rows = rowsForDomain(notYet, domain, integrationManager);
        return {
          content: [{
            type: 'text' as const,
            text: [`No authorizations found for domain "${domain}". Active domains: ${
              [...new Set(authorizations.map(a => shortProfileName(a.profileId)))].join(', ')
            }`, ...hints.flatMap(h => ['', h]), ...(rows.length > 0 ? ['', LISTED_WITHOUT_MANDATE_HEADING, ...rows] : []), ...(section ? ['', section] : [])].join('\n'),
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
        const statusLabel = !auth.complete ? ' (PENDING)' : auth.needsReapproval ? ' (MUST BE SIGNED AGAIN)' : '';
        output.push(`[${auth.path}] ${auth.profileId} (${remainingMin} min remaining)${statusLabel}`);
        if (auth.needsReapproval) {
          output.push('  The Authority Server no longer accepts this mandate\'s protocol version. Ask the mandate owner to sign it again (Mandates page → Sign again).');
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

      const domainSection = await connectorsSection(state, integrationManager, authorizations, domain);
      if (domainSection) output.push(domainSection, '');

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
        const statusLabel = auth.needsReapproval ? ' (MUST BE SIGNED AGAIN)' : '';
        const lines = [`  [${auth.path}] ${auth.profileId} — ${remainingMin} min remaining${statusLabel}`];
        lines.push(`    Bounds: ${boundsDesc}`);

        // Item 9 (re-approval UX): generic, not per-profile.
        if (auth.needsReapproval) {
          lines.push('    The Authority Server no longer accepts this mandate\'s protocol version. Ask the mandate owner to sign it again (Mandates page → Sign again).');
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
      output.push('Active authorizations (usable now):');
      output.push(...active);
    }
    if (pending.length > 0) {
      if (output.length > 0) output.push('');
      output.push('Pending (missing owners):');
      output.push(...pending);
    }
    // The steps of each connector come from list-authorizations(domain); this stays short.
    const short = await shortAnswerPart(state, integrationManager, authorizations);
    if (short) {
      if (output.length > 0) output.push('');
      output.push(short);
    }

    return {
      content: [{
        type: 'text' as const,
        text: output.join('\n'),
      }],
    };
  };
}
