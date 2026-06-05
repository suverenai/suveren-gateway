/**
 * MCP routes — proxy integration management to the MCP server.
 */

import { Router, type Request, type Response } from 'express';
import {
  getIntegrations,
  addIntegration,
  activateIntegration,
  getManifests,
  removeIntegration,
  getMcpHealth,
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

  router.get('/integrations', async (_req: Request, res: Response) => {
    try {
      const data = await getIntegrations();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch integrations' });
    }
  });

  router.post('/integrations', async (req: Request, res: Response) => {
    try {
      const data = await addIntegration(req.body);
      eventBus.emit('integration-changed');
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add integration' });
    }
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
