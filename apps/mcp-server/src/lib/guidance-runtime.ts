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
import { getProfile, listProfiles, allowedCommitmentModes } from '@hap/core';
import {
  manifestAreas,
  type GuideAuth,
  type GuideManifest,
  type MissingMandateFacts,
  type MandateEnded,
  type OverviewInput,
  type SetupMandateFacts,
  type ProfileFieldsLike,
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
    area: tool.gating.profile.replace(/@.*$/, '').split('/').pop(),
    held,
    fields: { profile: field('profile'), mode: field('mode') },
    ...(held.length > 0 ? { tool: tool.namespacedName } : {}),
  };
}

/** The name of the card the person picks to give the mandate that lets an AI prepare mandates. */
export function setupCardName(im: IntegrationManager | undefined): string {
  return setupMandateFacts(im, []).card;
}

/** The newest known version of an area's profile, with the modes it may be signed with. */
export function newestProfileOf(area: string): { profile: ProfileFieldsLike; modes: readonly string[] } | undefined {
  const short = area.replace(/@.*$/, '').split('/').pop()!.toLowerCase();
  const num = (id: string) => (id.split('@')[1] ?? '').split('.').map(n => Number(n) || 0);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
  };
  let best: ReturnType<typeof getProfile>;
  for (const key of listProfiles()) {
    const p = getProfile(key);
    if (!p || (p.id.replace(/@.*$/, '').split('/').pop() ?? '').toLowerCase() !== short) continue;
    if (!best || newer(num(p.id), num(best.id))) best = p;
  }
  return best ? { profile: best as unknown as ProfileFieldsLike, modes: allowedCommitmentModes(best) } : undefined;
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
  opts: { onlyManifests?: GuideManifest[]; checkTeam?: boolean; teamAreas?: string[] } = {},
): Promise<OverviewInput> {
  const manifests = opts.onlyManifests ?? guideManifests(im);
  const setup = setupMandateFacts(im, auths);
  const facts = (id: string) => {
    const creds = im?.getServiceCredentials?.(id);
    const token = manifests.find(m => m.id === id)?.oauth?.tokenStorage;
    return {
      running: im?.isRunning?.(id) ?? false,
      blocked: im?.modeBlock?.(id),
      hasCredentials: !!creds,
      registered: im?.isRegistered?.(id),
      // Only said when the manifest names the token field; the same field the card reads.
      ...(token ? { signedIn: !!creds?.[token] } : {}),
    };
  };
  let team: Map<string, MissingMandateFacts> | undefined;
  if (opts.teamAreas) {
    team = (await teamChecks(state, opts.teamAreas)).checks;
  } else if (opts.checkTeam !== false) {
    const missing = new Set<string>();
    for (const m of manifests) {
      if (!facts(m.id).running) continue;
      for (const a of manifestAreas(m)) {
        if (!auths.some(x => x.complete && !x.needsReapproval && profileMatches(x.profileId, a))) missing.add(a);
      }
    }
    team = (await teamChecks(state, [...missing])).checks;
  }
  // An area that has run under a mandate before, and has none now, ended: only the local execution log can say.
  let history: Array<{ profileId: string }> = [];
  try { history = state?.executionLog?.getAll?.() ?? []; } catch { /* unknown: say nothing */ }
  const hadMandate = (area: string) => history.some(e => profileMatches(e.profileId, area));
  // The Authority Server's list says what became of each mandate, so the AI can say so. Best effort:
  // when it cannot be read, the local history above still gives the vaguer line.
  let mine: Array<{ profileId: string; status: string; createdAt: number }> = [];
  try { mine = (await state?.spClient?.getMyMandateStatuses?.()) ?? []; } catch { /* unknown: say nothing */ }
  const endedMandate = (area: string): MandateEnded | undefined => {
    const newest = mine.filter(r => profileMatches(r.profileId, area)).sort((a, b) => b.createdAt - a.createdAt)[0];
    return newest?.status === 'revoked' || newest?.status === 'expired' ? newest.status : undefined;
  };
  return { manifests, facts, auths, areaName, setup, team, toolName: toolNameOf, simulation: isSimulationMode(), hadMandate, endedMandate, profileOf: newestProfileOf,
    mandateProfileOf: (id) => getProfile(id) as never };
}
