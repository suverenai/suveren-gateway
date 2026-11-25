/**
 * Vault routes — encrypted credential and service management.
 *
 * All routes are protected by requireAuth middleware (applied in index.ts).
 *
 * Secret values never leave this process. GET returns declared-`text` fields
 * as values and everything else as recognition hints (see credential-meta.ts).
 * This claim used to be false — the old GET returned every decrypted field and
 * the "masking" was CSS in the browser.
 */

import { Router, type Request, type Response } from 'express';
import type { Vault, ServiceDef } from '../lib/vault';
import { getManifests, pushServiceCredentials } from '../lib/mcp-bridge';
import { credentialView, textFieldsFor, META_KEY } from '../lib/credential-meta';
import { proxiedFetch } from '../lib/proxied-fetch';
import { type LoginChangeGate, type ChangeKind, confirmationRequired } from '../lib/change-confirmation';
import {
  credentialsToPush, parseGroupCredentialName, getGroup, groupOfMember, groupCredentialName,
  effectiveCredentials, withoutSignIn, changesGroupClient, storedSignInEntries,
} from '../lib/sign-in-group';

/**
 * Manifests decide which credential fields are `text` (returned as values)
 * versus secret (returned as hints). They come from the MCP server and change
 * only on install/uninstall — a short cache keeps the settings page from
 * costing an internal round-trip per card, and an UNREACHABLE MCP degrades to
 * "no manifest" = every field secret, never to leaking.
 */
let manifestCache: { at: number; value: unknown } | null = null;
async function cachedManifests(): Promise<unknown> {
  if (manifestCache && Date.now() - manifestCache.at < 60_000) return manifestCache.value;
  try {
    const m = await getManifests();
    manifestCache = { at: Date.now(), value: (m as { manifests?: unknown })?.manifests ?? m };
  } catch {
    manifestCache = { at: Date.now(), value: [] };
  }
  return manifestCache.value;
}

/**
 * `gate` decides whether a stored login may be replaced or removed. Without a
 * password on the vault it is not consulted (today's behaviour). With one, a
 * missing gate refuses every such change. It is asked where the write really
 * happens, not by looking at the URL: a first entry needs nothing (DEC-44), a
 * replacement or removal needs a confirmation of exactly that change.
 */
