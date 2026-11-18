/**
 * POST /internal/os-signal — the computer's own signal that the screen locked,
 * the machine went to sleep or another user took over. Ends every page
 * session (lib/page-session.ts createOsSignalHook).
 *
 * Authenticated by the shared internal secret, like /internal/event: the
 * detector (the native helper of step 5a) is a sibling process, not a browser.
 * Nothing detects these events yet; this is the end the detector will call.
 */

import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { OsSessionSignal } from '../lib/page-session';

const SIGNALS: readonly OsSessionSignal[] = ['screen-lock', 'sleep', 'user-switch'];

export function createInternalOsSignalRouter(getSecret: () => string, onSignal: (s: OsSessionSignal) => void): Router {
  const router = Router();
  router.post('/os-signal', (req, res) => {
    const provided = req.headers['x-internal-secret'];
    const expected = getSecret();
    const a = Buffer.from(typeof provided === 'string' ? provided : '');
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const signal = (req.body ?? {}).signal as unknown;
    if (typeof signal !== 'string' || !SIGNALS.includes(signal as OsSessionSignal)) {
      res.status(400).json({ error: 'Unsupported signal' });
      return;
    }
    onSignal(signal as OsSessionSignal);
    res.json({ ok: true });
  });
  return router;
}
