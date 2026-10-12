/**
 * WS4 (work-plan "Added 2026-10-11 — an account is Personal OR in one
 * team") — the two pieces lib/managed-team.ts owns: reading the account's
 * active team id from the Authority Server, and the periodic-check timer
 * that uses it while a session is already open.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { activeTeamId, ManagedTeamScheduler } from '../lib/managed-team';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('activeTeamId', () => {
  it('returns the active team\'s group id', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ group: { id: 'grp_team1' } }),
    })) as unknown as typeof fetch;
    const id = await activeTeamId('https://as.example', 'hap-session=abc', { enforce: false });
    expect(id).toBe('grp_team1');
  });

  it('returns null for a Personal account (no active team)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ group: null }),
    })) as unknown as typeof fetch;
    const id = await activeTeamId('https://as.example', 'hap-session=abc', { enforce: false });
    expect(id).toBeNull();
  });

  it('throws on a non-ok response — never silently "no team"', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(activeTeamId('https://as.example', 'hap-session=abc', { enforce: false })).rejects.toThrow();
  });

  it('sends the session cookie, not the API key', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ group: null }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await activeTeamId('https://as.example', 'hap-session=abc', { enforce: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://as.example/api/groups/me');
    expect((init?.headers as Record<string, string>).Cookie).toBe('hap-session=abc');
  });
});

describe('ManagedTeamScheduler', () => {
  it('does not run the check until started', () => {
    const check = vi.fn();
    const setIntervalFn = vi.fn();
    new ManagedTeamScheduler(check, { setIntervalFn: setIntervalFn as unknown as typeof setInterval });
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('starting arms exactly one interval at the configured cadence', () => {
    const check = vi.fn();
    const setIntervalFn = vi.fn((_cb: () => void, _ms: number) => 'fake-handle');
    const scheduler = new ManagedTeamScheduler(check, {
      intervalMs: 123,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    });
    scheduler.start();
    scheduler.start(); // idempotent — a second start must not arm a second timer
    expect(setIntervalFn).toHaveBeenCalledOnce();
    expect(setIntervalFn.mock.calls[0][1]).toBe(123);
  });

  it('defaults to a 5-minute cadence, same as the session-expiry coarse timer', () => {
    const setIntervalFn = vi.fn((_cb: () => void, _ms: number) => 'fake-handle');
    const scheduler = new ManagedTeamScheduler(vi.fn(), { setIntervalFn: setIntervalFn as unknown as typeof setInterval });
    scheduler.start();
    expect(setIntervalFn.mock.calls[0][1]).toBe(5 * 60_000);
  });

  it('runNow() runs the check immediately, bypassing the timer', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ManagedTeamScheduler(check);
    await scheduler.runNow();
    expect(check).toHaveBeenCalledOnce();
  });

  it('stop() clears the timer so the check never fires again', () => {
    const clearIntervalFn = vi.fn();
    const scheduler = new ManagedTeamScheduler(vi.fn(), {
      setIntervalFn: (() => 'fake-handle') as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });
    scheduler.start();
    scheduler.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith('fake-handle');
  });
});
