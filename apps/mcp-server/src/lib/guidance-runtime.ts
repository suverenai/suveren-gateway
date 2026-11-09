/**
 * Guidance, at runtime — turns what this gateway knows (connector manifests,
 * running connectors, the person's mandates, the control plane's team check)
 * into the inputs of the pure builders in guidance.ts. No wording lives here.
 *
 * Every call on the integration manager is optional-chained: partial doubles
 * of it in tests predate these hooks, and a missing fact must read as "unknown",
 * never throw inside a read tool.
 */

import type { IntegrationManager } from './integration-manager';
import type { SharedState } from './shared-state';
import { getAllManifests } from './manifest-loader';
import { isSimulationMode } from './simulation-mode';
import { controlPlaneMandate } from './cp-mandate';
import { profileMatches, areaName } from './tool-proxy';
import {
  manifestAreas,
  type GuideAuth,
  type GuideManifest,
  type MissingMandateFacts,
  type OverviewInput,
  type SetupMandateFacts,
} from './guidance';

/** The tool name an AI calls: `<connector>__<tool>`. */
export const toolNameOf = (connectorId: string, tool: string): string => `${connectorId}__${tool}`;

/** The manifests an AI is told about: those with an area, and — in test mode — only ones that can run there. */
export function guideManifests(im: IntegrationManager | undefined): GuideManifest[] {
  return (getAllManifests() as unknown as GuideManifest[])
    .filter(m => manifestAreas(m).length > 0)
    .filter(m => !isSimulationMode() || (im?.isSimulationSafe?.(m.id) ?? true));
}

/**
 * The built-in that proposes mandates, found by what it carries (the `mandate` action type),
 * not by name: its card name, the scope fields its arguments are checked against, and — when the
 * person holds a mandate for it — the tool the AI calls.
 */
export function setupMandateFacts(
  im: IntegrationManager | undefined,
  auths: GuideAuth[],
): SetupMandateFacts {
  const none: SetupMandateFacts = { card: 'Setup', held: [], fields: {} };
  const tool = im?.getAllTools?.().find(
    t => !!im?.isBuiltin?.(t.integrationId) && !t.internal && t.gating?.staticExecution?.action_type === 'mandate',
  );
  if (!im || !tool?.gating?.profile) return none;
  const builtin = im.getBuiltins?.().find(b => b.id === tool.integrationId);
  const mapping = (tool.gating.executionMapping ?? {}) as Record<string, unknown>;
  const field = (arg: string): string | undefined => (typeof mapping[arg] === 'string' ? (mapping[arg] as string) : undefined);
  const held = auths.filter(a => a.complete && !a.needsReapproval && profileMatches(a.profileId, tool.gating!.profile!));
  return {
    card: builtin?.name ?? none.card,
    held,
    fields: { profile: field('profile'), mode: field('mode') },
    ...(held.length > 0 ? { tool: tool.namespacedName } : {}),
  };
}

/** The name of the card the person picks to give the mandate that lets an AI prepare mandates. */
export function setupCardName(im: IntegrationManager | undefined): string {
  return setupMandateFacts(im, []).card;
}

const TEAM_CHECK_MS = 8000;

/**
 * For each area with no mandate: may the person give it in their team? Only a team can say no,
 * and only for a connector that already runs (an unset one has an earlier step). Best effort:
 * anything unclear is left out, and the sign page still says it.
 */
async function teamChecks(
  state: SharedState | undefined,
  areas: string[],
): Promise<{ checks: Map<string, MissingMandateFacts>; teamName?: string }> {
  const checks = new Map<string, MissingMandateFacts>();
  if (areas.length === 0 || typeof state?.spClient?.getActiveTeamGroupId !== 'function') return { checks };
  let teamId: string | null = null;
  try { teamId = await state.spClient.getActiveTeamGroupId(); } catch { return { checks }; }
  if (!teamId) return { checks };
  await Promise.all(areas.map(async area => {
    try {
      const r = await Promise.race([
        controlPlaneMandate(true, { profile: area, team: teamId, rightsOnly: true }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TEAM_CHECK_MS).unref?.()),
      ]);
      if (!r.ok && r.code) checks.set(area, { teamCode: r.code, teamName: teamNameFrom(r.message) });
    } catch { /* unknown: say nothing */ }
  }));
  return { checks };
}

/** The refusal names the team in quotes: `... in "Sales Vienna". Ask ...`. */
function teamNameFrom(message: string | undefined): string | undefined {
  return message?.match(/"([^"]+)"/)?.[1];
}

/** Everything `connectorOverview` needs, from live state. */
export async function overviewInput(
  state: SharedState | undefined,
  im: IntegrationManager | undefined,
  auths: GuideAuth[],
  opts: { onlyManifests?: GuideManifest[]; checkTeam?: boolean } = {},
): Promise<OverviewInput> {
  const manifests = opts.onlyManifests ?? guideManifests(im);
  const setup = setupMandateFacts(im, auths);
  const facts = (id: string) => ({
    running: im?.isRunning?.(id) ?? false,
    blocked: im?.modeBlock?.(id),
    hasCredentials: !!im?.getServiceCredentials?.(id),
  });
  let team: Map<string, MissingMandateFacts> | undefined;
  if (opts.checkTeam !== false) {
    const missing = new Set<string>();
    for (const m of manifests) {
      if (!facts(m.id).running) continue;
      for (const a of manifestAreas(m)) {
        if (!auths.some(x => x.complete && !x.needsReapproval && profileMatches(x.profileId, a))) missing.add(a);
      }
    }
    team = (await teamChecks(state, [...missing])).checks;
  }
  return { manifests, facts, auths, areaName, setup, team, toolName: toolNameOf };
}
