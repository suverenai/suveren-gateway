/**
 * /api/archived-mandates — the local "archived" display flag for mandates.
 *
 *   GET    /           → { archived: string[] }
 *   PUT    /:id        → archive,   returns { archived: string[] }
 *   DELETE /:id        → unarchive, returns { archived: string[] }
 *
 * Auth-guarded like the rest of /api. Every response is the persisted list,
 * never the request echoed back, so the UI renders backend truth.
 * Archiving deletes nothing — see lib/archived-mandates-store.ts.
 */

import { Router } from 'express';
import {
  readArchived,
  archiveMandate,
  unarchiveMandate,
  isValidMandateId,
} from '../lib/archived-mandates-store';

export function createArchivedMandatesRouter(dataDir?: string): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ archived: readArchived(dataDir) });
  });

  const change = (fn: typeof archiveMandate) => (req: import('express').Request, res: import('express').Response) => {
    const id = req.params.id;
    if (!isValidMandateId(id)) {
      res.status(400).json({ error: 'invalid mandate id' });
      return;
    }
    try {
      res.json({ archived: fn(id, dataDir) });
    } catch (err) {
      res.status(500).json({ error: `Could not save: ${(err as Error).message}` });
    }
  };

  router.put('/:id', change(archiveMandate));
  router.delete('/:id', change(unarchiveMandate));

  return router;
}
