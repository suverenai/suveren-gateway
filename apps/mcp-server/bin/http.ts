#!/usr/bin/env node

/**
 * Suveren MCP Server — HTTP entry point (supports both SSE and Streamable HTTP).
 *
 * Listens on SUVEREN_BIND_HOST (default 127.0.0.1; the Docker image sets
 * 0.0.0.0). Internal requests are accepted only from the control-plane via
 * loopback. Who may connect as the agent: see src/lib/agent-access.ts.
 *
 * Environment variables:
 * - SUVEREN_AS_URL — AS server URL (default: https://www.suveren.ai)
 * - SUVEREN_AS_API_KEY — AS API key for receipt requests (optional)
 * - SUVEREN_MCP_PORT — HTTP port (default: 3430)
 * - SUVEREN_BIND_HOST — listen address (default: 127.0.0.1)
 * - SUVEREN_MCP_TOKEN — when set, required to open an agent session
 */

import { randomUUID } from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SharedState } from '../src/lib/shared-state';
import { createMcpServer } from '../src/index';
import { AgentContactStore } from '../src/lib/agent-contact';
import { verifyGateContentHashes } from '../src/lib/gate-content';
import type { GateContent } from '../src/lib/gate-store';
import { IntegrationRegistry, type IntegrationConfig } from '../src/lib/integration-registry';
import { IntegrationManager, getIntegrationsBinDir } from '../src/lib/integration-manager';
import { createConnectorExportRunner, renderReportHtml, glossaryUsage, sanitizeReport, buildTicketDetails, buildExportBundle, buildExportDocument, suggestedFilename } from '../src/lib/report';
import type { ReportSources, ReceiptArchiveReader } from '../src/lib/report';
import { scopeReportSources, scopeReportSourcesToStoredWindow } from '../src/lib/report/window';
import type { StoredReport } from '../src/lib/report/report-store';
import { isSimulationMode } from '../src/lib/simulation-mode';
import { agentAccess, bindRefusal, resolveAgentToken, resolveBindHost } from '../src/lib/agent-access';
import { readPairing } from '../src/lib/as-pairing';
import { loadProfiles } from '../src/lib/profile-loader';
import { loadManifests, getAllManifests, getManifest } from '../src/lib/manifest-loader';
import { registerBuiltins } from '../src/lib/builtins';
import { buildMandateBrief } from '../src/lib/mandate-brief';
import { decodeMandateBlob } from '@hap/core';
import { executeCommitted, installCommittedExecutor, buildSkippedProposalNote } from '../src/tools/commitments';
import { CommittedExecutor, ExecutorLock } from '../src/lib/committed-executor';
import type { SPProposal } from '../src/lib/sp-client';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAsUrl, resolvePinTls, validatePinTlsForUrl } from '../src/lib/as-config';
import { readMcpPairedAsUrl, writeMcpPairedAsUrl } from '../src/lib/mcp-as-tracker';
import { setAsBaseUrl } from '../src/lib/receipt-footer';

// Same default every stateful module in this codebase uses (GateStore,
// ReceiptArchive, …) — see as-config.ts's doc comment.
const dataDir = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

// Resolution order: env SUVEREN_AS_URL > saved <dataDir>/config.json >
// default suveren.ai. Throws (refusing to start) if an explicitly set source
// is malformed.
const spUrl = resolveAsUrl(dataDir);
// Refuses to start (throws) when pinTls is on for a non-https AS URL — not
// just a CLI-flag-time check, so a hand-edited config.json is caught too.
validatePinTlsForUrl(resolvePinTls(dataDir), spUrl);
const port = parseInt(process.env.SUVEREN_MCP_PORT ?? '3430', 10);

// Who may connect as the agent — see agent-access.ts. Refuse to start rather
// than expose the agent port to the network without a token.
const bindHost = resolveBindHost();
const agentToken = resolveAgentToken();
const bindProblem = bindRefusal();
if (bindProblem) {
  console.error(`[Suveren MCP] Refusing to start: ${bindProblem}`);
  process.exit(1);
}

// The receipt footer's link uses the SAME resolved URL — see receipt-footer.ts.
setAsBaseUrl(spUrl);

// ─── Shared state (one instance for all connections) ───────────────────────

