/**
 * Whether a connector is answering from a simulated system rather than the
 * company's real one.
 *
 * Declared in the connector's manifest — `simulation: { field, default }` names
 * the credential field that holds the mode and the mode used when it is unset —
 * so any connector can opt in without UI code per connector. The mode is not a
 * secret; the vault already returns non-secret field values to the UI.
 *
 * Shown because the failure it prevents is silent: after go-live, a connector
 * left in simulation still "sends" quotes, every ticket looks fine, and nothing
 * reaches a customer.
 */
import type { IntegrationManifest } from './sp-client';

export function isSimulated(
  manifest: Pick<IntegrationManifest, 'simulation'>,
  fields?: Record<string, string | undefined>,
): boolean {
  const decl = manifest.simulation;
  if (!decl) return false;
  const value = (fields?.[decl.field] ?? '').trim().toLowerCase() || decl.default.trim().toLowerCase();
  return value === 'simulation';
}

/**
 * Does this manifest declare a simulated mode AT ALL (a capability), regardless
 * of which mode it's currently set to? Mirrors the gateway's own
 * `manifestIsSimulated` (apps/mcp-server/src/lib/simulation-mode.ts) — the UI
 * already has the manifest, so this reads the same `simulation` marker rather
 * than re-deriving the rule.
 *
 * Different question from `isSimulated` above: that one asks which mode ONE
 * connector is in right now (current credential value); this one asks whether
 * a connector is a "test system" at all. Used to group the Integrations page
 * and to word Dashboard attention rows while gateway-wide simulation mode is on.
 */
export function declaresSimulation(
  manifest: Pick<IntegrationManifest, 'simulation'> | null | undefined,
): boolean {
  return Boolean(manifest?.simulation);
}

/**
 * The display label for a connector's CURRENT mode (and, for a mode with
 * more than one real backend, its current adapter) — "<name> · <label>" on
 * the Integrations card, e.g. "ERP · Built-in" (mode=live, liveAdapter=local)
 * or "ERP · Test data" (mode=simulation). Returns undefined when the
 * manifest declares no `modeLabels`, or when the current mode/adapter
 * combination has no entry (an unlabelled mode shows no label — the
 * "Simulation" chip still covers the simulated case either way).
 *
 * Resolves the CURRENT mode the same way `isSimulated` does (same field,
 * same fallback to `simulation.default` when unset) — one rule for "what
 * mode is this connector in right now", shared by the badge and the label.
 */
export function modeLabel(
  manifest: Pick<IntegrationManifest, 'simulation' | 'modeLabels' | 'adapterField'>,
  fields?: Record<string, string | undefined>,
): string | undefined {
  return modeEntry(manifest, manifest.modeLabels, fields);
}

/** The note for the connector's current mode (`modeNotes`, same shape as
 *  `modeLabels`), e.g. "On this computer — no shared access". */
export function modeNote(
  manifest: Pick<IntegrationManifest, 'simulation' | 'modeNotes' | 'adapterField'>,
  fields?: Record<string, string | undefined>,
): string | undefined {
  return modeEntry(manifest, manifest.modeNotes, fields);
}

function modeEntry(
  manifest: Pick<IntegrationManifest, 'simulation' | 'adapterField'>,
  labels: IntegrationManifest['modeLabels'],
  fields?: Record<string, string | undefined>,
): string | undefined {
  const decl = manifest.simulation;
  if (!labels || !decl) return undefined;
  const mode = (fields?.[decl.field] ?? '').trim().toLowerCase() || decl.default.trim().toLowerCase();
  const entry = labels[mode];
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') return entry;
  const adapterField = manifest.adapterField;
  const adapter = adapterField ? (fields?.[adapterField] ?? '').trim().toLowerCase() : '';
  return adapter ? entry[adapter] : undefined;
}
