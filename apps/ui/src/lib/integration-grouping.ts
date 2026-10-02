/**
 * Integrations page layout — pulled out of IntegrationsPage.tsx so the
 * grouping rule can be unit-tested directly (JSX itself is verified in the
 * browser; see doc/engineering.md).
 */
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';
import { declaresSimulation } from './simulation';

export interface GroupedIntegrations {
  /** False when simulation mode is off — render `ungrouped` exactly as before. */
  grouped: boolean;
  /** Connectors that declare a `simulation` marker — full cards, "Test systems". */
  testSystems: IntegrationEntry[];
  /**
   * Real connectors with a GENUINE error (unrelated to the simulation block)
   * — full cards, never folded into the paused group. Simulation pausing a
   * system is not the same as that system being broken, and hiding a real
   * crash inside a collapsed "Paused" disclosure would bury it.
   */
  realErrors: IntegrationEntry[];
  /**
   * Every other real connector — paused by the simulation block, or simply
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
 * ON: split by what the manifest DECLARES (test vs. real), not by current
 * running state — a real connector that happens to be running fine before
 * simulation mode was turned on still belongs in "paused" conceptually once
 * the gateway restarts with the mode on and refuses to start it again.
 */
export function groupIntegrationsForDisplay(
  entries: IntegrationEntry[],
  simulationOn: boolean,
): GroupedIntegrations {
  if (!simulationOn) {
    return { grouped: false, testSystems: [], realErrors: [], pausedReal: [], ungrouped: entries };
  }

  const testSystems = entries.filter(e => declaresSimulation(e.manifest));
  const real = entries.filter(e => !declaresSimulation(e.manifest));
  const realErrors = real.filter(e => e.state === 'error');
  const pausedReal = real.filter(e => e.state !== 'error');

  return { grouped: true, testSystems, realErrors, pausedReal, ungrouped: [] };
}