const state = new SharedState(spUrl, undefined, dataDir);
// Has a person's AI ever connected? Drives the dashboard's "Connect your AI" step.
const agentContact = new AgentContactStore(dataDir);

// What verifyReport (via ReportStore) reads evidence from: the local receipt
// archive, and each simulator's own `export` CLI — same bin dir / data dir
// integration-manager.ts uses to spawn these connectors as MCP servers, so
// `<bin> export` reads the SAME SQLite file the live connector writes to.
const reportSources: ReportSources = {
  archive: state.receiptArchive,
  runExport: createConnectorExportRunner({ integrationsBinDir: getIntegrationsBinDir(), dataDir }),
};

// ─── Re-pair when the Authority Server URL changes ──────────────────────
//
// Boot-time only, mirrors the control plane's own check (index.ts) — the two
// processes share the same data dir but each independently notices the
// change, since bundle/server.js starts them concurrently and either can come
// up first.
//
// Deliberately reads/writes mcp-as-tracker.ts's OWN file, not the control
// plane's `as-pairing.json` — reading that shared file here would race it:
// whichever process booted first and deleted it (see index.ts) would leave
// the other with nothing to compare against, and it would skip clearing
// stale mandates. This file is written and read ONLY by the MCP server, so
// neither process's timing can affect the other's decision, in either boot
// order.
//
// Kept: vault credentials (owned by the control plane, untouched here) and
// the local receipt archive (each entry already stores its own asUrl).
(function repairIfAsUrlChanged() {
  const lastKnown = readMcpPairedAsUrl(dataDir);
  // No tracker record at all (lastKnown === null) is deliberately NOT treated
  // as a change: every 0.8.7-and-earlier data dir has none, so clearing here
  // wiped every grant's intent/scope (the only copy of it — the AS never
  // holds it) on the first boot after upgrading, even when the Authority
  // Server never changed. That is a strictly worse outcome than the gap it
  // tried to close: an upgrade that ALSO switches the AS in the same restart
  // is still caught — not here, but by the existing post-sign-in resync
  // (mcp-bridge.ts's resyncGates / the /internal/resync-gates handler), which
  // already drops any gate whose authorizationId the new AS doesn't
  // recognize. Only a KNOWN prior URL that disagrees with the current one is
  // grounds to clear at boot.
  if (lastKnown !== null && lastKnown !== spUrl) {
    console.error(
      `[Suveren MCP] Authority Server changed (${lastKnown} → ${spUrl}) — ` +
        'clearing cached mandates. Sign in again to re-pair.',
    );
    state.gateStore.clearAll();
  }
  writeMcpPairedAsUrl(dataDir, spUrl);
})();

// V7 — check the Authority Server's protocol compat once at startup (GET
// /api/as/compat, unauthenticated). Fire-and-forget at module scope: this
// file is a flat top-level script (no async main), and gated tool calls
// already read `state.asVersionRefusal` lazily, so nothing here needs to
// block the server from starting — it only needs to have RUN before the
// first gated call could plausibly arrive, which this easily beats.
void state.checkAsCompat();

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

// A pinned connector whose persisted config still uses the old `npx …
// @latest` shape gets its command/args corrected in-memory on every start
// regardless (see integration-manager.ts); this persists that fix to
// integrations.json ONCE, so it stops happening silently on every boot.
integrationManager.setOnConfigMigrated((id, updates) => {
  integrationRegistry.update(id, updates);
  console.error(`[Suveren MCP] ${id}: persisted config migrated (${Object.keys(updates).join(', ')})`);
});

const app = express();
app.use(express.json());

// No CORS headers: no browser page calls this server (the UI talks to the
// control plane, which reaches us over /internal on loopback). The old
// `Access-Control-Allow-Origin: http://localhost:3000` named a port nothing
// uses; without any such header a browser cannot read our responses at all.

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
    const key = Buffer.from(vaultKeyHex, 'hex');
    state.gateStore.setVaultKey(key);
    state.denialLog.setVaultKey(key);
    state.receiptArchive.setVaultKey(key);
    state.reportStore.setVaultKey(key);
    console.error('[Suveren MCP] Vault key configured — gate store + denial log + receipt archive + report store encryption active');
  }

  if (apiKey) {
    state.spClient.setApiKey(apiKey);
    console.error('[Suveren MCP] SP API key configured by control-plane');
  }

  res.json({ ok: true });
});

