/**
 * Suveren Control Plane — Express server that:
 * 1. Serves the built Vite UI
 * 2. Handles cookie-less API key authentication
 * 3. Proxies /api/* to the hosted SP (injecting server-side cookie, auth-guarded)
 * 4. Forwards gate-content to MCP server
 * 5. Provides encrypted vault endpoints
 * 6. Proxies AI assistant requests (keys never sent to browser)
 * 7. Proxies GitHub API requests (PAT never sent to browser)
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── One-shot data directory migration (.hap → .suveren) ────────────────────
// Run before anything that reads/writes the data dir.
(function migrateDataDir() {
  if (process.env.SUVEREN_DATA_DIR) return; // user explicitly set a path; skip
  const oldDir = join(homedir(), '.hap');
  const newDir = join(homedir(), '.suveren');
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      console.error(`[Control Plane] Migrated data directory: ${oldDir} → ${newDir}`);
    } catch (err) {
      console.error(`[Control Plane] FATAL: could not migrate data directory ${oldDir} → ${newDir}:`, err);
      process.exit(1);
    }
  }
})();
import express, { type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Vault } from './lib/vault';
import { createAuthRouter } from './routes/auth';
import { createVaultRouter } from './routes/vault';
import { createAIRouter } from './routes/ai';
import { createAIPromptsRouter } from './routes/ai-prompts';
import { requireAuth, requireAuthQueryOrHeader } from './middleware/auth';
import { pushGateContent, pushServiceCredentials, setInternalSecret, getManifests, getGateContent, getEnrichedAuthorizations, MCP_BASE, runCommittedProposals } from './lib/mcp-bridge';
import { createMCPRouter } from './routes/mcp';
import { createEncryptIntentRouter } from './routes/encrypt-intent';
import { createDecryptIntentRouter } from './routes/decrypt-intent';
import { createApprovedIntentsRouter } from './routes/approved-intents';
import { startUpdateChecker, getUpdateStatus, forceCheck } from './lib/update-checker';
import { createEventsHandler } from './routes/events';
import { eventBus } from './lib/event-bus';

const SP_URL = process.env.SUVEREN_AS_URL ?? 'https://www.suveren.ai';
const port = parseInt(process.env.SUVEREN_CP_PORT ?? '3402', 10);
const HAP_MODE = (process.env.HAP_MODE ?? 'personal') as 'personal' | 'team';

// UI dist path: in Docker it's /app/ui/dist, locally fall back to sibling
const UI_DIST = process.env.HAP_UI_DIST ?? join(import.meta.dirname ?? __dirname, '../../ui/dist');

// ─── Shared vault instance ───────────────────────────────────────────────

const vault = new Vault();

// ─── CP↔MCP shared secret (generated once per process start) ────────────
// In Docker, set SUVEREN_INTERNAL_SECRET env var so both containers share it.

const internalSecret = process.env.SUVEREN_INTERNAL_SECRET ?? randomBytes(32).toString('hex');
setInternalSecret(internalSecret);

const app = express();

// Only parse JSON on routes we handle directly — NOT on /api/* which is proxied.
// express.json() consumes the request body stream, which prevents
// http-proxy-middleware from forwarding POST/PUT bodies to the SP.
const jsonParser = express.json();

// ─── Rate limiting for login ─────────────────────────────────────────────

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 60_000; // 1 minute
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  }
  next();
}

// ─── Auth routes (/auth/*) ──────────────────────────────────────────────

app.use('/auth', jsonParser, createAuthRouter(vault, requireAuth(vault), loginRateLimit));

// ─── Origin helper (respects proxy headers) ─────────────────────────────

/** Resolve the public-facing origin, accounting for Vite dev proxy / reverse proxies. */
function resolveOrigin(req: Request): string {
  const fwdHost = req.get('x-forwarded-host');
  if (fwdHost) return `${req.protocol}://${fwdHost}`;
  // In dev, Vite's changeOrigin rewrites Host to the control-plane port.
  // Fall back to Referer which preserves the real browser origin.
  const referer = req.get('referer');
  if (referer) {
    try { return new URL(referer).origin; } catch { /* ignore */ }
  }
  return `${req.protocol}://${req.get('host')}`;
}

