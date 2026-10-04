/**
 * Agent visibility — what an authorization-enumerating tool/brief may show
 * the WORKING agent while simulation mode is on.
 *
 * Rule (Andreas, 2026-10-02): in simulation mode the agent must not be able
 * to tell simulation from live. Simulation mode already starts only
 * connectors whose manifest declares `simulation` (see simulation-mode.ts /
 * integration-manager.ts) — every real connector (gmail, deploy-github,
 * mollie, calendar, …) is paused. But a mandate is bound to a PROFILE, not a
 * connector, so an authorization for a profile whose only connector is a
 * paused real one is still sitting in `getEnrichedAuthorizations()`. Showing
 * it tells the agent "you have authority for a system you cannot reach" —
 * itself a tell that something is off.
 *
 * Fix: hide an authorization from the agent, in simulation mode only, unless
 * at least one RUNNING integration is governed by its profile — using the
 * exact same profile-matching `IntegrationManager.getAllTools()` already
 * uses for tool enable/disable and for `list-integrations` (which only ever
 * lists running integrations, so it was already clean). Generic: no
 * per-profile or per-connector logic, just the existing profileMatches
 * convention (a tool's `gating.profile` — a short or full profile id — vs an
 * authorization's full `profileId`).
 *
 * Outside simulation mode this is a no-op — every authorization passes
 * through unchanged, so behaviour off simulation is byte-identical to before
 * this existed.
 *
 * Used by every agent-facing place that enumerates authorizations: the
 * list-authorizations tool (compact overview, domain detail, the "Active
 * domains:" not-found hint) and the mandate brief (MCP session
 * instructions). A hidden authorization must read, everywhere, exactly like
 * one that doesn't exist.
 */
import type { IntegrationManager } from './integration-manager';
import { isSimulationMode } from './simulation-mode';
import { profileMatches } from './tool-proxy';

/**
 * Filter authorizations to the ones the agent may be told about right now.
 *
 * Off simulation: returns `authorizations` unchanged.
 * On simulation: keeps only authorizations whose profile matches at least
 * one currently RUNNING integration's tool-gating profile. With no
 * integration manager at all (should not happen in practice — every caller
 * that can see authorizations also has one), this fails closed and hides
 * everything, consistent with "no receipt, no execution" style fail-closed
 * defaults elsewhere in the gateway.
 */
export function agentVisibleAuthorizations<T extends { profileId: string }>(
  authorizations: T[],
  integrationManager: IntegrationManager | undefined,
): T[] {
  if (!isSimulationMode()) return authorizations;

  if (!integrationManager) return [];

  const runningProfiles = new Set<string>();
  for (const tool of integrationManager.getAllTools()) {
    const profile = tool.gating?.profile;
    if (profile) runningProfiles.add(profile);
  }

  if (runningProfiles.size === 0) return [];

  return authorizations.filter(auth =>
    [...runningProfiles].some(profile => profileMatches(auth.profileId, profile)),
  );
}