/**
 * Push the "session ended" state to this process. Called by the control
 * plane's own session-lock procedure — whether IT detected the 401 (its own
 * AS proxy call), a sibling MCP process did (via /internal/event →
 * session-expired), or an AS key mismatch. Idempotent: a client that already
 * cleared itself on its own 401 just gets the same state written again.
 *
 * `reason`, when sent, is the REAL reason the control plane locked (see
 * session-lock.ts) — carried through so the agent is told the truth instead
 * of always hearing "your sign-in ended" (sp-client.ts's clearSession()
 * default), which for an AS key mismatch or URL change would send it toward
 * a sign-in that is itself refused.
 */
app.post('/internal/clear-session', internalOnly, (req: Request, res: Response) => {
  const reason = (req.body as { reason?: unknown })?.reason;
  const validReason =
    reason === 'as-key-mismatch' || reason === 'as-tls-mismatch' || reason === 'as-url-changed' ? reason : undefined;
  state.spClient.clearSession(validReason);
  console.error(`[Suveren MCP] Session cleared by control-plane (${validReason ?? 'expired'})`);
  res.json({ ok: true });
});

app.post('/internal/gate-content', internalOnly, async (req: Request, res: Response) => {
  try {
    const { authorizationId, boundsHash, contextHash, context, contextLabels, path: rawPath, gateContent } = req.body as {
      authorizationId?: string;
      boundsHash?: string;
      contextHash?: string;
      context?: Record<string, string | number>;
      contextLabels?: Record<string, Record<string, string>>;
      path?: string;
      gateContent: GateContent;
    };

    // v0.4: intent field. v0.3 compat: problem/objective/tradeoffs (not on the
    // current GateContent type — read via a legacy cast).
    const hasIntent = !!gateContent?.intent;
    const legacy = gateContent as { problem?: string; objective?: string; tradeoffs?: string } | undefined;
    const hasLegacy = !!legacy?.problem && !!legacy?.objective && !!legacy?.tradeoffs;
    if (!authorizationId || (!hasIntent && !hasLegacy)) {
      res.status(400).json({ error: 'Missing required fields: authorizationId, gateContent.{intent} or gateContent.{problem,objective,tradeoffs}' });
      return;
    }

    // Sync the authorization from the SP so we can verify hashes
    const auth = await state.cache.syncAuthorization(authorizationId);
    if (!auth) {
      res.status(404).json({ error: `No authorization found for ${authorizationId}` });
      return;
    }

    // Verify gate content hashes match attestation
    const verification = verifyGateContentHashes(gateContent, auth);
    if (!verification.valid) {
      res.status(400).json({ error: 'Gate content hash mismatch', details: verification.errors });
      return;
    }

    // Gate content is keyed by the per-ceremony id — twins can never collide.
    const path = rawPath || authorizationId;

    // Store gate content (encrypted if vault key is set), passing v0.4 fields through
    state.setGateContent(path, authorizationId, auth.profileId, gateContent, {
      boundsHash, contextHash, context, contextLabels,
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

// Handle to the committed-proposal executor (defined in the post-listen block).
// The control-plane calls /internal/run-committed right after a proposal
// resolves so approve→send is near-instant instead of waiting for the poll.
let triggerCommittedExecution: () => void = () => {};

app.post('/internal/run-committed', internalOnly, (_req: Request, res: Response) => {
  triggerCommittedExecution();
  res.json({ ok: true });
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
      // Re-sync each stored grant by its per-ceremony id.
      const authzId = gate.authorizationId;
      const auth = await state.cache.syncAuthorization(authzId);
      if (auth) {
        state.setGateContent(auth.path, authzId, auth.profileId, gate.gateContent, {
          boundsHash: gate.boundsHash,
          contextHash: gate.contextHash,
          context: gate.context,
          // Preserve discovered display names across resyncs — the AS never
          // sees them, so the local copy is the only one.
          contextLabels: gate.contextLabels,
        });
        synced++;
        console.error(`[Suveren MCP] Re-synced gate: ${gate.path}`);
      } else {
        // The AS no longer serves this authorization: hard-deleted, or
        // REVOKED (syncAuthorization drops revoked grants so they are
        // never listed or matched). Both are explicit, permanent human
        // decisions ending the grant, so drop the cached entry AND the
        // stored gate (encrypted intent) — the next login starts clean
        // and the resync log doesn't keep complaining. TTL-expired auths
        // don't reach this branch: the AS still returns their record, so
        // syncAuthorization succeeds and the local gate is preserved.
        state.cache.invalidate(authzId);
        state.gateStore.delete(authzId);
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

/**
 * Set the LOCAL read-age window for an integration — how far back the agent
 * may read. Local and live: read policy is enforced only by the Gatekeeper, so
 * it needs no re-attestation and takes effect on the next read (see
 * `content/0.5/protocol.md` → *Bounds, Context, and Read Policy*).
 *
 * Body: `{ readAgeDays: number | null }` — a non-negative integer, or null to
 * clear the local setting and fall back to the signed grant bound.
 */
app.patch('/internal/integration/:id/read-policy', internalOnly, (req: Request, res: Response) => {
  const id = req.params.id as string;
  const raw = (req.body as { readAgeDays?: unknown }).readAgeDays;

  // Validate before touching state. `null` clears; anything else must be a
  // non-negative integer — reject NaN/Infinity/negatives/strings rather than
  // persisting a value the read path would treat as "unset" and silently
  // fall back on.
  let readAgeDays: number | null;
  if (raw === null) {
    readAgeDays = null;
  } else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    readAgeDays = raw;
  } else {
    res.status(400).json({ error: 'readAgeDays must be a non-negative integer, or null to clear it' });
    return;
  }

  const updated = integrationRegistry.update(id, { readAgeDays: readAgeDays ?? undefined });
  if (!updated) {
    res.status(404).json({ error: `Integration "${id}" not found` });
    return;
  }
  // Keep the running snapshot in step so the change applies without a restart.
  integrationManager.setReadAgeDays(id, readAgeDays);

  console.error(`[Suveren MCP] Read policy for ${id}: ${readAgeDays === null ? 'cleared' : `${readAgeDays}d`}`);
  res.json({ ok: true, id, readAgeDays });
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

/** The MCP SDK's own body for an unknown session (JSON-RPC error -32001). */
const SESSION_NOT_FOUND = { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null } as const;

// GET /sse and a POST /mcp without a session id open a session; everything
// else continues one (and is tied to it by the session id).
const guardAgent = agentAccess(
  agentToken,
  (req) => (req.path === '/sse' && req.method === 'GET') || (req.path === '/mcp' && req.method === 'POST' && !req.headers['mcp-session-id']),
);

// GET /sse — client opens SSE stream
app.get('/sse', guardAgent, async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport('/messages', res);
  const { server, refreshTools, registerProxiedTools } = createMcpServer(state, integrationManager);

  server.server.oninitialized = () => agentContact.record(server.server.getClientVersion());
  const sessionId = transport.sessionId;
  sseSessions.set(sessionId, transport);
  activeSessions.set(sessionId, { refreshTools, registerProxiedTools });
  console.error(`[Suveren MCP] SSE session ${sessionId} connected`);

  res.on('close', () => {
    sseSessions.delete(sessionId);
    activeSessions.delete(sessionId);
    console.error(`[Suveren MCP] SSE session ${sessionId} closed`);
  });

  await server.connect(transport);
});

// POST /messages — client sends JSON-RPC messages
app.post('/messages', guardAgent, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseSessions.get(sessionId);
  if (!transport) {
    // 404, not 400: the MCP transport spec tells a client that gets 404 for
    // its session to open a new one — after a gateway restart that is what
    // lets assistants reconnect without being restarted themselves.
    res.status(404).json(SESSION_NOT_FOUND);
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ─── Streamable HTTP transport (modern MCP clients) ─────────────────────────

const streamableSessions = new Map<string, StreamableHTTPServerTransport>();

app.all('/mcp', guardAgent, async (req: Request, res: Response) => {
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
      server.server.oninitialized = () => agentContact.record(server.server.getClientVersion());
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

    // A session id we do not know (the gateway restarted, or the session
    // closed): 404 per the MCP Streamable HTTP spec ("Session Management"),
    // so the client re-initializes on its own. 400 made clients give up.
    if (sessionId) {
      res.status(404).json(SESSION_NOT_FOUND);
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
    // The gateway's own tool groups (built-ins) — not connectors; the mandate
    // picker offers them so a person can give a mandate for them.
    builtins: integrationManager.getBuiltins(),
  });
});

// Has a person's AI ever connected, which one, and when last — for the dashboard's
// first-run card. Internal (the control plane proxies it behind its auth guard),
// so the client name is not on the unauthenticated /health.
app.get('/internal/agent-contact', internalOnly, (_req: Request, res: Response) => {
  res.json({ contact: agentContact.read() });
});

// Argument schemas + approvalView hints per tool, for the approval screen.
app.get('/internal/tool-display', internalOnly, (_req: Request, res: Response) => {
  res.json({ tools: integrationManager.getToolDisplay() });
});

app.get('/internal/gate-content', internalOnly, (req: Request, res: Response) => {
  // Lookup is exact-match on the per-ceremony `authorizationId` ONLY.
  // The old multi-key fallback (path / profileId / boundsHash) returned
  // the FIRST entry sharing a fingerprint — the same twin-merge vector
  // per-ceremony identity exists to kill. One grant, one key.
  const path = req.query.path as string | undefined;
  const gates = state.gateStore.getAll();
  if (path) {
    const entry = gates.find(g => g.authorizationId === path);
    res.json({ entry: entry ?? null });
  } else {
    res.json({ entries: gates });
  }
});

// Enriched active authorizations — the same active set list-authorizations
// shows (cache-backed, so no stale gate entries), each carrying its local
// context. Used by the UI to compare a new grant's scope against existing
// ones at creation time. Context stays local — internalOnly, never the AS.
app.get('/internal/authorizations', internalOnly, (_req: Request, res: Response) => {
  const authorizations = state.getEnrichedAuthorizations().map(a => ({
    profileId: a.profileId,
    authorizationId: a.authorizationId,
    bounds: a.frame,
    context: a.context ?? {},
    intent: a.gateContent?.intent ?? null,
    deferredCommitmentDomains: a.deferredCommitmentDomains ?? [],
    // Item 9 (re-approval UX) — the AS told us, via a VERSION_UNSUPPORTED
    // ticket refusal, that this authorization's mandate blob is pre-0.7.
    needsReapproval: a.needsReapproval ?? false,
  }));
  res.json({ authorizations });
});

app.get('/internal/manifests', internalOnly, (_req: Request, res: Response) => {
  res.json({ manifests: getAllManifests() });
});

/**
 * Committed proposals this gateway will NOT execute because it holds no
 * local submission record for them (see tools/commitments.ts's skip path
 * and buildSkippedProposalNote) — the UI's counterpart to
 * check-pending-commitments' list view, so an approved-but-nothing-happened
 * proposal is visible there too, not just to an agent that happens to ask.
 */
app.get('/internal/skipped-commitments', internalOnly, async (_req: Request, res: Response) => {
  try {
    const committed = await state.spClient.getCommittedProposals();
    const skipped = committed
      .filter(p => !state.proposalSubmissions.get(p.id))
      .map(p => ({ id: p.id, tool: p.tool, note: buildSkippedProposalNote(p.id) }));
    res.json({ skipped });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Could not reach the Authority Server' });
  }
});

// Local evidence — everything this machine holds that proves what ran and
// under which mandate: the receipt archive (complete signed receipts +
// attestation blobs + issuer keys, append-only, never pruned) joined with the
// gate store (intent text, local context — whose hashes the signed attestation
// commits to). Serves the control-plane's evidence-download route. The
// archive works even when the AS is gone; that is its reason to exist.
app.get('/internal/evidence', internalOnly, (_req: Request, res: Response) => {
  // An encrypted archive with no vault key must refuse, not serve [] — an
  // empty answer over unreadable evidence would read as "nothing happened".
  if (state.receiptArchive.isLocked()) {
    res.status(503).json({ error: 'Vault locked — the evidence archive is encrypted until sign-in.' });
    return;
  }
  // Each attestation gets a best-effort `decoded` view next to its blob: the
  // blob is the verification material (opaque base64), the decoded payload is
  // what a human reads — bounds_hash, commitment_mode, gate_content_hashes,
  // owners. The blob stays the source of truth; `decoded` is a convenience
  // projection and is omitted (never guessed) when the blob won't parse.
  const authorizations = state.receiptArchive.getAuthorizations().map(a => ({
    ...a,
    attestations: a.attestations.map(att => {
      try {
        return { ...att, decoded: decodeMandateBlob(att.blob) };
      } catch {
        return att;
      }
    }),
  }));
  res.json({
    receipts: state.receiptArchive.getReceipts(),
    authorizations,
    gates: state.gateStore.getAll(),
  });
});

// ─── Report (evidence-backed reports, work-plan "evidence-backed reports") ──
//
// ONE current report, vault-encrypted like the stores above (report-store.ts).
// GET returns the already-verified model from the last save/recheck — never
// re-verifies on read (that would hide when a check actually ran from the
// UI's "checked HH:MM" status). The save and recheck routes are deliberately
// generic (take/return the stored report + element render) rather than
// AI-tool-shaped: the AI-facing save tool is a later step (R4, out of scope
// here) and will call the SAME store, not duplicate this logic.

/**
 * Shared response shape for GET/POST /internal/report and /internal/report/recheck
 * — same fields every time so the control-plane proxy (and the UI) have one
 * shape to handle regardless of which route produced it.
 */
/**
 * The report's evidence, scoped to the reporting window the active reporting
 * mandate sets (report/window.ts, RR2) — the SAME scoping the report__* tools
 * use, so a save, a "Check again" and an export see exactly what the AI could.
 */
function reportScope() {
  return scopeReportSources(reportSources, {
    authorizations: state.getEnrichedAuthorizations(),
    simulation: isSimulationMode(),
  });
}

/** "Check again" / export of a stored report: the window it was written under
 *  when it has one (see scopeReportSourcesToStoredWindow), else the window the
 *  active reporting mandate sets now, else refused. */
function storedReportScope(stored: StoredReport | null) {
  const w = stored?.result.coverage.window;
  if (w) return scopeReportSourcesToStoredWindow(reportSources, w, { simulation: isSimulationMode() });
  return reportScope();
}

async function reportResponsePayload(
  stored: NonNullable<ReturnType<typeof state.reportStore.getReport>>,
  archive?: ReceiptArchiveReader,
) {
  // Detail-panel data for the local UI, scoped to the report's window (the
  // one it was written under, else the active mandate's). Only a report saved
  // before windows existed, with no reporting mandate active, falls back to
  // the owner's own full archive — this is the owner's UI, not the AI.
  let detailArchive: ReceiptArchiveReader = state.receiptArchive;
  if (archive) {
    detailArchive = archive;
  } else {
    const scoped = await storedReportScope(stored);
    if (scoped.ok) detailArchive = scoped.sources.archive;
  }
  const ticketDetails = await buildTicketDetails(detailArchive, stored.result.proof.ticketsReferenced);
  // Two pre-rendered variants (RR6): translation off (the default) and on.
  // The UI's switch, outside the frame, picks one — no script in the frame.
  // The "on" variant exists only when at least one gloss is drawn.
  const glossary = glossaryUsage(stored.result.html, stored.result.elements);
  // A report stored before the two-tag rule (RR6) keeps its free HTML; the
  // render drops whatever is outside the allowed blocks. Say so in the UI.
  const dropped = sanitizeReport(stored.html).notes;
  const notShown = dropped.droppedBlocks + dropped.droppedSvInsideAi + dropped.droppedStyles;
  return {
    savedAt: stored.savedAt,
    checkedAt: stored.checkedAt,
    renderedHtml: renderReportHtml(stored.result.html, stored.result.elements),
    ...(glossary && glossary.applied.length > 0
      ? { renderedHtmlGloss: renderReportHtml(stored.result.html, stored.result.elements, { gloss: 'on' }) }
      : {}),
    ...(glossary ? { glossary } : {}),
    ...(notShown > 0 ? { formatNotice: { blocksNotShown: notShown } } : {}),
    proof: stored.result.proof,
    coverage: stored.result.coverage,
    elements: stored.result.elements,
    ticketDetails,
  };
}

app.get('/internal/report', internalOnly, async (_req: Request, res: Response) => {
  if (state.reportStore.isLocked()) {
    res.status(503).json({ error: 'Vault locked — the report is encrypted until sign-in.' });
    return;
  }
  const stored = state.reportStore.getReport();
  if (!stored) {
    res.json({ report: null });
    return;
  }
  res.json({ report: await reportResponsePayload(stored) });
});

app.post('/internal/report', internalOnly, async (req: Request, res: Response) => {
  if (state.reportStore.isLocked()) {
    res.status(503).json({ error: 'Vault locked — cannot save a report until sign-in.' });
    return;
  }
  const html = (req.body as { html?: unknown })?.html;
  if (typeof html !== 'string' || !html.trim()) {
    res.status(400).json({ error: 'Missing required field: html (non-empty string)' });
    return;
  }
  const scoped = await reportScope();
  if (!scoped.ok) {
    res.status(409).json({ error: scoped.reason });
    return;
  }
  try {
    const stored = await state.reportStore.saveReport(html, scoped.sources);
    res.json({ report: await reportResponsePayload(stored, scoped.sources.archive) });
  } catch (err) {
    console.error('[Suveren MCP] /internal/report save failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Report verification failed' });
  }
});

app.post('/internal/report/recheck', internalOnly, async (_req: Request, res: Response) => {
  if (state.reportStore.isLocked()) {
    res.status(503).json({ error: 'Vault locked — cannot recheck until sign-in.' });
    return;
  }
  const current = state.reportStore.getReport();
  if (!current) {
    res.json({ report: null });
    return;
  }
  const scoped = await storedReportScope(current);
  if (!scoped.ok) {
    res.status(409).json({ error: scoped.reason });
    return;
  }
  try {
    const stored = await state.reportStore.recheck(scoped.sources);
    if (!stored) {
      res.json({ report: null });
      return;
    }
    res.json({ report: await reportResponsePayload(stored, scoped.sources.archive) });
  } catch (err) {
    console.error('[Suveren MCP] /internal/report/recheck failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Recheck failed' });
  }
});

/**
 * The single Authority Server key an export bundle anchors every ticket
 * signature to (export-types.ts's doc comment explains why ONE key, not one
 * per ticket). Prefers the pinned pairing (`as-pairing.json` — the same trust
 * anchor `AttestationCache`/`ticket-verify.ts` enforce against day to day, no
 * extra network call needed here). Falls back to the most recently archived
 * ticket's own key only if the pairing file is somehow missing despite having
 * evidence to export (e.g. hand-cleared) — empty string, never fabricated,
 * when truly nothing is available; the route below refuses to export in that
 * case rather than ship an unanchored bundle.
 */
function resolveExportAuthorityServer(): { url: string; publicKeyHex: string } {
  const pin = readPairing(dataDir);
  if (pin) return { url: pin.asUrl, publicKeyHex: pin.publicKeyHex };
  const withKey = state.receiptArchive
    .getReceipts()
    .filter((r): r is typeof r & { asPublicKey: string } => !!r.asPublicKey)
    .sort((a, b) => b.archivedAt - a.archivedAt);
  if (withKey.length > 0) return { url: withKey[0].asUrl, publicKeyHex: withKey[0].asPublicKey };
  return { url: spUrl, publicKeyHex: '' };
}

app.get('/internal/report/export', internalOnly, async (req: Request, res: Response) => {
  if (state.reportStore.isLocked() || state.receiptArchive.isLocked()) {
    res.status(503).json({ error: 'Vault locked — the report is encrypted until sign-in.' });
    return;
  }
  // Re-run verification so the export reflects the CURRENT state, same as
  // "Check again" — never ship a file describing a stale check. Scoped to the
  // reporting window: nothing outside it can enter the file (RR2).
  const current = state.reportStore.getReport();
  if (!current) {
    res.status(404).json({ error: 'No report to export yet — the AI writes it with the Reporting mandate.' });
    return;
  }
  const scoped = await storedReportScope(current);
  if (!scoped.ok) {
    res.status(409).json({ error: scoped.reason });
    return;
  }
  let stored;
  try {
    stored = await state.reportStore.recheck(scoped.sources);
  } catch (err) {
    console.error('[Suveren MCP] /internal/report/export recheck failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Recheck failed' });
    return;
  }
  if (!stored) {
    res.status(404).json({ error: 'No report to export yet — the AI writes it with the Reporting mandate.' });
    return;
  }

  const authorityServer = resolveExportAuthorityServer();
  if (!authorityServer.publicKeyHex) {
    res.status(503).json({
      error: 'No Authority Server key is available yet to anchor this export — sign in once, or execute at least one gated action, before exporting.',
    });
    return;
  }

  const gatewayVersion = typeof req.query.gatewayVersion === 'string' ? req.query.gatewayVersion : 'unknown';
  const bundle = buildExportBundle({
    stored,
    archive: scoped.sources.archive,
    authorityServer,
    gatewayVersion,
  });
  // Same strict boxes as the live page, drawn from the bundle's own elements
  // (glosses behind the export's CSS-only switch, RR6) — so the offline
  // checker can re-draw the file byte for byte (verify-export.ts).
  const document = buildExportDocument({ bundle });

  res
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${suggestedFilename(bundle)}"`)
    .setHeader('Cache-Control', 'no-store')
    .send(document);
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
      asVersionRefusal: state.asVersionRefusal,
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
    // skipIfRunning: this path is opportunistic (boot restore / credential
    // arrival). If an explicit add-integration start is in flight or already
    // won, this call must not restart the integration with the manifest
    // config — doing so replaced a stricter explicit gating with the
    // manifest's and made the read gate nondeterministically fail open.
    await integrationManager.startIntegration(effectiveConfig, { skipIfRunning: true });
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

app.listen(port, bindHost, () => {
  console.error(`[Suveren MCP] HTTP server listening on http://${bindHost}:${port}`);
  console.error(`[Suveren MCP]   SSE:        http://${bindHost}:${port}/sse`);
  console.error(`[Suveren MCP]   Streamable: http://${bindHost}:${port}/mcp`);
  console.error(`[Suveren MCP]   Agent token: ${agentToken ? 'required' : 'not set (this machine only)'}`);
  console.error(`[Suveren MCP]   SP server:  ${spUrl}`);

  // Load profiles and integration manifests before starting integrations
  profilesLoaded = loadProfiles();
  loadManifests();
  // The gateway's own tool groups — after manifests, so a built-in can never take a connector's id.
  registerBuiltins({ state, integrationManager, reportSources });

  // Auto-register personalDefault integrations on first boot (no integrations
  // registered yet). SUVEREN_DISABLE_AUTO_INTEGRATIONS=1 skips it — tests want a
  // clean slate without the npm-install cost of crm/records.
  if (process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS !== '1' && integrationRegistry.getEnabled().length === 0) {
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

  // ONE executor for every trigger (poll, nudge, agent's check-pending call).
  // On 2026-09-04 the nudge and the poll ran the same proposal concurrently;
  // the AS correctly replayed the ticket to the second caller and the tool
  // ran twice. See committed-executor.ts and execution-journal.ts.
  const committedExecutor = new CommittedExecutor<SPProposal>(
    proposal => executeCommitted(proposal, state, integrationManager),
  );
  installCommittedExecutor(committedExecutor);

  // Only one process per data directory auto-executes. The dev and npm
  // gateways share ~/.suveren and the same AS credentials; without this both
  // would poll and both would run. Not holding the lock disables the loop and
  // the nudge in this process — tool calls and proposals still work.
  const dataDir = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  const executorLock = new ExecutorLock(dataDir);
  const lock = executorLock.acquire();
  if (!lock.held) {
    console.error(
      `[Suveren MCP] Committed-proposal execution is DISABLED in this process: pid ${lock.holderPid} ` +
        `holds ${dataDir}/executor.lock. Approved proposals will run there. ` +
        'Stop that gateway if this one should execute.',
    );
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    process.once(sig, () => executorLock.release());
  }

  let draining = false;
  async function executeCommittedProposals(): Promise<void> {
    if (!executorLock.isHeld()) return;
    // Overlapping ticks would only re-fetch the same list; the executor
    // already dedups per proposal, so this is economy, not correctness.
    if (draining) return;
    draining = true;
    try {
      const committed = await state.spClient.getCommittedProposals();
      for (const proposal of committed) {
        try {
          const { text, isError } = await committedExecutor.execute(proposal);
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
    } finally {
      draining = false;
    }
  }

  setInterval(executeCommittedProposals, PROPOSAL_POLL_INTERVAL);
  // Expose the executor for the control-plane's post-resolve nudge (fire-and-forget).
  triggerCommittedExecution = () => { void executeCommittedProposals(); };
});
