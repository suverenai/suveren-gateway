import { getIntegrations, setReadPolicy } from './mcp-bridge';

/**
 * Give already-installed integrations the read window their manifest declares.
 *
 * The default is applied at activation, but integrations installed BEFORE the
 * manifest declared one would sit at "no local setting" forever — the panel
 * would read "From your authorization" and the limit would still effectively
 * live in the grant, which is what this design moved away from.
 *
 * Only ever fills a GAP: an integration with any explicit value — including
 * `0`, "read nothing" — is left alone. This runs unattended at every startup,
 * so it must never widen or narrow a window the owner chose.
 *
 * Lives outside `index.ts` deliberately: importing that module starts the HTTP
 * server, which makes this logic untestable without binding a port.
 */
export async function backfillReadPolicyDefaults(
  data: { manifests?: Array<Record<string, unknown>> },
): Promise<void> {
  const defaults = new Map<string, number>();
  for (const m of data.manifests ?? []) {
    const days = (m.readPolicy as { defaultAgeDays?: unknown } | undefined)?.defaultAgeDays;
    if (typeof m.id === 'string' && typeof days === 'number' && Number.isInteger(days) && days >= 0) {
      defaults.set(m.id, days);
    }
  }
  if (defaults.size === 0) return;

  try {
    const current = (await getIntegrations()) as {
      integrations?: Array<{ id: string; readAgeDays?: number | null }>;
    };
    for (const integration of current.integrations ?? []) {
      const fallback = defaults.get(integration.id);
      if (fallback === undefined) continue;
      // `!= null` covers null and undefined, and — deliberately — leaves 0
      // untouched: "read nothing" is a real choice, not a gap.
      if (integration.readAgeDays != null) continue;
      await setReadPolicy(integration.id, fallback);
      console.error(`[Control Plane]   Read policy default applied: ${integration.id} → ${fallback}d`);
    }
  } catch (err) {
    // Never block startup on this — a missing default degrades to the signed
    // grant bound, which still enforces a window.
    console.error(`[Control Plane] ⚠ Could not apply read-policy defaults: ${err instanceof Error ? err.message : err}`);
  }
}
