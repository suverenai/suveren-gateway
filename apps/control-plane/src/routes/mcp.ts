/**
 * MCP routes — proxy integration management to the MCP server.
 */

import { Router, type Request, type Response } from 'express';
import {
  getIntegrations,
  activateIntegration,
  getManifests,
  removeIntegration,
  getMcpHealth,
  getAgentContact,
} from '../lib/mcp-bridge';
import { eventBus } from '../lib/event-bus';

export function createMCPRouter(): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const data = await getMcpHealth();
      res.json(data);
    } catch {
      res.status(502).json({ error: 'MCP server unreachable' });
    }
  });

  router.get('/agent-contact', async (_req: Request, res: Response) => {
    try {
      res.json(await getAgentContact());
    } catch {
      res.status(502).json({ error: 'MCP server unreachable' });
    }
  });

  router.get('/integrations', async (_req: Request, res: Response) => {
    try {
      const data = await getIntegrations();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch integrations' });
    }
  });

  // There is deliberately no POST /integrations. It used to forward any
  // {command, args} from the request to the MCP server, which spawned it: an
  // API key was enough to run an arbitrary program on this machine (security
  // review 2026-11, finding A4). Nothing called it — the UI and every harness
  // start a connector with POST /integrations/:id/activate, which takes the
  // command from the shipped manifest and nothing from the request.
  router.post('/integrations', (_req: Request, res: Response) => {
    res.status(405).json({
      error: 'Connectors are started from their manifest: POST /mcp/integrations/<id>/activate',
    });
  });

  /**
   * GET /mcp/integrations/manifests — return all integration manifests for UI rendering.
   */
  router.get('/integrations/manifests', async (_req: Request, res: Response) => {
    try {
      const data = await getManifests();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch manifests' });
    }
  });

  /**
   * POST /mcp/integrations/:id/activate — activate an integration from its manifest.
   */
  router.post('/integrations/:id/activate', async (req: Request, res: Response) => {
    try {
      // Fetch manifests to find the one requested
      const manifestsData = await getManifests() as { manifests: Array<{ id: string; name: string; mcp: { command: string; args: string[] }; credentials: { envMapping: Record<string, string> }; profile: string; toolGating?: unknown }> };
      const manifest = manifestsData.manifests.find((m: { id: string }) => m.id === req.params.id);
      if (!manifest) {
        res.status(404).json({ error: `No manifest found for integration "${req.params.id}"` });
        return;
      }
      const data = await activateIntegration(manifest as Parameters<typeof activateIntegration>[0]);
      eventBus.emit('integration-changed');
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to activate integration' });
    }
  });

  router.delete('/integrations/:id', async (req: Request, res: Response) => {
    try {
      const data = await removeIntegration(req.params.id as string);
      eventBus.emit('integration-changed');
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remove integration' });
    }
  });

  return router;
}
