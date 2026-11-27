/**
 * The npm install's inactivity limit (lib/inactivity-watch.ts): a step that shows progress may take
 * as long as it needs; one that shows none for the limit is ended (a dead network hung a whole run
 * overnight, 2026-11-19). Fake timers, no npm.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchInactivity, npmInstallIdleMs, NPM_INSTALL_IDLE_MS } from '../src/lib/inactivity-watch';

afterEach(() => { vi.useRealTimers(); });

describe('inactivity watch', () => {
  it('ends a step that shows no progress for the limit, once', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    watchInactivity({ limitMs: 60_000, checkEveryMs: 1_000, onIdle });
    vi.advanceTimersByTime(59_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('output keeps a slow step going, however long it takes in total', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const w = watchInactivity({ limitMs: 60_000, checkEveryMs: 1_000, onIdle });
    for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(50_000); w.touch(); } // 1000 s in total
    expect(onIdle).not.toHaveBeenCalled();
    w.stop();
  });

  it('a changing probe (files being written) counts as progress', () => {
    vi.useFakeTimers();
    let mtime = 1;
    const onIdle = vi.fn();
    const w = watchInactivity({ limitMs: 60_000, checkEveryMs: 1_000, probe: () => mtime, onIdle });
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(40_000); mtime += 1; }
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(62_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('stop() ends the watch: a finished step is never ended later', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const w = watchInactivity({ limitMs: 10_000, checkEveryMs: 1_000, onIdle });
    w.stop();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('the limit is five minutes unless SUVEREN_NPM_INSTALL_IDLE_MS sets one of at least a second', () => {
    expect(npmInstallIdleMs({})).toBe(NPM_INSTALL_IDLE_MS);
    expect(NPM_INSTALL_IDLE_MS).toBe(300_000);
    expect(npmInstallIdleMs({ SUVEREN_NPM_INSTALL_IDLE_MS: '20000' })).toBe(20_000);
    expect(npmInstallIdleMs({ SUVEREN_NPM_INSTALL_IDLE_MS: '5' })).toBe(NPM_INSTALL_IDLE_MS);
    expect(npmInstallIdleMs({ SUVEREN_NPM_INSTALL_IDLE_MS: 'x' })).toBe(NPM_INSTALL_IDLE_MS);
  });
});
