/**
 * MCP Bridge — internal communication from control-plane to MCP server.
 *
 * All calls go to http://127.0.0.1:3431/internal/* (local dev) or :3030 (Docker).
 * The dev script overrides via SUVEREN_MCP_INTERNAL_URL since dev MCP runs
 * on 3431 (npm CLI keeps 3430 to stay parallel-runnable).
 * Each request includes an X-Internal-Secret header for authentication.
 */

export const MCP_BASE = process.env.SUVEREN_MCP_INTERNAL_URL ?? 'http://127.0.0.1:3430';

let internalSecret = '';

export function setInternalSecret(secret: string): void {
  internalSecret = secret;
}

function internalHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Secret': internalSecret,
  };
}

export async function configure(sessionCookie: string, vaultKeyHex?: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${MCP_BASE}/internal/configure`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ sessionCookie, vaultKeyHex }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`MCP configure failed: ${(err as { error: string }).error}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function pushGateContent(data: {
  frameHash?: string;
  boundsHash?: string;
  contextHash?: string;
  context?: Record<string, string | number>;
  path?: string;
  gateContent: Record<string, string>;
}): Promise<void> {
  const res = await fetch(`${MCP_BASE}/internal/gate-content`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`MCP pushGateContent failed: ${(err as { error: string }).error}`);
  }
}

export async function pushServiceCredentials(
  serviceId: string,
  credentials: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${MCP_BASE}/internal/service-credentials`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ serviceId, credentials }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`MCP pushServiceCredentials failed: ${(err as { error: string }).error}`);
  }
}

/**
 * Trigger the MCP to sweep its registry and start every enabled integration
 * whose credentials are now resolvable. Intended to be called by the CP
 * AFTER all vault credentials have been pushed on login/unlock, as a
 * belt-and-suspenders pass that catches envKey/credId naming mismatches
 * the per-credential `pushServiceCredentials → startIntegrationForService`
 * path would miss.
 */
export async function startPendingIntegrations(): Promise<{ running: string[] }> {
  const res = await fetch(`${MCP_BASE}/internal/start-pending-integrations`, {
    method: 'POST',
    headers: internalHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`MCP startPendingIntegrations failed: ${(err as { error: string }).error}`);
  }
  return res.json() as Promise<{ running: string[] }>;
}

export async function resyncGates(): Promise<{ synced: number }> {
  const res = await fetch(`${MCP_BASE}/internal/resync-gates`, {
    method: 'POST',
    headers: internalHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`MCP resyncGates failed: ${(err as { error: string }).error}`);
  }
  return res.json() as Promise<{ synced: number }>;
}

/**
 * Nudge the MCP server to execute any just-committed proposals immediately,
 * so a human approval turns into a send without waiting for the poll loop.
 * Fire-and-forget: the poll remains the fallback, so failures are non-fatal.
 */
export async function runCommittedProposals(): Promise<void> {
  await fetch(`${MCP_BASE}/internal/run-committed`, {
    method: 'POST',
    headers: internalHeaders(),
  });
}

// ─── Integration management ──────────────────────────────────────────────

export async function getIntegrations(): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/internal/integrations`, {
    headers: internalHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch integrations');
  return res.json();
}

export async function addIntegration(config: unknown): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/internal/add-integration`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error((err as { error: string }).error);
  }
  return res.json();
}

/**
 * Activate an integration from its manifest — constructs IntegrationConfig
 * from manifest fields and sends it to the MCP server.
 */
export async function activateIntegration(manifest: {
  id: string;
  name: string;
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  credentials: {
    fields: Array<{ key: string; optional?: boolean }>;
    envMapping: Record<string, string>;
  };
  profile: string;
  toolGating?: unknown;
  npmPackage?: string;
}): Promise<unknown> {
  // Construct envKeys by prepending integration ID to each credential key.
  // Skip optional credential fields — the downstream server handles defaults.
  const optionalKeys = new Set(
    manifest.credentials.fields.filter(f => f.optional).map(f => f.key),
  );
  const envKeys: Record<string, string> = {};
  const optionalEnvKeys: Record<string, string> = {};
  for (const [envVar, credKey] of Object.entries(manifest.credentials.envMapping)) {
    if (optionalKeys.has(credKey)) {
      optionalEnvKeys[envVar] = `${manifest.id}.${credKey}`;
    } else {
      envKeys[envVar] = `${manifest.id}.${credKey}`;
    }
  }

  return addIntegration({
    id: manifest.id,
    name: manifest.name,
    command: manifest.mcp.command,
    args: manifest.mcp.args,
    env: manifest.mcp.env,
    envKeys,
    ...(Object.keys(optionalEnvKeys).length > 0 ? { optionalEnvKeys } : {}),
    profile: manifest.profile,
    toolGating: manifest.toolGating,
    npmPackage: manifest.npmPackage,
    enabled: true,
  });
}

/**
 * Stop AND PERMANENTLY REMOVE every running integration from the registry.
 *
 * Use only when the registry's contents are no longer valid — the
 * archetypal case is switching to a different user's API key on the
 * same machine. Do NOT use this for logout: logout should leave the
 * registry intact so the same user's next session resumes their setup
 * (and so attestation-bounded agent work running in the background
 * isn't disrupted).
 */
export async function stopAndRemoveAllIntegrations(): Promise<void> {
  const data = await getIntegrations() as { integrations?: Array<{ id: string; running: boolean }> };
  if (!data?.integrations) return;
  for (const integration of data.integrations) {
    if (integration.running) {
      try {
        await removeIntegration(integration.id);
        console.error(`[MCP Bridge] Removed integration: ${integration.id}`);
      } catch (err) {
        console.error(`[MCP Bridge] Failed to remove ${integration.id}:`, err);
      }
    }
  }
}

/**
 * Stop every running integration without removing them from the
 * registry. Future "Pause all" UI control. Not currently called by
 * logout — logout deliberately leaves integrations untouched so
 * agents acting under existing attestations continue working while
 * the human is away from the UI.
 */
export async function stopAllRunning(): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/internal/stop-all-running`, {
    method: 'POST',
    headers: internalHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error((err as { error: string }).error);
  }
  return res.json();
}

export async function getManifests(): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/internal/manifests`, {
    headers: internalHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch manifests');
  return res.json();
}

export async function removeIntegration(id: string): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/internal/remove-integration/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: internalHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error((err as { error: string }).error);
  }
  return res.json();
}

export async function getGateContent(path?: string): Promise<unknown> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fetch(`${MCP_BASE}/internal/gate-content${qs}`, {
    headers: internalHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch gate content');
  return res.json();
}

export async function getEnrichedAuthorizations(): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/internal/authorizations`, {
    headers: internalHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch authorizations');
  return res.json();
}

export async function getMcpHealth(): Promise<unknown> {
  const res = await fetch(`${MCP_BASE}/health`);
  if (!res.ok) throw new Error('MCP server unreachable');
  return res.json();
}

/**
 * Fetch the live mandate brief — exactly what the next MCP session will
 * receive as `instructions`. Used by the Agent Brief UI for the preview pane.
 */
export async function getBrief(): Promise<{ brief: string }> {
  const res = await fetch(`${MCP_BASE}/internal/brief`, {
    headers: internalHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`MCP getBrief failed: ${(err as { error: string }).error}`);
  }
  return res.json() as Promise<{ brief: string }>;
}