export function createVaultRouter(vault: Vault, gate?: LoginChangeGate): Router {
  const router = Router();

  /**
   * Is a login stored under this name? For a sign-in group's entry, also: does
   * any member still hold its own stored sign-in? The group entry is laid over
   * the members' (effectiveCredentials) and a group sign-in retires theirs, so
   * writing it replaces them. Unreadable counts as present.
   */
  const storedLoginExists = async (name: string): Promise<boolean> => {
    try {
      if (vault.getCredential(name) !== null) return true;
      const groupId = parseGroupCredentialName(name);
      if (!groupId) return false;
      const group = getGroup(await cachedManifests(), groupId);
      return Boolean(group && storedSignInEntries(group, n => vault.getCredential(n)).length > 0);
    } catch { return true; }
  };
  /**
   * True if the change may go ahead; otherwise the refusal has been sent.
   * `change` names the route and the operation as well as the data: a
   * confirmation for one (a merge into credentials) is not one for another
   * (a replace through services, or a delete).
   */
  const allowed = async (req: Request, res: Response, kind: ChangeKind, name: string, change: unknown): Promise<boolean> => {
    if (!vault.hasPassword()) return true;
    if (!(await storedLoginExists(name))) return true; // a first entry
    if (gate?.allow(req, kind, name, change)) return true;
    res.status(403).json(confirmationRequired(kind, name));
    return false;
  };

  /**
   * GET /vault/status
   */
  router.get('/status', (_req: Request, res: Response) => {
    const credNames = vault.listCredentials();
    const services = vault.listServices();
    res.json({
      initialized: vault.isUnlocked(),
      credentialNames: credNames,
      serviceCount: services.length,
    });
  });

  /**
   * GET /vault/credentials/:name
   * Returns { configured: true, fieldNames: [...] } — never the actual values.
   */
  router.get('/credentials/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
    const manifests = await cachedManifests();
    // A member of a shared sign-in group is shown as it runs: its own entry
    // with the group's sign-in laid over it (so "connected" is true for every
    // member after one sign-in).
    let cred = vault.getCredential(name);
    const g = groupOfMember(manifests, name);
    if (g) {
      const m = g.members.find(x => x.id === name)!;
      cred = effectiveCredentials(cred, vault.getCredential(groupCredentialName(g.id)), m.oauth);
    }
    if (!cred) {
      res.json({ configured: false });
      return;
    }
    // Metadata by default: declared-text fields as values, everything else as
    // recognition hints (prefix + last 4, nothing at all for short secrets).
    // The full value exists only inside the gateway; there is deliberately no
    // endpoint that returns it.
    res.json(credentialView(cred, textFieldsFor(name, manifests)));
  });

  /**
   * PUT /vault/credentials/:name
   * Body: { field1: "value1", field2: "value2", ... }
   */
  router.put('/credentials/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
    const incoming = req.body as Record<string, string>;

    // Merge, don't replace: secret fields (API keys, PATs) are masked in the UI
    // and can't be read back, so an edit that only changes non-secret fields
    // (e.g. the AI model) omits the secret. A blind replace would silently wipe
    // it — the exact "AI configured but 401" trap. Preserve any stored field the
    // caller didn't send; a caller can still clear a field by sending "".
    let fields = incoming;
    try {
      const existing = vault.getCredential(name);
      if (existing) fields = { ...existing, ...incoming };
    } catch {
      // Vault locked / not decryptable — fall back to the incoming payload as-is
      // (setCredential below will surface any real failure).
    }

    // Write-time metadata, stored inside the blob under a reserved key. It is
    // what lets the UI say "added Aug 1" next to a hint — often the only way
    // to tell two rotations of the same secret apart. Never client-supplied.
    fields = { ...fields, [META_KEY]: new Date().toISOString() };

    // A shared sign-in's token is bound to the OAuth client that issued it.
    // Saving a different client id/secret for the group drops its token (and
    // metadata): the person signs in again with the new client. Members fall
    // back to their own entries, which are untouched.
    const manifests = await cachedManifests();
    const groupId = parseGroupCredentialName(name);
    let signsOut = false;
    if (groupId) {
      const group = getGroup(manifests, groupId);
      if (!group) {
        res.status(404).json({ error: `Unknown sign-in group "${groupId}"` });
        return;
      }
      signsOut = changesGroupClient(group, vault.getCredential(name), incoming);
      // Dry run: tell the UI what saving WOULD do, change nothing. The UI asks
      // before it saves a changed client.
      if (req.query.dryRun === '1' || req.query.dryRun === 'true') {
        res.json({ ok: true, dryRun: true, signsOut, members: group.members.map(m => m.id) });
        return;
      }
      if (signsOut) fields = withoutSignIn(fields, group.members[0].oauth!); // keeps the client just saved
    }

    if (!(await allowed(req, res, 'replace', name, { route: 'credentials', op: 'put-merge', fields: incoming }))) return;
    vault.setCredential(name, fields);

    // Push decrypted creds to MCP for service use (group overlay applied; a
    // group entry fans out to its members)
    for (const [id, creds] of credentialsToPush(name, manifests, n => vault.getCredential(n))) {
      try {
        await pushServiceCredentials(id, creds);
      } catch (err) {
        console.error(`[Vault] Failed to push credentials to MCP for ${id}:`, err);
      }
    }

    res.json(groupId ? { ok: true, signedOut: signsOut } : { ok: true });
  });

  /**
   * DELETE /vault/credentials/:name
   */
  router.delete('/credentials/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
    if (!(await allowed(req, res, 'remove', name, { route: 'credentials', op: 'delete' }))) return;
    vault.deleteCredential(name);
    // Deleting a sign-in group's entry returns its members to their own
    // entries: push what they now run on.
    if (parseGroupCredentialName(name)) {
      for (const [id, creds] of credentialsToPush(name, await cachedManifests(), n => vault.getCredential(n))) {
        try { await pushServiceCredentials(id, creds); } catch (err) {
          console.error(`[Vault] Failed to push credentials to MCP for ${id}:`, err);
        }
      }
    }
    res.json({ ok: true });
  });

  /**
   * GET /vault/services
   * Returns all services (built-in + user-added). No secret values.
   */
  router.get('/services', (_req: Request, res: Response) => {
    const services = vault.listServices();
    const credNames = vault.listCredentials();

    const result = services.map(svc => ({
      ...svc,
      encryptedFields: undefined, // strip encrypted data
      status: credNames.includes(svc.id) ? 'connected' : 'missing',
    }));

    res.json({ services: result });
  });

  /**
   * PUT /vault/services/:id
   * Body: { name, description, icon?, tools?, profile?, credFields, credentials? }
   */
  router.put('/services/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { credentials, ...serviceDef } = req.body as ServiceDef & { credentials?: Record<string, string> };

    const hasCredentials = Boolean(credentials && Object.keys(credentials).length > 0);
    // Before anything is written: a refused request changes nothing.
    if (hasCredentials && !(await allowed(req, res, 'replace', id, { route: 'services', op: 'put-replace', credentials }))) return;
    vault.setService(id, { ...serviceDef, id });

    // If credentials provided, encrypt and store them too
    if (credentials && Object.keys(credentials).length > 0) {
      vault.setCredential(id, credentials);
      try {
        await pushServiceCredentials(id, credentials);
      } catch (err) {
        console.error(`[Vault] Failed to push service credentials to MCP for ${id}:`, err);
      }
    }

    res.json({ ok: true });
  });

  /**
   * DELETE /vault/services/:id
   */
  router.delete('/services/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!(await allowed(req, res, 'remove', id, { route: 'services', op: 'delete' }))) return;
    vault.deleteService(id);
    vault.deleteCredential(id);
    res.json({ ok: true });
  });

  /**
   * POST /vault/test/:name
   * Tests credential connectivity server-side (uses decrypted creds).
   */
  router.post('/test/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
    const cred = vault.getCredential(name);
    if (!cred) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    // Basic connectivity test based on credential type
    try {
      if (name === 'github-pat' && cred.pat) {
        const ghRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${cred.pat}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!ghRes.ok) throw new Error(`GitHub API: ${ghRes.status}`);
        const user = await ghRes.json() as { login: string };
        res.json({ ok: true, message: `Authenticated as ${user.login}` });
        return;
      }

      if (name === 'ai-config' && cred.endpoint) {
        const headers: Record<string, string> = {};
        if (cred.apiKey) headers['Authorization'] = `Bearer ${cred.apiKey}`;

        // proxiedFetch (not a bare fetch): the same "Test connection" check
        // ai-client.ts's own connectivity probes use — a remote provider
        // behind a corporate proxy must pass this check the same way actual
        // chat calls do; a local Ollama (loopback) is never proxied either way.
        if (cred.provider === 'ollama') {
          const r = await proxiedFetch(`${cred.endpoint}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!r.ok) throw new Error(`Ollama: ${r.status}`);
        } else {
          const r = await proxiedFetch(`${cred.endpoint}/models`, {
            headers,
            signal: AbortSignal.timeout(3000),
          });
          if (!r.ok) throw new Error(`AI provider: ${r.status}`);
        }
        res.json({ ok: true, message: 'AI provider is reachable' });
        return;
      }

      // Generic: just report that credential exists
      res.json({ ok: true, message: `Credential "${name}" is configured with ${Object.keys(cred).length} field(s)` });
    } catch (err) {
      res.json({ ok: false, message: err instanceof Error ? err.message : 'Connection test failed' });
    }
  });

  return router;
}
