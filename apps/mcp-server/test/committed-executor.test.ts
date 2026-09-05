/**
 * Committed-proposal executor + journal: the 2026-09-04 double execution,
 * pinned at the unit level.
 *
 * What happened: the control-plane nudge and the poll loop both ran the same
 * committed proposal; the AS replayed the original ticket to the second
 * caller (`idempotent: true`, as the spec requires for a same-caller retry)
 * and the tool ran twice. Two layers now prevent it, tested separately:
 *
 *   1. CommittedExecutor — same proposal in flight ⇒ one run, shared result.
 *   2. ExecutionJournal — even bypassing the executor (a second process, a
 *      restart), a replayed ticket with a `done` row does not run the tool.
 *
 * The end-to-end version (real AS, real gateway, nudge + poll overlapping)
 * lives in hap-e2e/test/exactly-once-execution.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommittedExecutor, ExecutorLock } from '../src/lib/committed-executor';
import { ExecutionJournal } from '../src/lib/execution-journal';
import { executeCommitted } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';

// ─── 1. Executor ────────────────────────────────────────────────────────────

describe('CommittedExecutor', () => {
  it('runs the same proposal once for concurrent callers and shares the result', async () => {
    const run = vi.fn(async (p: { id: string }) => {
      await new Promise(r => setTimeout(r, 20));
      return { text: `ran ${p.id}` };
    });
    const ex = new CommittedExecutor(run);
    const [a, b, c] = await Promise.all([
      ex.execute({ id: 'p1' }),
      ex.execute({ id: 'p1' }),
      ex.execute({ id: 'p1' }),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ text: 'ran p1' });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('runs different proposals strictly one after another', async () => {
    const order: string[] = [];
    const run = vi.fn(async (p: { id: string }) => {
      order.push(`start ${p.id}`);
      await new Promise(r => setTimeout(r, 10));
      order.push(`end ${p.id}`);
      return { text: p.id };
    });
    const ex = new CommittedExecutor(run);
    await Promise.all([ex.execute({ id: 'a' }), ex.execute({ id: 'b' })]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('a failing run does not wedge the queue', async () => {
    const run = vi.fn(async (p: { id: string }) => {
      if (p.id === 'boom') throw new Error('boom');
      return { text: p.id };
    });
    const ex = new CommittedExecutor(run);
    await expect(ex.execute({ id: 'boom' })).rejects.toThrow('boom');
    await expect(ex.execute({ id: 'ok' })).resolves.toEqual({ text: 'ok' });
  });

  it('after a run completes, the same proposal may be submitted again (the journal decides)', async () => {
    const run = vi.fn(async (p: { id: string }) => ({ text: p.id }));
    const ex = new CommittedExecutor(run);
    await ex.execute({ id: 'p1' });
    await ex.execute({ id: 'p1' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

// ─── Executor lock ──────────────────────────────────────────────────────────

describe('ExecutorLock', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hap-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('first acquirer holds; a stale lock (dead pid) is taken over', () => {
    const a = new ExecutorLock(dir);
    expect(a.acquire()).toEqual({ held: true });
    expect(a.isHeld()).toBe(true);
    a.release();
    expect(a.isHeld()).toBe(false);

    // Simulate a crashed holder: a pid that cannot be alive.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(dir, 'executor.lock'), JSON.stringify({ pid: 2 ** 22 - 1, startedAt: 0 }));
    const b = new ExecutorLock(dir);
    expect(b.acquire()).toEqual({ held: true });
    b.release();
  });

  it('a live holder is respected', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    // Our own parent is certainly alive and is not us.
    writeFileSync(join(dir, 'executor.lock'), JSON.stringify({ pid: process.ppid, startedAt: 0 }));
    const l = new ExecutorLock(dir);
    expect(l.acquire()).toEqual({ held: false, holderPid: process.ppid });
    expect(l.isHeld()).toBe(false);
  });
});

// ─── 2. Journal through the real executeCommitted ───────────────────────────

const PROPOSAL: SPProposal = {
  id: 'prop-1',
  authorizationId: 'authz_1',
  profileId: 'test-deploy@1', // unregistered on purpose — no content binding applies
  path: 'deploy@0.9',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'deploy-github__release',
  toolArgs: { repo: 'o/r', commit: 'abc' },
  executionContext: { action_type: 'release' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'release',
  namespacedName: 'deploy-github__release',
  integrationId: 'deploy-github',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'deploy', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
};

function buildState(dir: string, postReceipt: ReturnType<typeof vi.fn>) {
  const record = vi.fn();
  const state = {
    spClient: { postReceipt },
    cache: { getAllAuthorizations: () => [] },
    executionLog: { record },
    executionJournal: new ExecutionJournal(dir),
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, record };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'dispatched' }] });
  const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
  return { im, callTool };
}

describe('executeCommitted × ExecutionJournal', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hap-exec-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the 2026-09-04 case: fresh ticket then replayed ticket ⇒ tool runs ONCE, local count 1', async () => {
    // First call: AS mints. Second call: AS replays the same ticket.
    const postReceipt = vi
      .fn()
      .mockResolvedValueOnce({ receipt: { id: 'rcpt-1' }, idempotent: false })
      .mockResolvedValueOnce({ receipt: { id: 'rcpt-1' }, idempotent: true });
    const { state, record } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();

    const first = await executeCommitted(PROPOSAL, state, im);
    const second = await executeCommitted(PROPOSAL, state, im);

    expect(first.isError).toBeUndefined();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(second.isError).toBeUndefined();
    expect(second.text).toMatch(/already executed under ticket rcpt-1/);
  });

  it('a replayed ticket with NO journal row is lost-response recovery: runs once', async () => {
    const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'rcpt-1' }, idempotent: true });
    const { state } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();
    const r = await executeCommitted(PROPOSAL, state, im);
    expect(r.isError).toBeUndefined();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('an intent row with no completion (crash window) is surfaced, never re-run', async () => {
    const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'rcpt-1' }, idempotent: true });
    const { state } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();
    // Someone got as far as calling the tool and vanished.
    state.executionJournal.begin({ ticketId: 'rcpt-1', proposalId: 'prop-1', tool: PROPOSAL.tool, argsHash: 'x' });

    const r = await executeCommitted(PROPOSAL, state, im);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/never reported completion/);
    expect(r.text).toMatch(/may already have taken effect/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('a tool that throws leaves a `failed` row, and a retry on the same ticket is refused', async () => {
    const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'rcpt-1' }, idempotent: false });
    const { state, record } = buildState(dir, postReceipt);
    const callTool = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ content: [] });
    const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;

    const first = await executeCommitted(PROPOSAL, state, im);
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/tool execution failed/);
    expect(state.executionJournal.get('rcpt-1')?.state).toBe('failed');
    expect(record).not.toHaveBeenCalled();

    postReceipt.mockResolvedValue({ receipt: { id: 'rcpt-1' }, idempotent: true });
    const second = await executeCommitted(PROPOSAL, state, im);
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/reported failure/);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('a ticket without an id is refused before anything runs', async () => {
    const postReceipt = vi.fn().mockResolvedValue({ receipt: {}, idempotent: false });
    const { state } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();
    const r = await executeCommitted(PROPOSAL, state, im);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/carries no id/);
    expect(callTool).not.toHaveBeenCalled();
  });
});
