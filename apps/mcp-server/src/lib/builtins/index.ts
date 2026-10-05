/**
 * The gateway's built-in tool groups (see ../builtin-integration.ts). Each group is
 * one entry in BUILTIN_FACTORIES: a function that receives what its handlers need
 * and returns the group's definition — profile, toolGating, tools. Nothing else has
 * to change to add one: listing, gating, review and execution are shared with the
 * connectors.
 *
 * Registered once at start, after profiles and manifests are loaded (an id that a
 * manifest already uses is refused). A group that fails to register is logged and
 * left out; the gateway still starts — its tools simply do not exist.
 */
import type { IntegrationManager } from '../integration-manager';
import type { SharedState } from '../shared-state';
import type { BuiltinIntegration } from '../builtin-integration';
import type { ReportSources } from '../report';
import { reportBuiltin } from './report';

/** What a built-in's handlers may use. Extend when a group needs more. */
export interface BuiltinDeps {
  state: SharedState;
  integrationManager: IntegrationManager;
  /** What the `report` built-in (./report.ts) reads evidence from — the SAME
   *  instance http.ts hands to ReportStore/the /internal/report routes, so a
   *  tool-driven read and a manual save/recheck see identical data. */
  reportSources: ReportSources;
}

export type BuiltinFactory = (deps: BuiltinDeps) => BuiltinIntegration;

/** Add a group here. */
export const BUILTIN_FACTORIES: BuiltinFactory[] = [reportBuiltin];

export function registerBuiltins(deps: BuiltinDeps, factories: BuiltinFactory[] = BUILTIN_FACTORIES): string[] {
  const registered: string[] = [];
  for (const factory of factories) {
    try {
      const def = factory(deps);
      deps.integrationManager.registerBuiltin(def);
      registered.push(def.id);
    } catch (err) {
      console.error(`[Suveren MCP] Built-in tool group not registered: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return registered;
}
