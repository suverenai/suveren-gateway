/**
 * Committed-proposal executor — ONE place that runs approved proposals.
 *
 * Three things want to execute a committed proposal: the poll loop, the
 * control-plane's post-resolve nudge, and an agent calling
 * `check-pending-commitments(proposal_id)`. Until 2026-09-04 each called the
 * executor function directly, so two of them could — and did — run the same
 * proposal at once. The AS handed the second one the original ticket back
 * (correct: a same-caller retry must not strand an approved action) and the
 * tool ran twice.
 *
 * This class makes the triggers enqueue instead of execute:
 *
 *   - Same proposal already in flight → the caller gets THAT promise. One
 *     result, shared.
 *   - Different proposals → run strictly one after another. There is no
 *     throughput argument for parallel execution of human-approved actions,
 *     and serial removes every ordering question.
 *
 * The execution journal (execution-journal.ts) remains the correctness
 * guarantee — it is what stops a repeat across restarts and across processes.
 * This class removes the in-process race so the journal is the backstop, not
 * the only line.
 */

export interface ExecutionResult {
  text: string;
  isError?: boolean;
}

export class CommittedExecutor<P extends { id: string }> {
  private readonly inFlight = new Map<string, Promise<ExecutionResult>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly run: (proposal: P) => Promise<ExecutionResult>) {}

  /** Execute `proposal` once, however many callers ask while it is running. */
  execute(proposal: P): Promise<ExecutionResult> {
    const existing = this.inFlight.get(proposal.id);
    if (existing) return existing;

    const p = this.chain
      .then(() => this.run(proposal))
      .finally(() => this.inFlight.delete(proposal.id));
    // The chain must never reject, or one failure would wedge every later run.
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(proposal.id, p);
    return p;
  }

  /** Proposal ids currently queued or running. Diagnostic. */
  get pending(): string[] {
    return [...this.inFlight.keys()];
  }
}

// ─── Cross-process executor lock ─────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface LockFile {
  pid: number;
  startedAt: number;
}

/**
 * At most one process per data directory runs the committed-proposal loop.
 *
 * The dev gateway and the npm-installed gateway share `~/.suveren` and the
 * same AS credentials. Both poll the AS; both would execute. An in-process
 * queue cannot see the other process, and the journal only narrows the
 * window. So: the loop runs only in the process holding this lock. A process
 * that does not hold it still serves tool calls, still creates proposals —
 * it just does not auto-execute, and says so at startup.
 *
 * Stale locks (holder no longer alive) are taken over. Liveness is checked
 * with signal 0; on a platform where that lies the worst case is the
 * pre-lock behaviour, never a refusal to start.
 */
export class ExecutorLock {
  private readonly path: string;
  private held = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'executor.lock');
  }

  /** Try to take the lock. Returns the holder's pid when someone else has it. */
  acquire(): { held: true } | { held: false; holderPid: number } {
    const current = this.read();
    if (current && current.pid !== process.pid && isAlive(current.pid)) {
      return { held: false, holderPid: current.pid };
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock: LockFile = { pid: process.pid, startedAt: Math.floor(Date.now() / 1000) };
    writeFileSync(this.path, JSON.stringify(lock), { mode: 0o600 });
    this.held = true;
    return { held: true };
  }

  /** True if this process currently holds the lock (re-checks the file). */
  isHeld(): boolean {
    if (!this.held) return false;
    const current = this.read();
    return current?.pid === process.pid;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    const current = this.read();
    if (current?.pid === process.pid) {
      try { unlinkSync(this.path); } catch { /* already gone */ }
    }
  }

  private read(): LockFile | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as LockFile;
      return typeof parsed?.pid === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
