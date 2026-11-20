/**
 * The revoke outbox for replaced mandates: retried with a growing pause until
 * the Authority Server confirms it; nothing is attempted without a session.
 * The records themselves live on the MCP server's disk (its own test covers
 * the restart); here a fresh retry pass after a "restart" picks them up.
 */
import { describe, it, expect, vi } from 'vitest';
import { retryReplacedRevokes, pauseAfter, isDue, type RetryDeps } from '../lib/replaced-revoke-retry';
import type { ReplacedMandateEntry } from '../lib/mcp-bridge';

const MIN = 60_000;

function store(initial: ReplacedMandateEntry[]) {
  const entries = new Map(initial.map((e) => [e.authorizationId, { ...e }]));
  return {
    entries,
    list: async () => [...entries.values()].map((e) => ({ ...e })),
    noteAttempt: vi.fn(async (id: string, error?: string) => {
      const e = entries.get(id)!; e.attempts += 1; e.lastAttemptAt = NOW; if (error) e.lastError = error;
    }),
    clear: vi.fn(async (id: string) => { entries.delete(id); }),
  };
}
let NOW = 1_000_000_000;

function depsWith(s: ReturnType<typeof store>, asStatus: () => number, signedIn = true): RetryDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    as: async (_m, path) => { calls.push(path); return { status: asStatus(), body: asStatus() >= 300 ? { error: 'down' } : {} }; },
    signedIn: () => signedIn,
    list: s.list,
    noteAttempt: s.noteAttempt,
    clear: s.clear,
    resyncGates: vi.fn(async () => ({})),
  };
}

describe('replaced-mandate revoke retry', () => {
  it('pause grows 1, 2, 4 … minutes and stops at one hour', () => {
    expect(pauseAfter(1)).toBe(MIN);
    expect(pauseAfter(2)).toBe(2 * MIN);
    expect(pauseAfter(3)).toBe(4 * MIN);
    expect(pauseAfter(20)).toBe(60 * MIN);
    expect(isDue({ authorizationId: 'a', replacedBy: 'b', since: 0, attempts: 2, lastAttemptAt: NOW }, NOW + MIN)).toBe(false);
    expect(isDue({ authorizationId: 'a', replacedBy: 'b', since: 0, attempts: 2, lastAttemptAt: NOW }, NOW + 2 * MIN)).toBe(true);
  });

  it('a failed attempt is counted and the record stays; after the pause the next pass revokes and clears it', async () => {
    const s = store([{ authorizationId: 'authz_old', replacedBy: 'authz_new', since: NOW, attempts: 1, lastAttemptAt: NOW - MIN, lastError: 'down' }]);
    let status = 503;
    const d = depsWith(s, () => status);
    let r = await retryReplacedRevokes(d, NOW);
    expect(r.failed).toEqual(['authz_old']);
    expect(s.entries.get('authz_old')!.attempts).toBe(2);
    // Not due yet: nothing is sent.
    r = await retryReplacedRevokes(d, NOW + MIN);
    expect(d.calls).toHaveLength(1);
    // "Restart": a new pass with fresh deps reads the same records and, once due, revokes.
    status = 200;
    const d2 = depsWith(s, () => status);
    r = await retryReplacedRevokes(d2, NOW + 2 * MIN);
    expect(r.revoked).toEqual(['authz_old']);
    expect(d2.calls).toEqual(['/api/authorizations/authz_old/revoke']);
    expect(s.entries.size).toBe(0);
    expect(d2.resyncGates).toHaveBeenCalled();
  });

  it('already revoked (409) counts as done', async () => {
    const s = store([{ authorizationId: 'authz_old', replacedBy: 'authz_new', since: NOW, attempts: 1, lastAttemptAt: 0 }]);
    const r = await retryReplacedRevokes(depsWith(s, () => 409), NOW);
    expect(r.revoked).toEqual(['authz_old']);
    expect(s.entries.size).toBe(0);
  });

  it('without a session nothing is attempted and nothing is counted', async () => {
    const s = store([{ authorizationId: 'authz_old', replacedBy: 'authz_new', since: NOW, attempts: 1, lastAttemptAt: 0 }]);
    const d = depsWith(s, () => 200, false);
    const r = await retryReplacedRevokes(d, NOW);
    expect(r).toEqual({ revoked: [], failed: [] });
    expect(d.calls).toEqual([]);
    expect(s.entries.get('authz_old')!.attempts).toBe(1);
  });
});
