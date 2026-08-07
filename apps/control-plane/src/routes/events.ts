/**
 * GET /events — Server-Sent Events stream.
 *
 * Auth-guarded. Subscribes to the shared EventBus and pushes events to the
 * connected browser client as SSE frames. A keepalive comment is written every
 * 25s to defeat reverse-proxy idle-close.
 *
 * Mount in index.ts:
 *   app.get('/events', requireHostAllowed, requireAuth(vault), createEventsHandler());
 */

import type { Request, Response } from 'express';
import { eventBus } from '../lib/event-bus';

const KEEPALIVE_INTERVAL_MS = 25_000;

export function createEventsHandler() {
  return function eventsHandler(_req: Request, res: Response): void {
    // SSE headers — must be set before any body bytes are written.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Disable Nginx/proxy response buffering so events reach the client immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    // Deliberately NO Access-Control-Allow-Origin. Without it the browser blocks
    // cross-origin reads of this stream, which is the only thing standing
    // between a malicious page and a live feed of when you are being asked to
    // approve something. A regression test asserts the header stays absent.
    res.flushHeaders();

    // Forward the event TYPE and nothing else.
    //
    // The bus carries an optional payload, and this used to write it to the
    // wire verbatim. Payloads are null today, so nothing leaked — but the first
    // emitter to attach a proposal title or an amount would have shipped it to
    // every connected client, and to anything that ever manages to read this
    // stream. Notification surfaces carry presence, never content.
    //
    // If a future feature genuinely needs payload data in the browser, add an
    // explicit per-type allowlist HERE. Do not remove the sanitizer.
    const unsubscribe = eventBus.subscribe(event => {
      res.write(`event: ${event.type}\ndata: null\n\n`);
    });

    // Keepalive — SSE comment syntax (lines starting with ':' are ignored by clients).
    const keepalive = setInterval(() => {
      res.write(':ka\n\n');
    }, KEEPALIVE_INTERVAL_MS);

    // Cleanup when the client disconnects (tab close, navigation, network drop).
    _req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  };
}
