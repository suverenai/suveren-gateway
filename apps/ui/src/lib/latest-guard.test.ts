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
 * write the count — unless a newer load has already written.
 */
function makeBadge() {
  const guard = createLatestGuard();
  let shown: number | undefined;
  async function load(answer: Promise<number>): Promise<void> {
    const mayWrite = guard.begin();
    const count = await answer;
    if (!mayWrite()) return;
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

  it('a load that finishes first is shown at once, while a newer one still runs (no starving)', async () => {
    const badge = makeBadge();
    const first = deferred<number>();
    const second = deferred<number>();
    const a = badge.load(first.promise);
    const b = badge.load(second.promise);
    first.resolve(1);
    await a;
    expect(badge.shown()).toBe(1);     // not held back by the newer, still running load
    second.resolve(2);
    await b;
    expect(badge.shown()).toBe(2);
  });

  it('a stream of overlapping loads keeps writing; only a stale late answer is dropped', async () => {
    const badge = makeBadge();
    const d = [deferred<number>(), deferred<number>(), deferred<number>()];
    const runs = d.map(x => badge.load(x.promise));
    d[1].resolve(2); await runs[1];
    expect(badge.shown()).toBe(2);
    d[0].resolve(1); await runs[0];    // older than what is shown: dropped
    expect(badge.shown()).toBe(2);
    d[2].resolve(3); await runs[2];
    expect(badge.shown()).toBe(3);
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
