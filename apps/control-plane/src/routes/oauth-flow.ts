/**
 * OAuth sign-in routes: start, callback and sign-out of a connector's account.
 * Moved out of index.ts unchanged except for the guards on a vault that has an
 * unlock password (see `deps.startGuard`, `deps.gate`); on a gateway without
 * one every route behaves as before.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import type { OAuthStateStore } from '../lib/oauth-state';
import type { LoginChangeGate } from '../lib/change-confirmation';
import { confirmationRequired } from '../lib/change-confirmation';
import { SESSION_COOKIE, parseCookie } from '../lib/page-session';
import type { OAuthStartTickets } from '../lib/oauth-start-ticket';
import { pageSessionCookieVerdict, type PageSessionDeps } from '../middleware/auth';
import { oauthResultPage } from '../lib/html-escape';
import { pushServiceCredentials } from '../lib/mcp-bridge';
import {
  groupOfMember, unionScopes, oauthApplies, withoutSignIn, resolveGroupClient,
  groupCredentialName, retireMemberSignIns, revokeTokens, storedSignInEntries, type OAuthLike,
} from '../lib/sign-in-group';

export interface OAuthManifestEntry {
  id: string;
  simulation?: { field: string; default: string } | null;
  adapterField?: string;
  oauth: {
    authUrl: string;
    tokenUrl: string;
    revokeUrl?: string;
    scopes: string[];
    credentialKeys: Record<string, string>;
    tokenStorage: string;
    extraParams?: Record<string, string>;
    signInGroup?: { id: string; name: string };
    forOption?: { mode: string; adapter?: string };
    healthCheck?: { url: string; accountFields?: string[] };
  } | null;
}

export interface OAuthFlowDeps {
  vault: Vault;
  oauthStates: OAuthStateStore;
  getOAuthManifest: (integrationId: string) => Promise<OAuthManifestEntry | null>;
  manifestCache: () => OAuthManifestEntry[] | null;
  resolveOrigin: (req: Request) => string;
  pushEffective: (name: string, list: unknown) => Promise<void>;
  /** Guards a sign-out. */
  authGuard: (req: Request, res: Response, next: NextFunction) => void;
  gate: LoginChangeGate;
  /** Page session, for /start on a vault with a password (it carries a ticket and the cookie, not the header). */
  pageSession: PageSessionDeps;
  tickets: OAuthStartTickets;
  /** Clock, for the 300 s between a confirmation and its callback. */
  now?: () => number;
}

/** The callback must arrive this soon after the confirmation it rests on. */
export const CALLBACK_WINDOW_MS = 300_000;

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

