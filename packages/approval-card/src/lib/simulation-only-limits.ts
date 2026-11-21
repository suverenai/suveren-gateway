/**
 * Limits that only test-data tools use (Andreas, 2026-11-11): a Customers
 * mandate on a production gateway showed "Test-data loads per day — 0 of 0
 * used", a limit nothing outside simulation can ever use.
 *
 * Rule, driven by the manifests and the profile only (no profile, field or
 * tool name in code): outside simulation, a limit is hidden when every action
 * type it applies to (`appliesTo`) is served ONLY by tools the manifests mark
 * `simulationOnly` — in every manifest that maps tools to that profile. In
 * simulation, or while the mode is not known yet, everything shows.
 *
 * Hiding is display only: the value stays in the mandate and is signed.
 */
import type { AgentProfile } from '@hap/core';

interface ToolGatingLike {
  profile?: string;
  simulationOnly?: boolean;
  staticExecution?: Record<string, unknown>;
  executionMapping?: Record<string, unknown>;
}

export interface ManifestGatingLike {
  profile?: string;
  toolGating?: {
    default?: ToolGatingLike | null;
    overrides?: Record<string, ToolGatingLike | null> | null;
  } | null;
}

const shortId = (id: string) => id.replace(/@.*$/, '').split('/').pop() ?? id;

/**
 * The action types of this profile that only simulation-only tools serve.
 * Empty when any tool of the profile sets its action type from its arguments
 * (it could serve any type, so nothing is provably simulation-only).
 */
export function simulationOnlyActionTypes(
  manifests: ReadonlyArray<ManifestGatingLike> | undefined,
  profileId: string,
): Set<string> {
  const target = shortId(profileId);
  const onlySimulation = new Map<string, boolean>();
  for (const m of manifests ?? []) {
    const tg = m.toolGating;
    if (!tg) continue;
    const tools: ToolGatingLike[] = [];
    // The default covers the tools the manifest does not list; it maps to the manifest's own profile.
    if (tg.default) tools.push({ ...tg.default, profile: m.profile, simulationOnly: false });
    for (const o of Object.values(tg.overrides ?? {})) {
      if (o) tools.push({ ...o, profile: o.profile ?? m.profile, staticExecution: { ...(tg.default?.staticExecution ?? {}), ...(o.staticExecution ?? {}) } });
    }
    for (const t of tools) {
      if (!t.profile || shortId(t.profile) !== target) continue;
      if (t.executionMapping && 'action_type' in t.executionMapping) return new Set();
      const at = t.staticExecution?.action_type;
      if (typeof at !== 'string') continue;
      onlySimulation.set(at, (onlySimulation.get(at) ?? true) && t.simulationOnly === true);
    }
  }
  return new Set([...onlySimulation].filter(([, only]) => only).map(([at]) => at));
}

/** The bound keys not to display, given whether the gateway is in simulation (null = not known yet). */
export function hiddenLimitKeys(
  profile: AgentProfile | null | undefined,
  manifests: ReadonlyArray<ManifestGatingLike> | undefined,
  simulation: boolean | null,
): Set<string> {
  if (simulation !== false || !profile) return new Set();
  const types = simulationOnlyActionTypes(manifests, profile.id);
  if (types.size === 0) return new Set();
  const fields = (profile.boundsSchema?.fields ?? {}) as Record<string, { appliesTo?: readonly string[] }>;
  return new Set(Object.entries(fields)
    .filter(([, f]) => Array.isArray(f.appliesTo) && f.appliesTo.length > 0 && f.appliesTo.every((a) => types.has(a)))
    .map(([k]) => k));
}
