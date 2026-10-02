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
 * every connector WITHOUT a manifest `simulation` marker is refused — at
 * start (integration-manager.ts) and again at call time (tool-proxy.ts,
 * defence in depth) — and every connector WITH one has its mode env var
 * FORCED to "simulation", overriding whatever credential value is on file.
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
 */
import type { IntegrationManifest } from './manifest-loader';

export function isSimulationMode(): boolean {
  return process.env.SUVEREN_SIMULATION === '1';
}

/** Does this manifest declare a simulated mode at all? (Not: which mode it is
 *  currently in — a real connector can still be SET to "simulation" by its own
 *  credential value; this only asks whether the connector CAN run simulated.) */
export function manifestIsSimulated(
  manifest: Pick<IntegrationManifest, 'simulation'> | null | undefined,
): boolean {
  return Boolean(manifest?.simulation);
}

/** Shown wherever a real connector is refused because of simulation mode —
 *  the integration status, and the tool-proxy call-time refusal. One string,
 *  so the UI, the CLI and the agent-facing refusal all say the same thing. */
export const SIMULATION_BLOCK_REASON = 'blocked: simulation mode — real systems are off';