// ─── OAuth redirect URI storage (must match exactly between start/callback) ─

const oauthRedirectUris = new Map<string, string>();

// ─── Generic OAuth flow (driven by integration manifests) ───────────────

// Cache manifests in memory (refreshed on first OAuth request)
let manifestCache: Array<{
  id: string;
  oauth: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    credentialKeys: Record<string, string>;
    tokenStorage: string;
    extraParams?: Record<string, string>;
  } | null;
}> | null = null;

/** Extract the `email` claim from an OIDC id_token (unverified — display only). */
function decodeJwtEmail(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json) as { email?: string };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

async function getOAuthManifest(integrationId: string) {
  if (!manifestCache) {
    try {
      const data = await getManifests() as { manifests: typeof manifestCache };
      manifestCache = data.manifests;
    } catch {
      return null;
    }
  }
  return manifestCache?.find(m => m.id === integrationId && m.oauth) ?? null;
}

app.get('/auth/oauth/:integrationId/start', async (req: Request, res: Response) => {
  const { integrationId } = req.params;
  const manifest = await getOAuthManifest(integrationId);
  if (!manifest?.oauth) {
    res.status(404).json({ error: `No OAuth config found for integration "${integrationId}"` });
    return;
  }
  const creds = vault.getCredential(integrationId);
  const oauth = manifest.oauth;
  const clientIdKey = oauth.credentialKeys.clientId ?? 'clientId';
  const clientSecretKey = oauth.credentialKeys.clientSecret ?? 'clientSecret';
  if (!creds?.[clientIdKey] || !creds?.[clientSecretKey]) {
    res.status(400).json({ error: `${integrationId} OAuth credentials must be configured first` });
    return;
  }
  const redirectUri = `${resolveOrigin(req)}/auth/oauth/${integrationId}/callback`;
  // Store redirect URI so callback can use the exact same value
  oauthRedirectUris.set(integrationId, redirectUri);
  const params = new URLSearchParams({
    client_id: creds[clientIdKey],
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: oauth.scopes.join(' '),
    ...oauth.extraParams,
  });
  res.redirect(`${oauth.authUrl}?${params.toString()}`);
});

