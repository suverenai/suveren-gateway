#!/usr/bin/env node

/**
 * Suveren MCP Server — HTTP entry point (supports both SSE and Streamable HTTP).
 *
 * Container mode: listens on 0.0.0.0:3030, accepts internal requests only
 * from the control-plane via loopback.
 *
 * Environment variables:
 * - SUVEREN_AS_URL — AS server URL (default: https://www.suveren.ai)
 * - SUVEREN_AS_API_KEY — AS API key for receipt requests (optional)
 * - SUVEREN_MCP_PORT — HTTP port (default: 3030)
 */

import { randomUUID } from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SharedState } from '../src/lib/shared-state';
import { createMcpServer } from '../src/index';
import { verifyGateContentHashes } from '../src/lib/gate-content';
import type { GateContent } from '../src/lib/gate-store';
import { IntegrationRegistry, type IntegrationConfig } from '../src/lib/integration-registry';
import { IntegrationManager } from '../src/lib/integration-manager';
import { loadProfiles } from '../src/lib/profile-loader';
import { loadManifests, getAllManifests, getManifest } from '../src/lib/manifest-loader';
import { buildMandateBrief } from '../src/lib/mandate-brief';
import { executeCommitted } from '../src/tools/commitments';

const spUrl = process.env.SUVEREN_AS_URL ?? 'https://www.suveren.ai';
const port = parseInt(process.env.SUVEREN_MCP_PORT ?? '3430', 10);

// ─── Shared state (one instance for all connections) ───────────────────────

const state = new SharedState(spUrl);

const spApiKey = process.env.SUVEREN_AS_API_KEY ?? '';
if (spApiKey) {
  state.spClient.setApiKey(spApiKey);
}

// ─── Service credentials held in memory for connector use ──────────────────

const serviceCredentials = new Map<string, Record<string, string>>();

// ─── Integration registry + manager ────────────────────────────────────────

const integrationRegistry = new IntegrationRegistry();
const integrationManager = new IntegrationManager(serviceCredentials);

// ─── Track active MCP sessions for refresh propagation ─────────────────────

interface ActiveSession {
  refreshTools: () => void;
  registerProxiedTools: () => void;
}

const activeSessions = new Map<string, ActiveSession>();

/** Refresh tools on all active MCP sessions */
function refreshAllSessions() {
  for (const [sessionId, session] of activeSessions) {
    try {
      session.registerProxiedTools();
      session.refreshTools();
    } catch (err) {
      console.error(`[Suveren MCP] Failed to refresh session ${sessionId}:`, err);
    }
  }
}

// When tools change (integration start/stop/crash), refresh all sessions
integrationManager.setOnToolsChanged(() => {
  refreshAllSessions();
});

const app = express();
app.use(express.json());

// ─── CORS for control-plane UI ────────────────────────────────────────────

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// ─── Internal-only middleware (loopback + shared secret) ──────────────────

const INTERNAL_SECRET = process.env.SUVEREN_INTERNAL_SECRET ?? '';

function internalOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) {
    res.status(403).json({ error: 'Internal endpoint — loopback only' });
    return;
  }
  // Validate shared secret (if configured)
  const secret = req.headers['x-internal-secret'] as string | undefined;
  if (INTERNAL_SECRET && secret !== INTERNAL_SECRET) {
    res.status(403).json({ error: 'Invalid internal secret' });
    return;
  }
  next();
}

// ─── Internal endpoints (control-plane → MCP) ─────────────────────────────

app.post('/internal/configure', internalOnly, (req: Request, res: Response) => {
  const { sessionCookie, vaultKeyHex, apiKey } = req.body as {
    sessionCookie?: string;
    vaultKeyHex?: string;
    apiKey?: string;
  };
  if (!sessionCookie) {
    res.status(400).json({ error: 'Missing sessionCookie' });
    return;
  }
  state.spClient.setSessionCookie(sessionCookie);
  console.error('[Suveren MCP] Session cookie configured by control-plane');

  if (vaultKeyHex) {
    state.gateStore.setVaultKey(Buffer.from(vaultKeyHex, 'hex'));
    console.error('[Suveren MCP] Vault key configured — gate store encryption active');
  }

  if (apiKey) {
    state.spClient.setApiKey(apiKey);
    console.error('[Suveren MCP] SP API key configured by control-plane');
  }

  res.json({ ok: true });
});

