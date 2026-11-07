/**
 * GET/PUT /api/gateway-settings — local display preferences.
 *
 * Auth-guarded like the rest of /api. The response is always the persisted
 * state, never the request echoed back, so the UI can render backend truth
 * rather than assuming the write landed.
 */

import { Router } from 'express';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSettings, writeSettings } from '../lib/gateway-settings';

export function createGatewaySettingsRouter(dataDir?: string): Router {
  const router = Router();

  // The data folder this running control plane actually uses (resolved at
  // startup: IT policy > env > saved install setting > default). Read-only.
  router.get('/data-folder', (_req, res) => {
    res.json({ dataDir: resolve(dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren')) });
  });

  router.get('/', (_req, res) => {
    res.json(readSettings(dataDir));
  });

  router.put('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ('desktopNotifications' in body && typeof body.desktopNotifications !== 'boolean') {
      res.status(400).json({ error: 'desktopNotifications must be a boolean' });
      return;
    }
    if ('openApprovalsAutomatically' in body && typeof body.openApprovalsAutomatically !== 'boolean') {
      res.status(400).json({ error: 'openApprovalsAutomatically must be a boolean' });
      return;
    }
    try {
      // Unknown keys are dropped by writeSettings rather than persisted.
      const saved = writeSettings({
        desktopNotifications: body.desktopNotifications as boolean | undefined,
        openApprovalsAutomatically: body.openApprovalsAutomatically as boolean | undefined,
      }, dataDir);
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: `Could not save settings: ${(err as Error).message}` });
    }
  });

  return router;
}
