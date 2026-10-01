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
