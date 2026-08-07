import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The ping that the v0.7.0 notification feature was missing. Its job is to be
 * minimal and to never matter to the caller.
 */
describe('notifyControlPlane', () => {
  const OLD_ENV = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SUVEREN_INTERNAL_SECRET = 'shared-secret';
    delete process.env.SUVEREN_CP_INTERNAL_URL;
    delete process.env.SUVEREN_CP_PORT;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  async function load() {
    return (await import('../cp-notify')).notifyControlPlane;
  }

  it('posts the event type and nothing else', async () => {
    const notify = await load();
    await notify('proposal-added');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3402/internal/event');
    expect(init.headers['X-Internal-Secret']).toBe('shared-secret');

    // Presence, never content: the body has exactly one key.
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ type: 'proposal-added' });
  });

  it('stays silent when the two processes were never wired together', async () => {
    delete process.env.SUVEREN_INTERNAL_SECRET;
    const notify = await load();
    await notify('proposal-added');
    // Better no doorbell than an unauthenticated call to an unknown listener.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the control plane is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const notify = await load();
    // The proposal already exists; a failed doorbell must not surface as a
    // failed send.
    await expect(notify('proposal-added')).resolves.toBeUndefined();
  });


  it('defaults to the control plane\'s OWN default port when nothing is set', async () => {
    // The bug this pins: cp-notify defaulted to 3400 (the npm bundle's port)
    // while the control plane defaults to 3402, so in dev every ping went
    // nowhere — silently, because the call is fire-and-forget.
    delete process.env.SUVEREN_CP_PORT;
    delete process.env.SUVEREN_CP_INTERNAL_URL;
    const notify = await load();
    await notify('proposal-added');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3402/internal/event');
  });

  it('honours a non-default control-plane port', async () => {
    process.env.SUVEREN_CP_PORT = '3402';
    const notify = await load();
    await notify('proposal-added');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3402/internal/event');
  });

  it('honours an explicit internal URL override (Docker)', async () => {
    process.env.SUVEREN_CP_INTERNAL_URL = 'http://control-plane:3000';
    const notify = await load();
    await notify('proposal-added');
    expect(fetchMock.mock.calls[0][0]).toBe('http://control-plane:3000/internal/event');
  });
});