app.get('/auth/oauth/:integrationId/callback', async (req: Request, res: Response) => {
  const { integrationId } = req.params;
  const { code, error } = req.query;
  if (error || !code) {
    res.status(400).send(`<html><body><h2>Authorization failed</h2><p>${String(error || 'No authorization code received')}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    return;
  }
  const manifest = await getOAuthManifest(integrationId);
  if (!manifest?.oauth) {
    res.status(404).send('<html><body><h2>OAuth config not found</h2></body></html>');
    return;
  }
  const creds = vault.getCredential(integrationId);
  const oauth = manifest.oauth;
  const clientIdKey = oauth.credentialKeys.clientId ?? 'clientId';
  const clientSecretKey = oauth.credentialKeys.clientSecret ?? 'clientSecret';
  if (!creds?.[clientIdKey] || !creds?.[clientSecretKey]) {
    res.status(400).send('<html><body><h2>Credentials missing</h2></body></html>');
    return;
  }
  // Use the redirect URI stored during /start to ensure exact match
  const redirectUri = oauthRedirectUris.get(integrationId)
    ?? `${resolveOrigin(req)}/auth/oauth/${integrationId}/callback`;
  oauthRedirectUris.delete(integrationId);
  try {
    const tokenRes = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code as string,
        client_id: creds[clientIdKey],
        client_secret: creds[clientSecretKey],
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json() as { refresh_token?: string; access_token?: string; id_token?: string; error?: string };
    const tokenValue = tokens.refresh_token ?? tokens.access_token;
    if (tokens.error || !tokenValue) {
      res.status(400).send(`<html><body><h2>Token exchange failed</h2><p>${String(tokens.error || 'No token received')}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
      return;
    }
    // Capture the connected account (email from the OIDC id_token) + timestamp so
    // the Integrations UI can show *which* account is connected. Stored under
    // reserved `_oauth*` keys; the vault route exposes them as `meta`.
    const account = decodeJwtEmail(tokens.id_token);
    // Store token alongside existing credentials (refresh_token for Gmail, access_token for LinkedIn, etc.)
    const updatedCreds: Record<string, string> = {
      ...creds,
      [oauth.tokenStorage]: tokenValue,
      _oauthConnectedAt: new Date().toISOString(),
    };
    if (account) updatedCreds._oauthAccount = account;
    vault.setCredential(integrationId, updatedCreds);
    console.log(`[Control Plane] ${integrationId} OAuth tokens stored in vault`);

    // Push updated credentials to MCP server so integration can start
    try {
      await pushServiceCredentials(integrationId, updatedCreds);
      console.log(`[Control Plane] ${integrationId} credentials pushed to MCP`);
    } catch (err) {
      console.error(`[Control Plane] Failed to push ${integrationId} credentials to MCP:`, err);
    }

    res.send(`<html><body><h2>${manifest.id} connected successfully</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
  } catch (err) {
    console.error(`[Control Plane] ${integrationId} OAuth error:`, err);
    res.status(500).send('<html><body><h2>OAuth error</h2><p>See server logs</p></body></html>');
  }
});

// Backward compatibility: redirect old Gmail OAuth URLs to new generic handler
app.get('/auth/gmail/start', (_req: Request, res: Response) => {
  res.redirect('/auth/oauth/gmail/start');
});
app.get('/auth/gmail/callback', (req: Request, res: Response) => {
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  res.redirect(`/auth/oauth/gmail/callback${qs ? '?' + qs : ''}`);
});

// ─── Protected routes — require X-API-Key ────────────────────────────────

const authGuard = requireAuth(vault);

/**
 * Auth-health probe — the truthful "can this integration actually authenticate"
 * signal for the Integrations UI. For refresh-token integrations (Google
 * calendar/gmail) it attempts a real `refresh_token` grant against the
 * provider; an `invalid_grant`/error means the saved token is dead → the UI
 * shows Auth FAILED with a Reconnect action. The probe does not persist the new
 * access token, so it doesn't mutate stored credentials (Google doesn't rotate
 * the refresh token by default). Access-token-only integrations (LinkedIn)
 * can't be refresh-probed, so they report `unverified`.
 *
 * Returns: { status: 'ok'|'failed'|'not_connected'|'not_configured'|'unverified', error?, account? }
 */
app.get('/auth/oauth/:integrationId/health', authGuard, async (req: Request, res: Response) => {
  const integrationId = String(req.params.integrationId);
  const manifest = await getOAuthManifest(integrationId);
  if (!manifest?.oauth) { res.json({ status: 'not_configured' }); return; }
  const oauth = manifest.oauth;
  const creds = vault.getCredential(integrationId);
  const clientIdKey = oauth.credentialKeys.clientId ?? 'clientId';
  const clientSecretKey = oauth.credentialKeys.clientSecret ?? 'clientSecret';
  const account = creds?._oauthAccount;
  if (!creds?.[clientIdKey] || !creds?.[clientSecretKey]) { res.json({ status: 'not_configured', account }); return; }
  const token = creds[oauth.tokenStorage];
  if (!token) { res.json({ status: 'not_connected', account }); return; }

  // Only a refresh token can be probed. Access-token storage (e.g. LinkedIn)
  // has no refresh grant — report unverified rather than a false failure.
  if (!/refresh/i.test(oauth.tokenStorage)) { res.json({ status: 'unverified', account }); return; }

  try {
    const r = await fetch(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: creds[clientIdKey],
        client_secret: creds[clientSecretKey],
      }),
    });
    const body = await r.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
    if (r.ok && body.access_token) { res.json({ status: 'ok', account }); return; }
    res.json({ status: 'failed', account, error: body.error_description || body.error || `HTTP ${r.status}` });
  } catch (err) {
    res.json({ status: 'failed', account, error: err instanceof Error ? err.message : 'probe failed' });
  }
});

// SSE event stream — auth-guarded, long-lived connection
// /events is reached by EventSource which can't send custom headers — use the
// query-string variant of the auth middleware so the API key can ride in ?key=.
app.get('/events', requireAuthQueryOrHeader(vault), createEventsHandler());

// Vault routes
app.use('/vault', jsonParser, authGuard, createVaultRouter(vault));

// AI routes
app.use('/ai', jsonParser, authGuard, createAIRouter(vault));

// AI prompt overrides (Settings → Advanced)
app.use('/ai-prompts', jsonParser, authGuard, createAIPromptsRouter());

// MCP integration management routes
app.use('/mcp', jsonParser, authGuard, createMCPRouter());

// E2EE intent encryption (P5.5)
app.use('/api/encrypt-intent', jsonParser, authGuard, createEncryptIntentRouter());

// E2EE intent decryption (P6.4) — approver-side, uses vault private key
app.use('/api/decrypt-intent', jsonParser, authGuard, createDecryptIntentRouter(vault));

// Approved intents local store (P6.4) — approver accountability record
app.use('/api/approved-intents', jsonParser, authGuard, createApprovedIntentsRouter(vault));

/**
 * GET /integrations/:id/discover/:field — wizard-only resource discovery.
 *
 * Looks up the integration manifest's contextDiscovery[field] config, resolves
 * the integration's OAuth credentials from the vault, optionally exchanges a
 * refresh_token for an access_token, fetches the target service's endpoint,
 * and returns a normalized option list for the gate wizard to render as a
 * multi-select.
 *
 * Auth: session-authenticated (gateway owner). NOT agent-reachable — this is
 * a pre-auth helper for the wizard, not a gated tool.
 */
app.get('/integrations/:id/discover/:field', authGuard, async (req: Request, res: Response) => {
  const integrationId = req.params.id;
  const fieldName = req.params.field;
  try {
    // Locate manifest + discovery config
    const manifestsResp = (await getManifests()) as { manifests: Array<Record<string, unknown>> };
    const manifest = manifestsResp.manifests.find(m => m.id === integrationId);
    if (!manifest) {
      res.status(404).json({ error: `Unknown integration "${integrationId}"` });
      return;
    }
    const discovery = (manifest.contextDiscovery as Record<string, {
      baseUrl: string;
      endpoint: string;
      auth: 'bearer';
      credential?: string;
      responsePath: string;
      valueField: string;
      labelField: string;
      extraFields?: Record<string, string>;
    }> | undefined)?.[fieldName];
    if (!discovery) {
      res.status(404).json({ error: `No contextDiscovery declared for field "${fieldName}" on integration "${integrationId}"` });
      return;
    }

    // Resolve credentials from the vault
    const creds = vault.getCredential(integrationId);
    if (!creds) {
      res.status(400).json({ error: `Integration "${integrationId}" has no credentials in the vault — complete OAuth first.` });
      return;
    }
    const oauth = manifest.oauth as {
      tokenUrl: string;
      credentialKeys: Record<string, string>;
      tokenStorage: string;
    } | null;
    const credField = discovery.credential ?? oauth?.tokenStorage;
    const storedToken = credField ? creds[credField] : undefined;
    if (!storedToken) {
      res.status(400).json({ error: `Credential field "${credField}" not set on vault entry for "${integrationId}"` });
      return;
    }

    // Exchange refresh_token → access_token if this looks like a Google-style OAuth refresh flow.
    // Heuristic: if the manifest's tokenStorage matches credField and oauth is configured, assume
    // refresh and exchange. Callers that already hold a direct bearer can skip by declaring a
    // non-refresh credential field in contextDiscovery.credential.
    let accessToken = storedToken;
    if (oauth && credField === oauth.tokenStorage && oauth.tokenUrl) {
      const clientIdKey = oauth.credentialKeys?.clientId ?? 'clientId';
      const clientSecretKey = oauth.credentialKeys?.clientSecret ?? 'clientSecret';
      const tokRes = await fetch(oauth.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds[clientIdKey] ?? '',
          client_secret: creds[clientSecretKey] ?? '',
          refresh_token: storedToken,
          grant_type: 'refresh_token',
        }),
      });
      if (!tokRes.ok) {
        const body = await tokRes.text();
        res.status(502).json({ error: `OAuth refresh failed (${tokRes.status}): ${body}` });
        return;
      }
      const data = (await tokRes.json()) as { access_token?: string; error?: string };
      if (!data.access_token) {
        res.status(502).json({ error: `OAuth refresh returned no access_token: ${data.error ?? 'unknown'}` });
        return;
      }
      accessToken = data.access_token;
    }

    // Call the service endpoint
    const url = `${discovery.baseUrl.replace(/\/$/, '')}/${discovery.endpoint.replace(/^\//, '')}`;
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!apiRes.ok) {
      const body = await apiRes.text();
      res.status(502).json({ error: `Discovery call failed (${apiRes.status}): ${body.slice(0, 500)}` });
      return;
    }
    const payload = (await apiRes.json()) as unknown;

    // Extract array at responsePath (simple dotted path)
    let list: unknown = payload;
    for (const segment of discovery.responsePath.split('.').filter(Boolean)) {
      if (list && typeof list === 'object' && segment in (list as Record<string, unknown>)) {
        list = (list as Record<string, unknown>)[segment];
      } else {
        list = undefined;
        break;
      }
    }
    if (!Array.isArray(list)) {
      res.status(502).json({ error: `Discovery response did not contain an array at path "${discovery.responsePath}"` });
      return;
    }

    // Normalize items
    const options = list.map((raw) => {
      const item = raw as Record<string, unknown>;
      const extras: Record<string, unknown> = {};
      for (const [outKey, inKey] of Object.entries(discovery.extraFields ?? {})) {
        extras[outKey] = item[inKey];
      }
      return {
        value: item[discovery.valueField],
        label: item[discovery.labelField],
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      };
    });

    res.json({ options });
  } catch (err) {
    console.error(`[Control Plane] discover ${integrationId}/${fieldName} failed:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Discovery failed' });
  }
});

// Gate content retrieval — protected
app.get('/gate-content', authGuard, async (req: Request, res: Response) => {
  try {
    const path = req.query.path as string | undefined;
    const data = await getGateContent(path);
    res.json(data);
  } catch (err) {
    console.error('[Control Plane] Gate content retrieval error:', err);
    res.status(500).json({ error: 'Failed to fetch gate content from MCP server' });
  }
});

// Enriched active authorizations (with local context) — the UI uses this to
// detect structural scope overlap when creating a grant. Path is deliberately
// NOT `/authorizations` (that is the UI dashboard page route).
app.get('/active-authorizations', authGuard, async (_req: Request, res: Response) => {
  try {
    const data = await getEnrichedAuthorizations();
    res.json(data);
  } catch (err) {
    console.error('[Control Plane] Authorizations retrieval error:', err);
    res.status(500).json({ error: 'Failed to fetch authorizations from MCP server' });
  }
});

// Gate content forward — protected
app.post('/gate-content', jsonParser, authGuard, async (req: Request, res: Response) => {
  try {
    const { frameHash, boundsHash, contextHash, context, path, gateContent } = req.body as {
      frameHash?: string;
      boundsHash?: string;
      contextHash?: string;
      context?: Record<string, string | number>;
      path?: string;
      gateContent: Record<string, string>;
    };

    await pushGateContent({ frameHash, boundsHash, contextHash, context, path, gateContent });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Control Plane] Gate content forward error:', err);
    res.status(500).json({ error: 'Failed to forward gate content to MCP server' });
  }
});

// ─── Agent Brief (context.md + session-brief preview) ───────────────────
//
// User-authored standing orders for MCP-connecting agents. Plaintext on
// disk at $SUVEREN_DATA_DIR/context.md (default ~/.suveren/context.md) — see
// context-loader.ts in the MCP server.
//
// GET  /agent-brief/context   → { content: string }
// PUT  /agent-brief/context   (body: { content: string }) → { ok: true }
// GET  /agent-brief/preview   → { brief: string }

const AGENT_CONTEXT_MAX_BYTES = 16 * 1024; // 16 KB cap — plenty for standing orders.
const SUVEREN_DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

app.get('/agent-brief/context', authGuard, async (_req: Request, res: Response) => {
  try {
    const { readFileSync, existsSync: fileExists } = await import('node:fs');
    const filePath = join(SUVEREN_DATA_DIR, 'context.md');
    if (!fileExists(filePath)) {
      res.json({ content: '' });
      return;
    }
    const content = readFileSync(filePath, 'utf-8');
    res.json({ content });
  } catch (err) {
    console.error('[Control Plane] agent-brief/context GET failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read context' });
  }
});

app.put('/agent-brief/context', jsonParser, authGuard, async (req: Request, res: Response) => {
  try {
    const { content } = req.body as { content?: unknown };
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "content" string' });
      return;
    }
    if (Buffer.byteLength(content, 'utf-8') > AGENT_CONTEXT_MAX_BYTES) {
      res.status(413).json({ error: `Context exceeds ${AGENT_CONTEXT_MAX_BYTES}-byte cap` });
      return;
    }
    const { mkdirSync, writeFileSync, renameSync } = await import('node:fs');
    mkdirSync(SUVEREN_DATA_DIR, { recursive: true });
    // Atomic write: tmp + rename, so a crash mid-save can't leave a half-written
    // file that the MCP loader would then broadcast to every agent.
    const filePath = join(SUVEREN_DATA_DIR, 'context.md');
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Control Plane] agent-brief/context PUT failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to write context' });
  }
});

// ─── Proxy /api/* to hosted SP (AUTH-GUARDED) ───────────────────────────

// Auth guard for /api — runs first, rejects with 401 if unauthorized
app.use('/api', authGuard);

// Proxy /api/* to SP — mounted at root so http-proxy-middleware sees the full path
app.use(
  createProxyMiddleware({
    target: SP_URL,
    changeOrigin: true,
    pathFilter: '/api',
    on: {
      proxyReq: (proxyReq) => {
        // Inject server-side SP session cookie instead of forwarding browser cookies
        const cookie = vault.getSpCookie();
        if (cookie) {
          proxyReq.setHeader('Cookie', cookie);
        }
      },
      proxyRes: (proxyRes, req) => {
        // Emit bus events for mutating SP calls so SSE clients get push updates.
        // Only fire on successful (2xx) responses.
        const status = proxyRes.statusCode ?? 0;
        if (status < 200 || status >= 300) return;

        const method = (req as Request).method?.toUpperCase();
        const url = (req as Request).url ?? '';

        if (method !== 'POST' && method !== 'DELETE') return;

        // Normalise URL to just the path (strip query string)
        const path = url.split('?')[0];

        if (method === 'POST' && path === '/api/as/attest') {
          eventBus.emit('attestation-changed');
        } else if (method === 'POST' && /^\/api\/attestations\/[^/]+\/revoke$/.test(path)) {
          eventBus.emit('attestation-changed');
        } else if (method === 'POST' && path === '/api/proposals') {
          eventBus.emit('proposal-added');
        } else if (method === 'POST' && /^\/api\/proposals\/[^/]+\/resolve$/.test(path)) {
          eventBus.emit('proposal-resolved');
          // Nudge the MCP executor so an approval sends near-instantly instead of
          // waiting for the poll loop. Fire-and-forget; the poll is the fallback.
          void runCommittedProposals().catch(() => {});
        } else if (method === 'POST' && /^\/api\/proposals\/[^/]+\/approve$/.test(path)) {
          eventBus.emit('proposal-approved');
        } else if (method === 'POST' && /^\/api\/proposals\/[^/]+\/reject$/.test(path)) {
          eventBus.emit('proposal-rejected');
        } else if (
          method === 'POST' && (
            path === '/api/groups' ||
            path === '/api/groups/join' ||
            /^\/api\/groups\/[^/]+\/(leave|disable|reactivate|admin-transfer)$/.test(path)
          )
        ) {
          eventBus.emit('team-membership-changed');
        }
      },
    },
  }),
);

// ─── Health check (public) ──────────────────────────────────────────────

/** Detect how the gateway was started so the UI can show the right
 *  upgrade command. Docker → /.dockerenv exists. npm install -g →
 *  control-plane resolves from inside a node_modules/@suveren/gateway/
 *  subtree. Anything else (workspace dev) → 'dev'. */
function detectInstallMethod(): 'docker' | 'npm' | 'dev' {
  if (existsSync('/.dockerenv')) return 'docker';
  const dir = import.meta.dirname ?? __dirname;
  if (dir.includes('/node_modules/@suveren/gateway/')) return 'npm';
  return 'dev';
}
const INSTALL_METHOD = detectInstallMethod();

/** Read the bundle's package.json#version when running under npm so
 *  the update-checker can semver-compare against registry.npmjs.org.
 *  Under Docker, prefer HAP_BUILD_SHA (the git SHA stamped at image
 *  build) — the Docker image embeds the same bundle package.json, so
 *  falling back to it would surface the npm version "0.1.5" against
 *  the GHCR :sha tag and falsely report an update is available.
 *  Otherwise 'dev'. */
function detectRunningVersion(): string {
  if (INSTALL_METHOD === 'docker') {
    return process.env.HAP_BUILD_SHA ?? 'dev';
  }
  const dir = import.meta.dirname ?? __dirname;
  // npm install layout: dist/control-plane/index.mjs → bundle root is two up.
  const bundlePkg = join(dir, '..', '..', 'package.json');
  if (existsSync(bundlePkg)) {
    try {
      const pkg = JSON.parse(readFileSync(bundlePkg, 'utf8'));
      if (pkg.name === '@suveren/gateway' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      /* ignore */
    }
  }
  return process.env.HAP_BUILD_SHA ?? 'dev';
}
const RUNNING_VERSION = detectRunningVersion();

app.get('/health', async (req: Request, res: Response) => {
  // ?refresh=1 → force a GHCR re-check before responding. Used by the UI on
  // mount/login so a just-arrived user gets the true update state in the same
  // round-trip, without waiting for the next hourly background tick.
  if (req.query.refresh === '1') {
    await forceCheck();
  }
  const update = getUpdateStatus();
  res.json({
    status: 'ok',
    vaultUnlocked: vault.isUnlocked(),
    version: RUNNING_VERSION,
    latestVersion: update.latestVersion,
    updateAvailable: update.updateAvailable,
    installMethod: INSTALL_METHOD,
    spUrl: SP_URL,
    security: {
      note: 'Gateway secures tool execution. Agent host isolation is the user\'s responsibility.',
    },
  });
});

// ─── Serve built UI ────────────────────────────────────────────────────────

if (existsSync(UI_DIST)) {
  // Hashed assets (Vite fingerprints them) may cache; the app shell must NOT,
  // or a reload after an upgrade can be served a stale index.html pointing at
  // old asset filenames — defeating the auto-reload-on-update flow.
  app.use(express.static(UI_DIST, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
      }
    },
  }));

  // SPA fallback — serve index.html for unmatched routes (also never cached).
  app.get('*', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(join(UI_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'control-plane running',
      note: `UI not found at ${UI_DIST} — run 'pnpm build' first`,
    });
  });
}

app.listen(port, '0.0.0.0', () => {
  console.error(`[Control Plane] Listening on http://0.0.0.0:${port}`);
  console.error(`[Control Plane]   SP proxy: ${SP_URL}`);
  console.error(`[Control Plane]   UI dist:  ${UI_DIST}`);
  console.error(`[Control Plane]   Internal secret: configured`);
  console.error(`[Control Plane]   MCP server: ${MCP_BASE}`);
  // Startup self-check: fail LOUD if we can't load integration manifests from
  // the MCP server. Silent failure here (e.g. SUVEREN_MCP_INTERNAL_URL unset →
  // defaulting to the npm port :3430, which 403s) is what makes the UI show an
  // empty "No integrations" with no clue why.
  getManifests()
    .then((d) => {
      const n = (d as { manifests?: unknown[] })?.manifests?.length ?? 0;
      if (n === 0) {
        console.error(`[Control Plane] ⚠ MCP server at ${MCP_BASE} returned 0 integration manifests — wrong SUVEREN_MCP_INTERNAL_URL? (dev MCP is :3431, npm is :3430)`);
      } else {
        console.error(`[Control Plane]   Integrations: ${n} manifests loaded from ${MCP_BASE}`);
      }
    })
    .catch((err) => {
      console.error(`[Control Plane] ⚠ Could not reach MCP server at ${MCP_BASE} for manifests — wrong SUVEREN_MCP_INTERNAL_URL? (dev=:3431, npm=:3430). ${err instanceof Error ? err.message : err}`);
    });
  startUpdateChecker(INSTALL_METHOD, RUNNING_VERSION);
});
