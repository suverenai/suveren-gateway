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
import {
  credentialsToPush, parseGroupCredentialName, getGroup, groupOfMember, groupCredentialName,
  effectiveCredentials, withoutSignIn,
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

export function createVaultRouter(vault: Vault): Router {
  const router = Router();

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
    if (groupId) {
      const group = getGroup(manifests, groupId);
      if (!group) {
        res.status(404).json({ error: `Unknown sign-in group "${groupId}"` });
        return;
      }
      const prior = vault.getCredential(name);
      const keys = group.members[0].oauth!.credentialKeys;
      const changed = Object.values(keys).some(k => prior?.[k] !== undefined && incoming[k] !== undefined && prior[k] !== incoming[k]);
      if (changed) fields = withoutSignIn(fields, group.members[0].oauth!); // keeps the client just saved
    }

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

    res.json({ ok: true });
  });

  /**
   * DELETE /vault/credentials/:name
   */
  router.delete('/credentials/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
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
  router.delete('/services/:id', (req: Request, res: Response) => {
    const { id } = req.params;
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
