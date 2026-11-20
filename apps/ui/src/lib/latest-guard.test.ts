import { describe, it, expect } from 'vitest';
import { createLatestGuard } from './latest-guard';

/** A promise we resolve by hand, to finish loads in a chosen order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * The shape of Sidebar's badge poll: start a load, await the server, then
 * write the count — but only if no newer load started meanwhile.
 */
function makeBadge() {
  const guard = createLatestGuard();
  let shown: number | undefined;
  async function load(answer: Promise<number>): Promise<void> {
    const isLatest = guard.begin();
    const count = await answer;
    if (!isLatest()) return;
    shown = count;
  }
  return { load, shown: () => shown };
}

describe('createLatestGuard: overlapping loads', () => {
  it('an older load that finishes last does not overwrite the newer answer (two blocks, badge 2)', async () => {
    const badge = makeBadge();
    const first = deferred<number>();  // started on the 1st denial event: sees 1
    const second = deferred<number>(); // started on the 2nd denial event: sees 2
    const a = badge.load(first.promise);
    const b = badge.load(second.promise);
    second.resolve(2);
    await b;
    first.resolve(1);                  // the older load finishes last
    await a;
    expect(badge.shown()).toBe(2);
  });

  it('loads that finish in order write the newest answer', async () => {
    const badge = makeBadge();
    const first = deferred<number>();
    const second = deferred<number>();
    const a = badge.load(first.promise);
    const b = badge.load(second.promise);
    first.resolve(1);
    await a;
    second.resolve(2);
    await b;
    expect(badge.shown()).toBe(2);
  });

  it('a single load writes its answer', async () => {
    const badge = makeBadge();
    await badge.load(Promise.resolve(3));
    expect(badge.shown()).toBe(3);
  });

  it('each guard is independent', () => {
    const g1 = createLatestGuard();
    const g2 = createLatestGuard();
    const c1 = g1.begin();
    g2.begin();
    expect(c1()).toBe(true);
  });
});
