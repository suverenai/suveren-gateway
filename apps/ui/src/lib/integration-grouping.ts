/**
 * Integrations page layout — pulled out of IntegrationsPage.tsx so the
 * grouping rule can be unit-tested directly (JSX itself is verified in the
 * browser; see doc/engineering.md).
 */
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';
import { declaresSimulation } from './simulation';
import { blockedBySimulation } from './integration-attention';
import { resolveAreaName, areaIcon, type AreaIconName, type AreaCatalogEntry } from './area';

export interface AreaGroupedEntries {
  /** The area's short id (§13.3) — the manifest's own `profile`, or an
   *  override's own `profile` (area per tool). */
  shortId: string;
  icon: AreaIconName;
  name: string;
  entries: IntegrationEntry[];
}

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

/**
 * Connectors grouped under their area heading (UI spec §13.3 — "a tool
 * serving several areas appears under each"). A connector serving several
 * areas (an override naming its own `profile`) appears under every one of
 * them, carrying its FULL entry each time — the Integrations page lists the
 * connector, not a filtered view of its tools. Alphabetical — this is a
 * lookup list, not a most-used ranking.
 */
export function groupEntriesByArea(
  entries: IntegrationEntry[],
  catalog: readonly AreaCatalogEntry[],
): AreaGroupedEntries[] {
  const groups = new Map<string, AreaGroupedEntries>();
  for (const e of entries) {
    for (const shortId of areasOf(e.manifest)) {
      let g = groups.get(shortId);
      if (!g) {
        g = { shortId, icon: areaIcon(shortId), name: resolveAreaName(shortId, catalog), entries: [] };
        groups.set(shortId, g);
      }
      g.entries.push(e);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  for (const e of entries) {
    const waitingForAuth = e.authStatus === 'not_configured' || e.authStatus === 'not_connected';
    (e.state === 'running' && !waitingForAuth ? inUse : notSetUp).push(e);
  }
  return { inUse, notSetUp };
}
