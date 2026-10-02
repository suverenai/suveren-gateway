/**
 * Simulation mode — read-only mirror of apps/mcp-server/src/lib/simulation-mode.ts
 * for the control plane, which only needs to REPORT the mode (on `/health`,
 * for the UI banner) — enforcement lives entirely in the MCP server (the only
 * process that spawns connectors and proxies tool calls). Duplicated rather
 * than shared because the two apps have no shared runtime package (only
 * `@hap/core` is shared) — see bundle/lib/config.mjs's doc comment for the
 * same pattern applied to as-config.ts.
 *
 * Set via `SUVEREN_SIMULATION=1`, written onto both children's env by
 * bundle/server.js from the CLI's saved `<dataDir>/config.json`.
 */
export function isSimulationMode(): boolean {
  return process.env.SUVEREN_SIMULATION === '1';
}
