import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createInternalEventsRouter } from '../routes/internal-events';
import { createEventsHandler } from '../routes/events';
import { NotificationDispatcher } from '../lib/notification-dispatcher';

/**
 * The test that was missing when notifications shipped dead in v0.7.0.
 *
 * Every earlier test called the dispatcher's trigger directly, so they proved
 * the doorbell rings when pressed and said nothing about whether anything
 * presses it. In production nothing did: the MCP server creates proposals
 * against the Authority Server, and the control plane — a separate process with
 * an in-process bus — was never told.
 *
 * This exercises the real chain over real HTTP, with only the OS notification
 * call stubbed:
 *
 *   HTTP ping → /internal/event → EventBus → dispatcher → notify
 *                                         → SSE frame → browser badge
 */
describe('notification wiring (end to end, in-process)', () => {
  const SECRET = 'wiring-test-secret';
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await stop?.();
    stop = null;
    vi.useRealTimers();
  });

  async function startCp() {
    const app = express();
    app.use('/internal', express.json(), createInternalEventsRouter(() => SECRET));
    app.get('/events', createEventsHandler());
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    stop = () => new Promise<void>(r => server.close(() => r()));
    return `http://127.0.0.1:${port}`;
  }

  it('a ping from the sibling process reaches the desktop notification', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const url = await startCp();

    const notifyFn = vi.fn();
    const dispatcher = new NotificationDispatcher({
      notifyFn: notifyFn as never,
      settingsFn: (() => ({ desktopNotifications: true })) as never,
    });
    const stopDispatcher = dispatcher.start();

    try {
      const res = await fetch(`${url}/internal/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
        body: JSON.stringify({ type: 'proposal-added' }),
      });
      expect(res.status).toBe(200);

      // Debounce window.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(notifyFn).toHaveBeenCalledTimes(1);
      const [title, message] = notifyFn.mock.calls[0];
      expect(title).toBe('Suveren');
      expect(message).toBe('Something is waiting for your review.');
    } finally {
      stopDispatcher();
    }
  });

  it('the same ping reaches an SSE client, carrying no content', async () => {
    const url = await startCp();

    const controller = new AbortController();
    const streamRes = await fetch(`${url}/events`, { signal: controller.signal });
    const reader = streamRes.body!.getReader();

    await fetch(`${url}/internal/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
      // A payload the caller should not be able to push through.
      body: JSON.stringify({ type: 'proposal-added', tool: 'gmail__send_message', to: 'a@b.c' }),
    });

    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    controller.abort();

    expect(frame).toContain('event: proposal-added');
    expect(frame).toContain('data: null');
    expect(frame).not.toContain('gmail');
    expect(frame).not.toContain('a@b.c');
  });
});