export function createOAuthFlowRouter(deps: OAuthFlowDeps): Router {
  const { vault } = deps;
  const router = Router();

  const now = deps.now ?? Date.now;

  /**
   * What touching this connector's sign-in replaces or removes: its group's
   * token and every member's own stored sign-in (the group callback retires all
   * of them), or just its own. A confirmation covers exactly this, by hash.
   */
  const signInChange = (integrationId: string, op: 'sign-in' | 'disconnect') => {
    let replaces: string[];
    let groupId: string | null = null;
    try {
      const group = groupOfMember(deps.manifestCache(), integrationId);
      groupId = group?.id ?? null;
      const get = (n: string) => vault.getCredential(n);
      const manifestOauth = (deps.manifestCache() ?? []).find(m => m.id === integrationId)?.oauth;
      replaces = group
        ? storedSignInEntries(group, get)
        : manifestOauth && get(integrationId)?.[manifestOauth.tokenStorage] ? [integrationId] : [];
    } catch { replaces = ['unreadable']; } // unreadable: treat as present
    return { route: 'oauth', op, integration: integrationId, group: groupId, replaces };
  };

  const sessionIdOf = (req: Request): string | null => deps.pageSession.sessions.idOf(parseCookie(req.headers.cookie, SESSION_COOKIE));

  /** What exactly signing in again, or signing out, would replace: the page confirms THIS. */
  router.get('/auth/oauth/:integrationId/change', deps.authGuard, (req: Request, res: Response) => {
    const op = req.query.op === 'disconnect' ? 'disconnect' : 'sign-in';
    res.json({ change: signInChange(String(req.params.integrationId), op) });
  });

  /**
   * Password vault: the page asks, WITH its header token, for a one-time ticket
   * to open /start in a new window (which cannot send the header). Over a stored
   * sign-in the ticket needs the confirmation of that exact change first.
   */
  router.post('/auth/oauth/:integrationId/start-ticket', deps.authGuard, (req: Request, res: Response) => {
    const integrationId = String(req.params.integrationId);
    if (!vault.hasPassword()) { res.json({ url: `/auth/oauth/${integrationId}/start` }); return; }
    const change = signInChange(integrationId, 'sign-in');
    let confirmedAt: number | undefined;
    if (change.replaces.length > 0) {
      if (!deps.gate.allow(req, 'replace', integrationId, change)) {
        res.status(403).json(confirmationRequired('replace', integrationId));
        return;
      }
      confirmedAt = now();
    }
    const sessionId = sessionIdOf(req);
    if (!sessionId) { res.status(401).json({ error: 'Unauthorized', code: 'session_missing' }); return; }
    const ticket = deps.tickets.issue(sessionId, integrationId, { confirmedAt, replaces: change.replaces });
    res.json({ url: `/auth/oauth/${integrationId}/start?ticket=${ticket}` });
  });

router.get('/auth/oauth/:integrationId/start', async (req: Request, res: Response) => {
  const { integrationId } = req.params;
  // Password vault: the session cookie and a ticket the page got with its header
  // token. Neither alone is enough; a cross-site request has neither.
  let ticket: { confirmedAt?: number; replaces?: string[] } | null = null;
  if (vault.hasPassword()) {
    const v = pageSessionCookieVerdict(vault, deps.pageSession, req);
    if (!v.ok) { res.status(v.status).json({ error: 'Unauthorized', code: v.code }); return; }
    ticket = deps.tickets.consume(req.query.ticket, sessionIdOf(req), integrationId);
    if (!ticket) { res.status(403).json({ error: 'ticket_required', code: 'ticket_required', message: 'Refused.' }); return; }
  }
  const manifest = await deps.getOAuthManifest(integrationId);
  if (!manifest?.oauth) {
    res.status(404).json({ error: `No OAuth config found for integration "${integrationId}"` });
    return;
  }
  const oauth = manifest.oauth;
  // A sign-in scoped to one data-source option (oauth.forOption) is refused while another option is saved.
  if (!oauthApplies(manifest, vault.getCredential(integrationId))) {
    res.status(409).json({ error: `Sign-in is not used by the data source chosen for ${integrationId}` });
    return;
  }
  // A member of a shared sign-in group signs the WHOLE group in: the union of
  // the members' scopes, one token. The redirect URI stays this connector's own
  // (/auth/oauth/<id>/callback) so no URI has to be added at the provider.
  const group = groupOfMember(deps.manifestCache(), integrationId);
  const clientIdKey = oauth.credentialKeys.clientId ?? 'clientId';
  const clientSecretKey = oauth.credentialKeys.clientSecret ?? 'clientSecret';
  let clientId: string | undefined;
  if (group) {
    clientId = resolveGroupClient(group, integrationId, vault.getCredential(groupCredentialName(group.id)), id => vault.getCredential(id))?.clientId;
  } else {
    const creds = vault.getCredential(integrationId);
    clientId = creds?.[clientIdKey] && creds?.[clientSecretKey] ? creds[clientIdKey] : undefined;
  }
  if (!clientId) {
    res.status(400).json({ error: `${integrationId} OAuth credentials must be configured first` });
    return;
  }
  const redirectUri = `${deps.resolveOrigin(req)}/auth/oauth/${integrationId}/callback`;
  // The callback is accepted only with this state, once, for this connector.
  const state = deps.oauthStates.issue({
    integrationId, redirectUri,
    ...(ticket?.confirmedAt !== undefined ? { confirmedAt: ticket.confirmedAt, replaces: ticket.replaces ?? [] } : {}),
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: (group ? unionScopes(group, id => vault.getCredential(id)) : oauth.scopes).join(' '),
    ...oauth.extraParams,
    // After extraParams: a manifest cannot replace it.
    state,
  });
  res.redirect(`${oauth.authUrl}?${params.toString()}`);
});

router.get('/auth/oauth/:integrationId/callback', async (req: Request, res: Response) => {
  const { integrationId } = req.params;
  const { code, error, state } = req.query;
  // First: was this sign-in started here, for this connector, moments ago?
  // Without that, any page could hand the browser a code for the ATTACKER's
  // account and the gateway would store its token. The state is spent now,
  // whatever happens next.
  const started = deps.oauthStates.consume(state, integrationId);
  if (!started) {
    res.status(400).send(oauthResultPage(
      'Sign-in not accepted',
      'This sign-in was not started from this gateway, or it took too long. Start it again from the Integrations page.',
    ));
    return;
  }
  if (error || !code) {
    res.status(400).send(oauthResultPage('Authorization failed', String(error || 'No authorization code received'), 3000));
    return;
  }
  const manifest = await deps.getOAuthManifest(integrationId);
  if (!manifest?.oauth) {
    res.status(404).send(oauthResultPage('OAuth config not found'));
    return;
  }
  const oauth = manifest.oauth;
  // The callback arrives from the provider's site, without the page session, so
  // the confirmation was taken at /start and travels in the state. It holds for
  // 300 seconds, and only for what it covered: a stored sign-in it did not
  // cover (one that appeared since) is not overwritten.
  if (vault.hasPassword()) {
    const covered = started.replaces ?? [];
    const nowStored = signInChange(integrationId, 'sign-in').replaces;
    const unconfirmed = nowStored.some(n => !covered.includes(n));
    const stale = started.confirmedAt !== undefined && now() - started.confirmedAt > CALLBACK_WINDOW_MS;
    if (unconfirmed || stale) {
      res.status(403).send(oauthResultPage('Sign-in not accepted', 'Confirmation needed.'));
      return;
    }
  }
  const clientIdKey = oauth.credentialKeys.clientId ?? 'clientId';
  const clientSecretKey = oauth.credentialKeys.clientSecret ?? 'clientSecret';
  const group = groupOfMember(deps.manifestCache(), integrationId);
  // Group: the client that /start used (group entry, else a member's own).
  // Single connector: its own entry, as before.
  let creds: Record<string, string> | null = vault.getCredential(integrationId);
  if (group) {
    const c = resolveGroupClient(group, integrationId, vault.getCredential(groupCredentialName(group.id)), id => vault.getCredential(id));
    creds = c ? { [clientIdKey]: c.clientId, [clientSecretKey]: c.clientSecret } : null;
  }
  if (!creds?.[clientIdKey] || !creds?.[clientSecretKey]) {
    res.status(400).send(oauthResultPage('Credentials missing'));
    return;
  }
  // The redirect URI /start sent: the token exchange must repeat it exactly.
  const redirectUri = started.redirectUri;
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
    const tokens = await tokenRes.json() as { refresh_token?: string; access_token?: string; id_token?: string; scope?: string; error?: string };
    const tokenValue = tokens.refresh_token ?? tokens.access_token;
    if (tokens.error || !tokenValue) {
      res.status(400).send(oauthResultPage('Token exchange failed', String(tokens.error || 'No token received'), 3000));
      return;
    }
    // Capture the connected account (email from the OIDC id_token) + timestamp so
    // the Integrations UI can show *which* account is connected. Stored under
    // reserved `_oauth*` keys; the vault route exposes them as `meta`.
    const account = decodeJwtEmail(tokens.id_token);
    if (group) {
      // ONE token for the group, written once. Members' own entries are left
      // untouched (their old tokens stay valid until sign-out); the group entry
      // is laid over them when pushed.
      const groupName = groupCredentialName(group.id);
      const groupCreds: Record<string, string> = {
        ...(vault.getCredential(groupName) ?? {}),
        [clientIdKey]: creds[clientIdKey],
        [clientSecretKey]: creds[clientSecretKey],
        [oauth.tokenStorage]: tokenValue,
        _oauthConnectedAt: new Date().toISOString(),
      };
      if (account) groupCreds._oauthAccount = account;
      // What the provider actually granted (it may be fewer than requested).
      if (tokens.scope) groupCreds._oauthScopes = tokens.scope;
      vault.setCredential(groupName, groupCreds);
      console.log(`[Control Plane] sign-in group ${group.id} OAuth tokens stored in vault`);
      // Only now, with the group token safely stored: the members' old
      // per-connector tokens are retired (a failed sign-in never gets here).
      const retired = retireMemberSignIns(group, n => vault.getCredential(n), (n, c) => vault.setCredential(n, c));
      if (retired.length) console.log(`[Control Plane] retired own sign-in of: ${retired.join(', ')}`);
      await deps.pushEffective(groupName, deps.manifestCache());
    } else {
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
    }

    res.send(oauthResultPage(`${group ? group.name : manifest.id} connected successfully`, 'You can close this window.', 2000));
  } catch (err) {
    console.error(`[Control Plane] ${integrationId} OAuth error:`, err);
    res.status(500).send(oauthResultPage('OAuth error', 'See server logs'));
  }
});