app.post('/internal/gate-content', internalOnly, async (req: Request, res: Response) => {
  try {
    const { frameHash, boundsHash, contextHash, context, path: rawPath, gateContent } = req.body as {
      frameHash?: string;
      boundsHash?: string;      // v0.4
      contextHash?: string;     // v0.4
      context?: Record<string, string | number>;  // v0.4
      path?: string;            // optional in v0.4 (execution paths removed)
      gateContent: GateContent;
    };

    // frameHash is the SP storage key (per-user scoped in v0.4 post-b228e58).
    // boundsHash is the content fingerprint and may collide across users in
    // the same team. Use frameHash for SP lookups; fall back to boundsHash
    // only for v0.3 compatibility where they're the same value.
    const storageHash = frameHash ?? boundsHash;

    // v0.4: intent field. v0.3 compat: problem/objective/tradeoffs.
    const hasIntent = !!gateContent?.intent;
    const hasLegacy = !!gateContent?.problem && !!gateContent?.objective && !!gateContent?.tradeoffs;
    if (!storageHash || (!hasIntent && !hasLegacy)) {
      res.status(400).json({ error: 'Missing required fields: frameHash (or boundsHash), gateContent.{intent} or gateContent.{problem,objective,tradeoffs}' });
      return;
    }

    // Sync attestation from SP so we can verify hashes
    const auth = await state.cache.syncAuthorization(storageHash);
    if (!auth) {
      res.status(404).json({ error: `No attestation found for frame hash ${storageHash}` });
      return;
    }

    // Verify gate content hashes match attestation
    const verification = verifyGateContentHashes(gateContent, auth);
    if (!verification.valid) {
      res.status(400).json({ error: 'Gate content hash mismatch', details: verification.errors });
      return;
    }

    // Use provided path, or fall back to profile ID (v0.4: execution paths removed)
    const path = rawPath || auth.profileId;

    // Store gate content (encrypted if vault key is set), passing v0.4 fields through
    state.setGateContent(path, storageHash, auth.profileId, gateContent, {
      boundsHash, contextHash, context,
    });
    console.error(`[Suveren MCP] Gate content accepted for ${path}`);

    // Refresh tools on all active MCP sessions
    for (const [sessionId, session] of activeSessions) {
      try {
        session.refreshTools();
      } catch (err) {
        console.error(`[Suveren MCP] Failed to refresh session ${sessionId}:`, err);
      }
    }

    res.json({ ok: true, path });
  } catch (err) {
    console.error('[Suveren MCP] Error handling /internal/gate-content:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/internal/service-credentials', internalOnly, (req: Request, res: Response) => {
  const { serviceId, credentials } = req.body as {
    serviceId?: string;
    credentials?: Record<string, string>;
  };
  if (!serviceId || !credentials) {
    res.status(400).json({ error: 'Missing serviceId or credentials' });
    return;
  }
  serviceCredentials.set(serviceId, credentials);
  console.error(`[Suveren MCP] Service credentials stored for ${serviceId}`);

  // Late-start: only the integration whose credentials just arrived, not
  // every enabled integration. Bulk-starting unrelated integrations surprises
  // users who only clicked Start on one. Boot-time restart still covers the
  // "resume previously running" case.
  void startIntegrationForService(serviceId);

  res.json({ ok: true });
});

/**
 * Belt-and-suspenders retry: call after the control-plane has pushed
 * all vault credentials on unlock/login. Covers the edge case where an
 * integration's envKeys reference a service id that doesn't match the
 * credId the CP pushed — so the per-credential startIntegrationForService
 * didn't catch it. Safe to call anytime; already-running integrations
 * are skipped.
 */
app.post('/internal/start-pending-integrations', internalOnly, async (_req: Request, res: Response) => {
  try {
    await startPendingIntegrations();
    const running = integrationManager.getStatus().filter(s => s.running).map(s => s.id);
    res.json({ ok: true, running });
  } catch (err) {
    console.error('[Suveren MCP] start-pending-integrations failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/internal/resync-gates', internalOnly, async (_req: Request, res: Response) => {
  const gates = state.gateStore.getAll();
  if (gates.length === 0) {
    res.json({ ok: true, synced: 0 });
    return;
  }

  let synced = 0;
  let orphaned = 0;
  for (const gate of gates) {
    try {
      // SP storage key is per-user. Use frameHash (storage key) when stored.
      const syncHash = gate.frameHash ?? gate.boundsHash;
      const auth = await state.cache.syncAuthorization(syncHash);
      if (auth) {
        state.setGateContent(gate.path, syncHash, auth.profileId, gate.gateContent, {
          boundsHash: gate.boundsHash,
          contextHash: gate.contextHash,
          context: gate.context,
        });
        synced++;
        console.error(`[Suveren MCP] Re-synced gate: ${gate.path}`);
      } else {
        // SP no longer has this attestation. The only path that produces
        // this state is the SP's hard-delete flow, which the user
        // initiated explicitly. Treat that as a positive signal that the
        // local gate is no longer wanted: drop the cached entry AND the
        // stored gate (encrypted intent), so the next login starts clean
        // and the resync log doesn't keep complaining. Revoked or
        // TTL-expired auths don't reach this branch — SP still holds
        // their FrameMetadata row, so syncAuthorization succeeds and the
        // local gate is preserved.
        state.cache.invalidate(gate.path);
        state.gateStore.delete(gate.path);
        orphaned++;
        console.error(`[Suveren MCP] Orphan gate purged (SP attestation deleted): ${gate.path}`);
      }
    } catch (err) {
      console.error(`[Suveren MCP] Failed to re-sync gate ${gate.path}:`, err);
    }
  }

  // Refresh tools on all active MCP sessions
  for (const [sessionId, session] of activeSessions) {
    try {
      session.refreshTools();
    } catch (err) {
      console.error(`[Suveren MCP] Failed to refresh session ${sessionId}:`, err);
    }
  }

  res.json({ ok: true, synced, orphaned });
});

// ─── Integration management endpoints ──────────────────────────────────────

app.post('/internal/add-integration', internalOnly, async (req: Request, res: Response) => {
  try {
    const config = req.body as IntegrationConfig;
    if (!config.id || !config.command) {
      res.status(400).json({ error: 'Missing required fields: id, command' });
      return;
    }

    // Persist config
    integrationRegistry.add(config);
    console.error(`[Suveren MCP] Integration ${config.id} added to registry`);

    // Try to start if enabled and credentials are available
    if (config.enabled) {
      if (Object.keys(config.envKeys ?? {}).length === 0 || integrationManager.canResolveEnvKeys(config)) {
        try {
          const tools = await integrationManager.startIntegration(config);
          res.json({ ok: true, id: config.id, tools: tools.map(t => t.namespacedName) });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[Suveren MCP] Failed to start integration ${config.id}:`, message);
          res.json({ ok: true, id: config.id, tools: [], warning: `Saved but failed to start: ${message}` });
          return;
        }
      } else {
        console.error(`[Suveren MCP] Integration ${config.id} saved but waiting for credentials`);
        res.json({ ok: true, id: config.id, tools: [], warning: 'Saved but waiting for service credentials' });
        return;
      }
    }

    res.json({ ok: true, id: config.id, tools: [] });
  } catch (err) {
    console.error('[Suveren MCP] Error adding integration:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.delete('/internal/remove-integration/:id', internalOnly, async (req: Request, res: Response) => {
  const id = req.params.id as string;

  // Stop if running
  await integrationManager.stopIntegration(id);

  // Remove from registry
  const removed = integrationRegistry.remove(id);
  if (!removed) {
    res.status(404).json({ error: `Integration "${id}" not found` });
    return;
  }

  console.error(`[Suveren MCP] Integration ${id} removed`);
  res.json({ ok: true, id });
});

app.get('/internal/integrations', internalOnly, (_req: Request, res: Response) => {
  const configs = integrationRegistry.getAll();
  const statuses = integrationManager.getStatus(configs);
  res.json({ integrations: statuses });
});

/**
 * Stop every running integration without removing them from the registry.
 *
 * Used by callers that want to halt agent traffic without forgetting which
 * integrations the user has configured (e.g., a future "Pause all" UI
 * button). Critically, this is NOT what runs on logout — logout leaves
 * integrations alone so attestation-bounded agent work can continue
 * asynchronously, which is the whole point of the protocol.
 *
 * For "stop and forget", use DELETE /internal/remove-integration/:id per
 * id, or rebuild the registry from scratch.
 */
app.post('/internal/stop-all-running', internalOnly, async (_req: Request, res: Response) => {
  try {
    await integrationManager.shutdown();
    console.error('[Suveren MCP] All running integrations stopped (registry preserved)');
    res.json({ ok: true });
  } catch (err) {
    console.error('[Suveren MCP] stop-all-running failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Stop failed' });
  }
});

// ─── SSE transport (for mcporter / OpenClaw) ────────────────────────────────

const sseSessions = new Map<string, SSEServerTransport>();

// GET /sse — client opens SSE stream
app.get('/sse', async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport('/messages', res);
  const { server, refreshTools, registerProxiedTools } = createMcpServer(state, integrationManager);

  const sessionId = transport.sessionId;
  sseSessions.set(sessionId, transport);
  activeSessions.set(sessionId, { refreshTools, registerProxiedTools });
  console.error(`[Suveren MCP] SSE session ${sessionId} connected`);

  res.on('close', () => {
    sseSessions.delete(sessionId);
    activeSessions.delete(sessionId);
    console.error(`[Suveren MCP] SSE session ${sessionId} closed`);
  });

  // Debug: register a dummy tool to verify dynamic registration works
  server.registerTool('debug_test_tool', { description: 'Debug test' }, async () => ({
    content: [{ type: 'text' as const, text: 'debug' }],
  }));
  await server.connect(transport);
});

// POST /messages — client sends JSON-RPC messages
app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseSessions.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: 'Unknown session' });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ─── Streamable HTTP transport (modern MCP clients) ─────────────────────────

const streamableSessions = new Map<string, StreamableHTTPServerTransport>();

app.all('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
    if (sessionId && streamableSessions.has(sessionId)) {
      const transport = streamableSessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'POST' && !sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          streamableSessions.delete(transport.sessionId);
          activeSessions.delete(transport.sessionId);
          console.error(`[Suveren MCP] Streamable session ${transport.sessionId} closed`);
        }
      };

      const { server, refreshTools, registerProxiedTools } = createMcpServer(state, integrationManager);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // Register session after handleRequest (sessionId is assigned during initialize)
      if (transport.sessionId && !streamableSessions.has(transport.sessionId)) {
        streamableSessions.set(transport.sessionId, transport);
        activeSessions.set(transport.sessionId, { refreshTools, registerProxiedTools });
        console.error(`[Suveren MCP] Streamable session ${transport.sessionId}`);
      }
      return;
    }

    res.status(400).json({ error: 'Bad request — missing or invalid session' });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
});

// ─── Health check ───────────────────────────────────────────────────────────

// Number of profiles registered at startup. 0 means the gateway will reject
// every gated action with "Unknown profile" — surfaced here for observability.
let profilesLoaded = 0;

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    transports: ['sse', 'streamable-http'],
    sp: spUrl,
    profilesLoaded,
    activeSessions: activeSessions.size,
    storedGates: state.gateStore.getAll().length,
    serviceCredentials: Array.from(serviceCredentials.keys()),
    integrations: integrationManager.getStatus(integrationRegistry.getAll()),
  });
});

app.get('/internal/gate-content', internalOnly, (req: Request, res: Response) => {
  // Lookup accepts any identifier we may have stashed on a gate entry:
  // the legacy v0.3 `path`, the v0.4 `profileId` fallback, the
  // `boundsHash`, or the compat `frameHash` alias. Previously matched
  // only on `path`, which is empty for v0.4 attestations — UIs
  // passing `item.path` got "Gate content not available" even though
  // the entry was safely stored under profileId / boundsHash.
  const path = req.query.path as string | undefined;
  const gates = state.gateStore.getAll();
  if (path) {
    const entry = gates.find(g =>
      g.path === path ||
      g.profileId === path ||
      g.boundsHash === path ||
      g.frameHash === path,
    );
    res.json({ entry: entry ?? null });
  } else {
    res.json({ entries: gates });
  }
});

app.get('/internal/manifests', internalOnly, (_req: Request, res: Response) => {
  res.json({ manifests: getAllManifests() });
});

// Agent Brief preview — returns the exact string the next MCP session will
// receive as `instructions`. Used by the Agent Brief UI so the user sees how
// their context.md edits reshape the session prelude byte-for-byte.
app.get('/internal/brief', internalOnly, (_req: Request, res: Response) => {
  try {
    const enriched = state.getEnrichedAuthorizations();
    const brief = buildMandateBrief({
      authorizations: enriched,
      executionLog: state.executionLog,
      integrationManager,
    });
    res.json({ brief });
  } catch (err) {
    console.error('[Suveren MCP] /internal/brief failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Brief preview failed' });
  }
});

// ─── Integration startup helpers ────────────────────────────────────────────

/**
 * Start integrations that are enabled and have their credentials available.
 * Called at startup and after new credentials are received.
 *
 * `integrations.json` is a point-in-time snapshot captured when each
 * integration was first added — its `toolGating` is stale if the manifest
 * file has been updated since. Here we always override the persisted
 * `toolGating` with the current manifest from `content/integrations/*.json`
 * so edits to manifest files take effect on next restart without requiring
 * the user to re-add the integration.
 */
async function startPendingIntegrations() {
  const configs = integrationRegistry.getEnabled();
  for (const config of configs) {
    await startOneIntegration(config);
  }
}

/**
 * Start a single integration by id if it's enabled, not running, and its
 * credentials are resolvable. Used on credential arrival so only the
 * matching integration is brought up — not a bulk pass over everything.
 */
async function startIntegrationForService(serviceId: string) {
  // An integration's id and the service it binds to are not always identical;
  // match either the integration id itself, or any integration whose envKeys
  // reference this service.
  const candidates = integrationRegistry.getEnabled().filter(c =>
    c.id === serviceId ||
    Object.values(c.envKeys ?? {}).some(ref => typeof ref === 'string' && ref.startsWith(`${serviceId}.`)),
  );
  for (const config of candidates) {
    await startOneIntegration(config);
  }
}

async function startOneIntegration(config: ReturnType<typeof integrationRegistry.getEnabled>[number]) {
  if (integrationManager.isRunning(config.id)) return;

  const needsCreds = Object.keys(config.envKeys ?? {}).length > 0;
  if (needsCreds && !integrationManager.canResolveEnvKeys(config)) {
    // Surface which env keys couldn't resolve so operators can see exactly
    // what the vault is missing (previously this was silent — the integration
    // just stayed "Not running" with no explanation).
    const missing: string[] = [];
    for (const [envKey, vaultRef] of Object.entries(config.envKeys ?? {})) {
      const [serviceId, key] = (vaultRef as string).split('.', 2);
      const creds = integrationManager.getServiceCredentials(serviceId);
      if (!creds || !(key in creds)) {
        missing.push(`${envKey} <- ${vaultRef}`);
      }
    }
    console.error(
      `[Suveren MCP] ${config.id} cannot start — missing credentials: ${missing.join(', ')}`,
    );
    return;
  }

  // Override stale persisted toolGating and npmPackage with the current manifest.
  const manifest = getManifest(config.id);
  const effectiveConfig = manifest
    ? { ...config, toolGating: manifest.toolGating, npmPackage: manifest.npmPackage ?? config.npmPackage }
    : config;

  try {
    await integrationManager.startIntegration(effectiveConfig);
  } catch (err) {
    console.error(`[Suveren MCP] Failed to start integration ${config.id}:`, err);
  }
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  console.error('[Suveren MCP] SIGTERM received, shutting down...');
  await integrationManager.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.error('[Suveren MCP] SIGINT received, shutting down...');
  await integrationManager.shutdown();
  process.exit(0);
});

// ─── Start server ───────────────────────────────────────────────────────────

app.listen(port, '0.0.0.0', () => {
  console.error(`[Suveren MCP] HTTP server listening on http://0.0.0.0:${port}`);
  console.error(`[Suveren MCP]   SSE:        http://0.0.0.0:${port}/sse`);
  console.error(`[Suveren MCP]   Streamable: http://0.0.0.0:${port}/mcp`);
  console.error(`[Suveren MCP]   SP server:  ${spUrl}`);

  // Load profiles and integration manifests before starting integrations
  profilesLoaded = loadProfiles();
  loadManifests();

  // Auto-register personalDefault integrations on first boot (no integrations registered yet)
  if (integrationRegistry.getEnabled().length === 0) {
    const personalManifests = getAllManifests().filter(m => m.personalDefault);
    for (const manifest of personalManifests) {
      // Build envKeys / optionalEnvKeys from manifest credential fields
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

      integrationRegistry.add({
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
      console.error(`[Suveren MCP] Auto-registered personal integration: ${manifest.id}`);
    }
  }

  // Restore integrations from registry on startup
  startPendingIntegrations().then(() => {
    const running = integrationManager.getStatus().filter(s => s.running);
    if (running.length > 0) {
      console.error(`[Suveren MCP] Restored ${running.length} integration(s): ${running.map(s => s.id).join(', ')}`);
    }
  });

  // ─── Auto-execution loop for committed proposals ────────────────────────
  // Polls SP every 5 seconds for proposals that all domains have committed.
  // For each one: requests a signed receipt (which atomically transitions
  // the proposal to executed on the SP), then executes the tool locally.
  //
  // v0.4: the receipt route is the single source of truth for the
  // committed→executed state transition. The legacy updateProposalStatus
  // call is gone. If check-pending-commitments races with this loop, the
  // atomic CAS in the SP ensures only one path executes.

  const PROPOSAL_POLL_INTERVAL = 5_000;

  async function executeCommittedProposals(): Promise<void> {
    try {
      const committed = await state.spClient.getCommittedProposals();
      for (const proposal of committed) {
        // Use the shared, v0.5-correct executor (boundsHash receipt + verification
        // footer + execution-log record). The previous inline copy here still
        // sent the retired attestationHash/path fields, which v0.5 ASs reject —
        // so this loop silently never executed anything and review-mode approvals
        // only ran when check-pending-commitments was triggered manually.
        // PROPOSAL_ALREADY_EXECUTED races are handled inside executeCommitted.
        try {
          const { text, isError } = await executeCommitted(proposal, state, integrationManager);
          console.error(
            isError
              ? `[Suveren MCP] Auto-exec proposal ${proposal.id}: ${text}`
              : `[Suveren MCP] Auto-executed proposal ${proposal.id}: ${proposal.tool}`,
          );
        } catch (err) {
          console.error(`[Suveren MCP] Failed to execute proposal ${proposal.id}:`, err);
        }
      }
    } catch {
      // SP unreachable or no session — skip this cycle
    }
  }

  setInterval(executeCommittedProposals, PROPOSAL_POLL_INTERVAL);
});
