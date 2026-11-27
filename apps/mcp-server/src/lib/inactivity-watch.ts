/**
 * An inactivity limit for a long-running step (the connector's `npm install`).
 *
 * A total timeout is wrong there: an install on a machine with antivirus can be slow, and killing a
 * slow one midway is what made broken installs before. But no limit at all is wrong too: on a dead
 * network npm can wait forever, and installs are serialised, so one stuck install blocks every
 * later activation (a whole test run hung overnight on it, 2026-11-19). So: the step may take as long
 * as it needs while it shows progress; after `limitMs` with NO sign of progress it is ended.
 *
 * Progress is anything the caller reports with `touch()` (npm's output) or a change in what `probe`
 * returns (e.g. the target folder's modification time while npm unpacks).
 */
export interface InactivityWatch {
  /** Something happened: the limit counts again from now. */
  touch(): void;
  /** The step finished (or failed on its own): stop watching. */
  stop(): void;
}

export function watchInactivity(o: {
  limitMs: number;
  /** How often `probe` is read. Default 15 s. */
  checkEveryMs?: number;
  /** A value that changes while the step makes progress; read every `checkEveryMs`. */
  probe?: () => string | number | null;
  /** Called once, when `limitMs` passed without progress. */
  onIdle: (idleMs: number) => void;
  now?: () => number;
}): InactivityWatch {
  const now = o.now ?? Date.now;
  let last = now();
  let seen = o.probe?.() ?? null;
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    const v = o.probe?.() ?? null;
    if (v !== seen) { seen = v; last = now(); return; }
    const idle = now() - last;
    if (idle >= o.limitMs) { done = true; clearInterval(timer); o.onIdle(idle); }
  }, o.checkEveryMs ?? 15_000);
  timer.unref?.();
  return {
    touch() { last = now(); },
    stop() { done = true; clearInterval(timer); },
  };
}

/** Default inactivity limit for `npm install`: five minutes without any sign of progress. */
export const NPM_INSTALL_IDLE_MS = 5 * 60_000;

/** The limit in force (SUVEREN_NPM_INSTALL_IDLE_MS overrides, for tests and slow sites). */
export function npmInstallIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.SUVEREN_NPM_INSTALL_IDLE_MS);
  return Number.isFinite(v) && v >= 1_000 ? v : NPM_INSTALL_IDLE_MS;
}
