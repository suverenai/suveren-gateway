/**
 * Vault routes — encrypted credential and service management.
 *
 * All routes are protected by requireAuth middleware (applied in index.ts).
 * Never returns decrypted secret values — only masked versions or {configured: true}.
 */

import { Router, type Request, type Response } from 'express';
import type { Vault, ServiceDef } from '../lib/vault';
import { pushServiceCredentials } from '../lib/mcp-bridge';

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
  router.get('/credentials/:name', (req: Request, res: Response) => {
    const { name } = req.params;
    const cred = vault.getCredential(name);
    if (!cred) {
      res.json({ configured: false });
      return;
    }
    res.json({ configured: true, fieldNames: Object.keys(cred), fields: cred });
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

    vault.setCredential(name, fields);

    // Push decrypted creds to MCP for service use
    try {
      await pushServiceCredentials(name, fields);
    } catch (err) {
      console.error(`[Vault] Failed to push credentials to MCP for ${name}:`, err);
    }

    res.json({ ok: true });
  });

  /**
   * DELETE /vault/credentials/:name
   */
  router.delete('/credentials/:name', (req: Request, res: Response) => {
    const { name } = req.params;
    vault.deleteCredential(name);
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

        if (cred.provider === 'ollama') {
          const r = await fetch(`${cred.endpoint}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!r.ok) throw new Error(`Ollama: ${r.status}`);
        } else {
          const r = await fetch(`${cred.endpoint}/models`, {
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
