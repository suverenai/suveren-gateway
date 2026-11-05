/**
 * Integrations page layout — pulled out of IntegrationsPage.tsx so the
 * grouping rule can be unit-tested directly (JSX itself is verified in the
 * browser; see doc/engineering.md).
 */
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';
import { declaresSimulation } from './simulation';
import { blockedBySimulation } from './integration-attention';
import { resolveAreaName, areaIcon, type AreaIconName, type AreaCatalogEntry } from './area';

/**
 * Every area a connector's tools serve: the manifest's own `profile`, plus
 * any per-tool override's own `profile` (area per tool — a connector may
 * span several areas, e.g. an ERP's sales AND invoicing tools). A manifest
 * with no per-tool override profiles returns just its own `profile`,
 * unchanged from before this existed. Exported for any display that names
 * a connector's area(s) outside the grouped list itself (e.g.
 * IntegrationCard's "Profile" detail line).
 */
export function areasOf(manifest: IntegrationEntry['manifest']): string[] {
  const out = [manifest.profile];
  for (const entry of Object.values(manifest.toolGating?.overrides ?? {})) {
    const p = entry?.profile;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export interface ConnectorArea {
  shortId: string;
  icon: AreaIconName;
  name: string;
}

/**
 * The areas ONE connector serves, as chips for its single card: every area from its manifest
 * (`areasOf`), named from the profile catalog, alphabetical by name (a lookup, not a ranking). One connector is one card — it is never repeated per area.
 */
export function connectorAreas(
  manifest: IntegrationEntry['manifest'],
  catalog: readonly AreaCatalogEntry[],
): ConnectorArea[] {
  return areasOf(manifest)
    .map(shortId => ({ shortId, icon: areaIcon(shortId), name: resolveAreaName(shortId, catalog) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Connectors in a stable, alphabetical order (a lookup list, not a most-used ranking). */
export function sortConnectors(entries: IntegrationEntry[]): IntegrationEntry[] {
  return [...entries].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export interface GroupedIntegrations {
  /** False when simulation mode is off — render `ungrouped` exactly as before. */
  grouped: boolean;
  /**
   * Connectors that are CURRENTLY simulated — declare a `simulation` marker
   * AND are not blocked by it (unconfigured/default, or explicitly set to
   * the simulated mode). Full cards, "Test systems". A connector that
   * declares the marker but is currently SET to a real mode (ERP's
   * mode=live) does NOT belong here — see `realErrors`/`pausedReal` below.
   */
  testSystems: IntegrationEntry[];
  /**
   * Real connectors (no simulation capability at all, OR currently set to a
   * real mode) with a GENUINE error (unrelated to the simulation block) —
   * full cards, never folded into the paused group. Simulation pausing a
   * system is not the same as that system being broken, and hiding a real
   * crash inside a collapsed "Paused" disclosure would bury it.
   */
  realErrors: IntegrationEntry[];
  /**
   * Every other real connector — paused by the simulation block (no
   * simulation capability, or currently set to a real mode), or simply
   * never configured (which, while simulation mode is on, amounts to the
   * same thing: it cannot run either way). Rendered as compact rows under
   * "Paused while simulation mode is on".
   */
  pausedReal: IntegrationEntry[];
  /** Simulation mode off: the flat list, unchanged. */
  ungrouped: IntegrationEntry[];
}

/**
 * How the Integrations page lays out its entries.
 *
 * OFF: today's flat list — nothing changes.
 * ON: split by whether the connector is CURRENTLY simulated, not merely by
 * what the manifest declares — a connector that declares a simulated mode
 * but is currently SET to a real one (ERP's mode=live) is a real system, not
 * a test system, and belongs with the real ones (`blockedBySimulation`, the
 * same current-mode check the gateway's own start/call-time gates use).
 */
export function groupIntegrationsForDisplay(
  entries: IntegrationEntry[],
  simulationOn: boolean,
): GroupedIntegrations {
  if (!simulationOn) {
    return { grouped: false, testSystems: [], realErrors: [], pausedReal: [], ungrouped: entries };
  }

  const testSystems = entries.filter(e => declaresSimulation(e.manifest) && !blockedBySimulation(e, simulationOn));
  const real = entries.filter(e => !declaresSimulation(e.manifest) || blockedBySimulation(e, simulationOn));
  const realErrors = real.filter(e => e.state === 'error');
  const pausedReal = real.filter(e => e.state !== 'error');

  return { grouped: true, testSystems, realErrors, pausedReal, ungrouped: [] };
}

export interface UseSplit {
  inUse: IntegrationEntry[];
  notSetUp: IntegrationEntry[];
  /** Stopped by the gateway on purpose (set to simulation while simulation mode is off, or the reverse) —
   *  not broken and not waiting for the person's setup, so neither of the other two groups. */
  paused: IntegrationEntry[];
}

/**
 * The two groups of the Integrations page (UI spec §20.3): "In use" = a
 * connector that is running with the authentication it needs; everything else
 * (never set up, waiting for its account, stopped, crashed, starting) is
 * "Not set up". A running OAuth connector whose account is not connected is
 * not in use — it cannot do anything yet. (A running connector whose token was
 * revoked stays "In use": its card opens to the problem.)
 */
export function splitByUse(entries: IntegrationEntry[]): UseSplit {
  const inUse: IntegrationEntry[] = [];
  const notSetUp: IntegrationEntry[] = [];
  const paused: IntegrationEntry[] = [];
  for (const e of entries) {
    if (e.state === 'paused') { paused.push(e); continue; }
    const waitingForAuth = e.authStatus === 'not_configured' || e.authStatus === 'not_connected';
    (e.state === 'running' && !waitingForAuth ? inUse : notSetUp).push(e);
  }
  return { inUse, notSetUp, paused };
}
