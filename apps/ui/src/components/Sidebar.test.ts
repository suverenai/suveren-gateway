import { describe, it, expect } from 'vitest';
import { NAV_ITEMS } from './Sidebar';

// The gateway's configuration entry covers more than the AI assistant now
// (Authority Server, security, version) — it must read "Settings", not
// "AI Assistant", while keeping the same route and the same badge behaviour
// (dot when the assistant isn't configured — see useOtherNavStatus).
describe('Sidebar NAV_ITEMS — settings entry', () => {
  it('labels the /settings entry "Settings"', () => {
    const settings = NAV_ITEMS.find(i => i.to === '/settings');
    expect(settings).toBeDefined();
    expect(settings?.label).toBe('Settings');
  });

  it('keeps the settings icon and the assistant status badge on that entry', () => {
    const settings = NAV_ITEMS.find(i => i.to === '/settings');
    expect(settings?.icon).toBe('settings');
    expect(settings?.statusKey).toBe('assistant');
  });
});

import { newestWins } from './Sidebar';

// The nav badges refresh on every event that changes a count. Two events close together start two
// refreshes; the older one may finish last and must not overwrite the newer counts (the Blocked badge
// stayed at 1 after two blocks, suveren-e2e blocked-seen, 2026-11-18).
describe('newestWins — the badge refresh applies only the newest answer', () => {
  function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }

  it('an older refresh that finishes last is dropped', async () => {
    const first = deferred<number>(); const second = deferred<number>();
    const loads = [first.p, second.p];
    const applied: number[] = [];
    const poll = newestWins(() => loads.shift()!, (v) => applied.push(v));
    const a = poll(); const b = poll();
    second.resolve(2); await b; // the newer one answers first
    first.resolve(1); await a;  // the older one answers last
    expect(applied).toEqual([2]);
  });

  it('answers in order are each applied', async () => {
    const applied: number[] = [];
    let n = 0;
    const poll = newestWins(async () => ++n, (v) => applied.push(v));
    await poll(); await poll();
    expect(applied).toEqual([1, 2]);
  });

  it('a failed refresh applies nothing and leaves the newest one alone', async () => {
    const applied: number[] = [];
    const loads: Array<() => Promise<number>> = [async () => { throw new Error('offline'); }, async () => 7];
    const poll = newestWins(() => loads.shift()!(), (v) => applied.push(v));
    await poll(); await poll();
    expect(applied).toEqual([7]);
  });
});
