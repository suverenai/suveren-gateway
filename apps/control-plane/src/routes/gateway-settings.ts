/**
 * GET/PUT /api/gateway-settings — local display preferences.
 *
 * Auth-guarded like the rest of /api. The response is always the persisted
 * state, never the request echoed back, so the UI can render backend truth
 * rather than assuming the write landed.
 */

import { Router } from 'express';
import { readSettings, writeSettings } from '../lib/gateway-settings';

export function createGatewaySettingsRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(readSettings());
  });

  router.put('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ('desktopNotifications' in body && typeof body.desktopNotifications !== 'boolean') {
      res.status(400).json({ error: 'desktopNotifications must be a boolean' });
      return;
    }
    try {
      // Unknown keys are dropped by writeSettings rather than persisted.
      const saved = writeSettings({
        desktopNotifications: body.desktopNotifications as boolean | undefined,
      });
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: `Could not save settings: ${(err as Error).message}` });
    }
  });

  return router;
}
