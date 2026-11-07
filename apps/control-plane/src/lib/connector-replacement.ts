/**
 * A connector that is no longer offered, taken over by another one (control-plane side).
 *
 * The new connector's manifest says `replaces: [{ id, set? }]`. On the next
 * sign-in (the vault is open) an install that still holds the old connector is
 * moved over: its credentials go to the new connector's vault entry (only keys
 * the new connector knows), `set` is applied on top (e.g. the data-source
 * choice the old connector stood for), the registry swap happens in the MCP
 * server, and only then is the old vault entry deleted. Nothing is named here:
 * the ids and values all come from the manifest.
 *
 * Order, so a failure never loses the old setup:
 *   1. copy credentials (old entry untouched)
 *   2. swap the registry entry in the MCP server
 *   3. delete the old credentials - only when 1 and 2 succeeded and the copy reads back equal
 * A failed run is repeated at the next sign-in; the old entry is still there.
 */

export interface ReplacerManifest {
  id: string;
  replaces?: Array<{ id: string; set?: Record<string, string> }>;
  credentials?: { fields?: Array<{ key: string }>; envMapping?: Record<string, string> };
  oauth?: { credentialKeys?: Record<string, string>; tokenStorage?: string } | null;
}

export interface ReplacementDeps {
  getCredential(name: string): Record<string, string> | null;
  setCredential(name: string, fields: Record<string, string>): void;
  deleteCredential(name: string): void;
  /** Swap the registry entry in the MCP server. Resolves with what it did; rejects when it could not. */
  replaceIntegration(from: string, to: string, opts: { enableTarget: boolean }): Promise<{ removedOld: boolean; targetAction: string }>;
  log(message: string): void;
}

/** The credential keys the new connector understands; everything else of the old entry is dropped. */
export function adoptableKeys(m: ReplacerManifest): (key: string) => boolean {
  const known = new Set<string>([
    ...(m.credentials?.fields ?? []).map(f => f.key),
    ...Object.values(m.credentials?.envMapping ?? {}),
    ...Object.values(m.oauth?.credentialKeys ?? {}),
    ...(m.oauth?.tokenStorage ? [m.oauth.tokenStorage] : []),
  ]);
  return key => known.has(key) || (!!m.oauth && key.startsWith('_oauth'));
}

/** The target's credentials after taking over `old`: its own, then the old ones it knows, then `set`. */
export function mergeReplacedCredentials(
  m: ReplacerManifest,
  old: Record<string, string>,
  existing: Record<string, string> | null,
  set: Record<string, string> | undefined,
): Record<string, string> {
  const adopt = adoptableKeys(m);
  const taken = Object.fromEntries(Object.entries(old).filter(([k]) => adopt(k)));
  return { ...(existing ?? {}), ...taken, ...(set ?? {}) };
}

export interface ReplacementResult { from: string; to: string; status: 'migrated' | 'registry-only' | 'nothing-to-do' | 'failed'; detail?: string }

export async function runReplacements(manifests: unknown, deps: ReplacementDeps): Promise<ReplacementResult[]> {
  const list = (Array.isArray(manifests) ? manifests : []) as ReplacerManifest[];
  const offered = new Set(list.map(m => m.id));
  const results: ReplacementResult[] = [];
  for (const m of list) {
    for (const r of m.replaces ?? []) {
      if (offered.has(r.id)) continue; // still offered as its own connector: nothing is replaced
      const old = deps.getCredential(r.id);
      const hasOld = !!old && Object.keys(old).length > 0;
      try {
        if (hasOld) {
          const merged = mergeReplacedCredentials(m, old!, deps.getCredential(m.id), r.set);
          deps.setCredential(m.id, merged);
        }
        const out = await deps.replaceIntegration(r.id, m.id, { enableTarget: hasOld });
        if (hasOld) {
          // Delete the old entry only once the copy reads back equal on every key it took.
          const back = deps.getCredential(m.id) ?? {};
          const adopt = adoptableKeys(m);
          const same = Object.entries(old!).filter(([k]) => adopt(k) && !(r.set && k in r.set)).every(([k, v]) => back[k] === v);
          if (!same) throw new Error('the copied credentials did not read back equal - old entry kept');
          deps.deleteCredential(r.id);
        }
        const status = hasOld ? 'migrated' : out.removedOld ? 'registry-only' : 'nothing-to-do';
        if (status !== 'nothing-to-do') deps.log(`${r.id} -> ${m.id}: ${status}`);
        results.push({ from: r.id, to: m.id, status });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log(`${r.id} -> ${m.id}: FAILED (${detail}); the old setup is untouched and is tried again at the next sign-in`);
        results.push({ from: r.id, to: m.id, status: 'failed', detail });
      }
    }
  }
  return results;
}
