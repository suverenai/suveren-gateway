/**
 * Installs of DIFFERENT integrations must not overlap.
 *
 * Every integration installs into the same prefix, and `npm install` rewrites
 * that whole directory's tree and `node_modules/.bin` shims. Two running at
 * once means one can prune or relink the other's files while that other
 * package is being spawned.
 *
 * The per-id operation queue (integration-start-race.test.ts) does not cover
 * this: it serializes operations for ONE integration, and this is a collision
 * between two different ones. Both faces of the bug were seen in CI —
 * `Cannot find module '…/node_modules/.bin/crm-mcp'`, and a connector that
 * connected, was restarted, and never returned while another integration
 * installed.
 *
 * It hides locally because the packages are already installed and the fast
 * path never reaches an install. It needs a cold directory — which is exactly
 * a real user's first run, where boot auto-restore starts several
 * integrations at once.
 */
import { describe, it, expect } from 'vitest';
import { withInstallLock } from '../src/lib/integration-manager';

/** Resolves after `ms`, letting other queued work interleave if it can. */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('withInstallLock', () => {
  it('never runs two installs at the same time', async () => {
    let active = 0;
    let maxActive = 0;

    const install = (ms: number) =>
      withInstallLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(ms);
        active--;
      });

    // Deliberately staggered durations: a broken lock lets the short one
    // finish inside the long one, which is precisely the overlap that
    // corrupts the shared node_modules.
    await Promise.all([install(30), install(5), install(15)]);

    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });

  it('runs them in the order they were requested', async () => {
    const order: string[] = [];
    const install = (name: string, ms: number) =>
      withInstallLock(async () => {
        await sleep(ms);
        order.push(name);
      });

    await Promise.all([install('crm', 20), install('records', 1), install('gmail', 1)]);

    expect(order).toEqual(['crm', 'records', 'gmail']);
  });

  it('a failed install does not wedge the ones behind it', async () => {
    // The queue tail must be settled-safe. Without that, one npm failure
    // (offline, bad package) would leave every later integration unable to
    // install for the lifetime of the process.
    const failing = withInstallLock(async () => {
      throw new Error('npm exploded');
    });
    await expect(failing).rejects.toThrow('npm exploded');

    const after = await withInstallLock(async () => 'installed');
    expect(after).toBe('installed');
  });

  it('propagates the result of each install to its own caller', async () => {
    const [a, b] = await Promise.all([
      withInstallLock(async () => 'crm-mcp'),
      withInstallLock(async () => 'records-mcp'),
    ]);
    expect(a).toBe('crm-mcp');
    expect(b).toBe('records-mcp');
  });
});