/**
 * Sign out of a connector's OAuth account. For a member of a shared sign-in
 * group it signs out the WHOLE group: the group's token and metadata are
 * removed, and so is every member's own legacy token - otherwise the old
 * per-connector tokens (kept valid for migration) would silently take over
 * again. OAuth client settings (id + secret) are kept so signing in again needs
 * no re-entry. The running connector(s) lose their token and stop.
 * Not revoked at the provider (no revocation URL is declared in manifests).
 */
router.post('/auth/oauth/:integrationId/disconnect', deps.authGuard, async (req: Request, res: Response) => {
  const integrationId = String(req.params.integrationId);
  const manifest = await deps.getOAuthManifest(integrationId);
  if (!manifest?.oauth) { res.status(404).json({ error: `No OAuth config found for integration "${integrationId}"` }); return; }
  // Before anything is revoked or removed: on a vault with a password a sign-out
  // is a removal of a connector login.
  if (vault.hasPassword() && !deps.gate.allow(req, 'remove', integrationId, signInChange(integrationId, 'disconnect'))) {
    res.status(403).json(confirmationRequired('remove', integrationId));
    return;
  }
  const group = groupOfMember(deps.manifestCache(), integrationId);
  const targets = group ? group.members : [manifest as { id: string; oauth: OAuthLike }];
  try {
    // Revoke at the provider FIRST (needs the tokens), best-effort: a refusal is
    // reported in the response, and the local sign-out happens regardless.
    const tokens: Array<{ target: string; token: string }> = [];
    if (group) {
      const g = vault.getCredential(groupCredentialName(group.id));
      if (g?.[manifest.oauth.tokenStorage]) tokens.push({ target: `group:${group.id}`, token: g[manifest.oauth.tokenStorage] });
    }
    for (const t of targets) {
      const own = vault.getCredential(t.id);
      if (own?.[t.oauth!.tokenStorage]) tokens.push({ target: t.id, token: own[t.oauth!.tokenStorage] });
    }
    const revocation = await revokeTokens(manifest.oauth.revokeUrl, tokens);
    if (group) {
      const gname = groupCredentialName(group.id);
      const gcred = vault.getCredential(gname);
      if (gcred) vault.setCredential(gname, withoutSignIn(gcred, manifest.oauth));
    }
    for (const t of targets) {
      const own = vault.getCredential(t.id);
      if (own) vault.setCredential(t.id, withoutSignIn(own, t.oauth!));
    }
    // Push explicitly (even an empty set): a member with no entry of its own
    // would otherwise keep running on the credentials pushed before sign-out.
    for (const t of targets) await pushServiceCredentials(t.id, vault.getCredential(t.id) ?? {});
    res.json({
      ok: true,
      signedOut: targets.map(t => t.id),
      // revoked: every distinct token was revoked at the provider. Local
      // sign-out is done either way; `revocation` names what was refused.
      revoked: revocation.length > 0 && revocation.every(r => r.ok),
      revocation,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Sign-out failed' });
  }
});

  return router;
}

