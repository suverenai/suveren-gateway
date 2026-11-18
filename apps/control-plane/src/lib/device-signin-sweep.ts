/**
 * The background work after the first device sign-in of an unlock. It is the
 * second half of routes/auth.ts's background block, without the reading-key
 * registration (see lib/device-session-establish.ts): connectors that were
 * replaced move to their replacement, every stored credential goes to the MCP
 * server, pending connectors start, gates are re-synced.
 *
 * It is a copy, not a shared function, so the account-key login keeps its code
 * line for line. Step 18 removes that login; this is then the only one.
 */

import { credentialsToPush } from './sign-in-group';
import { runReplacements } from './connector-replacement';
import type { Vault } from './vault';

export interface SweepBridge {
  getManifests: () => Promise<unknown>;
  replaceIntegration: Parameters<typeof runReplacements>[1]['replaceIntegration'];
  pushServiceCredentials: (id: string, creds: Record<string, string>) => Promise<void>;
  startPendingIntegrations: () => Promise<{ running: string[] }>;
  resyncGates: () => Promise<{ synced: number }>;
}

export function createSignInSweep(vault: Vault, bridge: SweepBridge, log: (m: string) => void = m => console.error(m)): () => Promise<void> {
  return async () => {
    let manifestList: unknown = [];
    try {
      manifestList = (await bridge.getManifests() as { manifests?: unknown }).manifests ?? [];
    } catch (err) {
      log(`[Control Plane] Could not read manifests for sign-in groups: ${err instanceof Error ? err.message : 'error'}`);
    }
    try {
      await runReplacements(manifestList, {
        getCredential: n => vault.getCredential(n),
        setCredential: (n, f) => vault.setCredential(n, f),
        deleteCredential: n => vault.deleteCredential(n),
        replaceIntegration: bridge.replaceIntegration,
        log: m => log(`[Control Plane] Connector replacement ${m}`),
      });
    } catch (err) {
      log(`[Control Plane] Connector replacement failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    // `listCredentials` never includes the device keys: they are secret slots, not credentials.
    for (const credId of vault.listCredentials()) {
      try {
        for (const [id, creds] of credentialsToPush(credId, manifestList, n => vault.getCredential(n))) {
          await bridge.pushServiceCredentials(id, creds);
          log(`[Control Plane] Pushed ${id} credentials to MCP`);
        }
      } catch (err) {
        log(`[Control Plane] Failed to push ${credId} credentials: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    try {
      const { running } = await bridge.startPendingIntegrations();
      log(`[Control Plane] Post-unlock sweep — running: ${running.join(', ') || '(none)'}`);
    } catch (err) {
      log(`[Control Plane] Post-unlock sweep failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    try {
      const { synced } = await bridge.resyncGates();
      if (synced > 0) log(`[Control Plane] Re-synced ${synced} gate(s) with SP`);
    } catch (err) {
      log(`[Control Plane] Failed to re-sync gates: ${err instanceof Error ? err.message : 'error'}`);
    }
  };
}
