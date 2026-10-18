/**
 * Simulation mode — a gateway-WIDE switch that blocks every real system.
 *
 * WHY this exists (and why it is not per-connector): a mandate is bound to a
 * PROFILE, not a connector (see `profileMatches` in tool-proxy.ts). Put a real
 * connector (e.g. gmail) and a simulated one (e.g. "mail", the email
 * simulator) on the same profile in one gateway, and a mandate meant only for
 * the simulated one also authorizes the real one — nothing in the mandate
 * names which connector it's for. Rather than inventing a per-mandate or
 * per-profile carve-out, simulation mode is one process-wide switch: ON means
 * every connector whose CURRENT mode is not simulated is refused — at start
 * (integration-manager.ts) and again at call time (tool-proxy.ts, defence in
 * depth).
 *
 * "Current mode" (`connectorCurrentlySimulated` below) is NOT the same
 * question as "does this manifest merely support a simulated mode"
 * (`manifestIsSimulated`). ERP (and CRM, from its next release) has a real
 * "live" mode — `mode=live` + `liveAdapter=local` answers from the company's
 * OWN invoicing/CRM data — so a connector that declares the capability can
 * still be set to live right now. Gating on the declared capability alone
 * let a live-mode connector keep running with real data while simulation
 * mode was on; gating on the CURRENT mode (read fresh from the same
 * credential/setting field the UI's `isSimulated` reads — see
 * apps/ui/src/lib/simulation.ts, same semantics on purpose) treats it exactly
 * like any other real system: refused while simulation mode is on, same as
 * gmail.
 *
 * Mandates and profiles are completely unaffected, and the Authority Server
 * never learns this exists — it is purely local to this gateway.
 *
 * Set via `SUVEREN_SIMULATION=1` — bundle/server.js sets it on every child it
 * spawns, reading it from the CLI's saved `<dataDir>/config.json` (see
 * bundle/lib/config.mjs's `resolveSimulation`), the same way `--as-url` /
 * `--ca-file` / `--pin-tls` reach a running gateway. A change saved via
 * `suveren-gateway simulation on|off` or `start --simulation` takes effect on
 * the NEXT start/restart — not read continuously, because the env is fixed
 * for the life of a process anyway; checking it live (rather than caching it
 * once) costs nothing and is far easier to exercise in tests.
 *
 * IT policy (see policy.ts) wins UNCONDITIONALLY over the env var — a
 * locked `Simulation` setting must be impossible to turn off locally, even
 * by hand-setting SUVEREN_SIMULATION in the environment this process
 * happens to inherit. readPolicy() is memoized, so checking it on every
 * call (this runs per tool call — the defence-in-depth check in
 * tool-proxy.ts) costs nothing on a real install that has no policy set.
 */
import type { IntegrationManifest } from './manifest-loader';
import { readPolicy } from './policy';

export function isSimulationMode(): boolean {
  const policySimulation = readPolicy().policy.simulation;
  if (policySimulation !== undefined) return policySimulation;
  return process.env.SUVEREN_SIMULATION === '1';
}

/** Does this manifest declare a simulated mode at all? (Not: which mode it is
 *  currently in — a real connector can still be SET to "simulation" by its own
 *  credential value; this only asks whether the connector CAN run simulated.)
 *  A capability check ONLY — never use this to decide whether a connector may
 *  run while gateway-wide simulation mode is on; see `connectorCurrentlySimulated`. */
export function manifestIsSimulated(
  manifest: Pick<IntegrationManifest, 'simulation'> | null | undefined,
): boolean {
  return Boolean(manifest?.simulation);
}

/**
 * Is this connector's CURRENT setting the simulated one — right now, not
 * merely "can it be"? Mirrors the UI's `isSimulated` (apps/ui/src/lib/
 * simulation.ts) field-for-field: `fields` are the connector's current
 * credential/setting values keyed by FIELD NAME (e.g. `{ mode: 'live' }`),
 * the same shape the vault returns to the UI and the same shape
 * IntegrationManager reconstructs from `serviceCredentials`. Unset falls back
 * to `simulation.default` (every shipped manifest defaults to "simulation"),
 * so a never-configured connector reads as safely simulated.
 *
 * This — NOT `manifestIsSimulated` — is the one decision gateway-wide
 * simulation mode enforcement must use: whether a connector MAY run while
 * simulation mode is on.
 */
export function connectorCurrentlySimulated(
  manifest: Pick<IntegrationManifest, 'simulation'> | null | undefined,
  fields: Record<string, string | undefined> | undefined,
): boolean {
  const decl = manifest?.simulation;
  if (!decl) return false;
  const value = (fields?.[decl.field] ?? '').trim().toLowerCase() || decl.default.trim().toLowerCase();
  return value === 'simulation';
}

/** Shown wherever a real connector is refused because of simulation mode —
 *  the integration status, and the tool-proxy call-time refusal. One string,
 *  so the UI, the CLI and the agent-facing refusal all say the same thing. */
export const SIMULATION_BLOCK_REASON = 'blocked: simulation mode — real systems are off';
