import { afterEach, describe, expect, it } from 'vitest';
import { forceCheck, getUpdateStatus, setUpdateCheckerForTests } from '../update-checker';

/** A git that answers after `ms`, counting its calls. */
function slowGit(ms: number, behind = '3') {
  const calls: string[][] = [];
  const git = (args: string[]) =>
    new Promise<string>((resolve) => {
      calls.push(args);
      setTimeout(() => resolve(args[0] === 'rev-list' ? `${behind}\n` : ''), ms);
    });
  return { git, calls };
}

afterEach(() => setUpdateCheckerForTests());

describe('update checker: forced checks (CI 45097746048, report-e2e 9.0)', () => {
  it('several forced checks at once run git once and all see its answer', async () => {
    const g = slowGit(50);
    setUpdateCheckerForTests({ git: g.git, method: 'dev' });
    await Promise.all([forceCheck(), forceCheck(), forceCheck(), forceCheck()]);
    expect(g.calls.filter((a) => a[0] === 'fetch')).toHaveLength(1);
    expect(getUpdateStatus().latestVersion).toBe('3 commits behind origin/main');
  });

  it('a forced check right after one answers at once without git', async () => {
    const g = slowGit(5);
    setUpdateCheckerForTests({ git: g.git, method: 'dev' });
    await forceCheck();
    const before = g.calls.length;
    await forceCheck();
    expect(g.calls.length).toBe(before);
  });

  it('the dev check does not block the event loop while git runs', async () => {
    const g = slowGit(200);
    setUpdateCheckerForTests({ git: g.git, method: 'dev' });
    let ticked = false;
    const tick = new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 10));
    const check = forceCheck();
    await tick;
    expect(ticked).toBe(true);
    await check;
  });

  it('a failing git leaves no update, and a page load does not retry it on every mount', async () => {
    let n = 0;
    setUpdateCheckerForTests({ git: () => { n++; return Promise.reject(new Error('offline')); }, method: 'dev' });
    await forceCheck();
    expect(getUpdateStatus().updateAvailable).toBe(false);
    await forceCheck();
    expect(n).toBe(1);
  });
});
